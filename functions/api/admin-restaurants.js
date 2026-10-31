
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(
    new Uint8Array(digest),
    b => b.toString(16).padStart(2, "0")
  ).join("");
}

async function verifyAdmin(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    /(?:^|;\s*)gm_session=([a-f0-9]{64})(?:;|$)/
  );

  if (!match || !env.DB) return false;

  const tokenHash = await sha256Hex(match[1]);

  const session = await env.DB.prepare(`
    SELECT c.id, c.is_admin
    FROM customer_sessions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.token_hash = ?
      AND s.expires_at > datetime('now')
  `).bind(tokenHash).first();

  return !!session && Number(session.is_admin) === 1;
}

const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });

export async function onRequestGet({ request, env }) {
  if (!(await verifyAdmin(request, env))) {
    return json({ error: "Admin access required" }, 403);
  }

  try {
    const result = await env.DB.prepare(
      "SELECT * FROM restaurants ORDER BY id DESC"
    ).all();

    return json({
      success: true,
      restaurants: result.results || []
    });
  } catch (error) {
    console.error("Restaurant list failed:", error);
    return json({ error: "Unable to load restaurants" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!(await verifyAdmin(request, env))) {
    return json({ error: "Admin access required" }, 403);
  }

  try {
    const data = await request.json();

    const name = String(data.name || "").trim();
    const photoUrl = String(data.photo_url || "").trim();
    const phone = String(data.phone || "").trim();
    const address = String(data.address || "").trim();
    const active = data.active === 0 ? 0 : 1;

    if (!name) {
      return json({ error: "Restaurant name is required" }, 400);
    }

    const result = await env.DB.prepare(`
      INSERT INTO restaurants
        (name, photo_url, phone, address, active)
      VALUES (?, ?, ?, ?, ?)
    `).bind(name, photoUrl, phone, address, active).run();

    return json({
      success: true,
      id: result.meta.last_row_id
    });
  } catch (error) {
    console.error("Restaurant creation failed:", error);
    return json({ error: "Unable to add restaurant" }, 500);
  }
}

export async function onRequestPatch({ request, env }) {
  if (!(await verifyAdmin(request, env))) {
    return json({ error: "Admin access required" }, 403);
  }

  try {
    const data = await request.json();

    const id = Number(data.id);
    const name = String(data.name || "").trim();

    if (!Number.isInteger(id) || id < 1 || !name) {
      return json({ error: "Valid restaurant details are required" }, 400);
    }

    await env.DB.prepare(`
      UPDATE restaurants
      SET
        name = ?,
        photo_url = ?,
        phone = ?,
        address = ?,
        active = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      name,
      String(data.photo_url || "").trim(),
      String(data.phone || "").trim(),
      String(data.address || "").trim(),
      data.active === 0 ? 0 : 1,
      id
    ).run();

    return json({ success: true });
  } catch (error) {
    console.error("Restaurant update failed:", error);
    return json({ error: "Unable to update restaurant" }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  if (!(await verifyAdmin(request, env))) {
    return json({ error: "Admin access required" }, 403);
  }

  try {
    const data = await request.json();
    const id = Number(data.id);

    if (!Number.isInteger(id) || id < 1) {
      return json({ error: "Valid restaurant ID is required" }, 400);
    }

    await env.DB.prepare(
      "DELETE FROM restaurants WHERE id = ?"
    ).bind(id).run();

    return json({ success: true });
  } catch (error) {
    console.error("Restaurant deletion failed:", error);
    return json({ error: "Unable to delete restaurant" }, 500);
  }
}
