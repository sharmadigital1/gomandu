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
      "SELECT * FROM riders ORDER BY id DESC"
    ).all();

    return json({ success: true, riders: result.results || [] });
  } catch (error) {
    console.error("Rider list failed:", error);
    return json({ error: "Unable to load riders" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!(await verifyAdmin(request, env))) {
    return json({ error: "Admin access required" }, 403);
  }

  try {
    const data = await request.json();
    const name = String(data.name || "").trim();
    const phone = String(data.phone || "").trim();
    const email = String(data.email || "").trim();
    const status = data.status === "inactive" ? "inactive" : "active";

    if (!name || !phone) {
      return json({ error: "Name and phone are required" }, 400);
    }

    const result = await env.DB.prepare(`
      INSERT INTO riders (name, phone, email, status)
      VALUES (?, ?, ?, ?)
    `).bind(name, phone, email, status).run();

    return json({ success: true, id: result.meta.last_row_id });
  } catch (error) {
    console.error("Rider creation failed:", error);
    return json({ error: "Unable to add rider" }, 500);
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
    const phone = String(data.phone || "").trim();

    if (!Number.isInteger(id) || id < 1 || !name || !phone) {
      return json({ error: "Valid rider details are required" }, 400);
    }

    await env.DB.prepare(`
      UPDATE riders
      SET name = ?, phone = ?, email = ?, status = ?
      WHERE id = ?
    `).bind(
      name,
      phone,
      String(data.email || "").trim(),
      data.status === "inactive" ? "inactive" : "active",
      id
    ).run();

    return json({ success: true });
  } catch (error) {
    console.error("Rider update failed:", error);
    return json({ error: "Unable to update rider" }, 500);
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
      return json({ error: "Valid rider ID is required" }, 400);
    }

    await env.DB.prepare(
      "DELETE FROM riders WHERE id = ?"
    ).bind(id).run();

    return json({ success: true });
  } catch (error) {
    console.error("Rider deletion failed:", error);
    return json({ error: "Unable to delete rider" }, 500);
  }
}
