
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function requireAdmin(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    /(?:^|;\s*)gm_session=([a-f0-9]{64})(?:;|$)/
  );

  if (!match || !env.DB) return null;

  const tokenHash = await sha256Hex(match[1]);

  const customer = await env.DB.prepare(`
    SELECT c.id, c.is_admin
    FROM customer_sessions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.token_hash = ?
      AND s.expires_at > datetime('now')
    LIMIT 1
  `).bind(tokenHash).first();

  return customer && Number(customer.is_admin) === 1
    ? customer
    : null;
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "Database unavailable" }, 500);

  const admin = await requireAdmin(request, env);
  if (!admin) {
    return json({ error: "Admin access required" }, 403);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT id, name, photo_url, active, created_at, updated_at
      FROM restaurants
      ORDER BY id DESC
    `).all();

    return json({ restaurants: result.results || [] });
  } catch (error) {
    console.error("Admin restaurants GET failed:", error);
    return json({ error: "Unable to load restaurants" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "Database unavailable" }, 500);

  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: "Invalid request origin" }, 403);
  }

  const admin = await requireAdmin(request, env);
  if (!admin) {
    return json({ error: "Admin access required" }, 403);
  }

  try {
    const body = await request.json();
    const name = String(body.name || "").trim();
    const photoUrl = String(body.photo_url || "").trim();
    const active = Number(body.active);
    const id = Number(body.id || 0);

    if (name.length < 2 || name.length > 100) {
      return json({ error: "Restaurant name must be 2–100 characters" }, 400);
    }

    if (
      photoUrl.length > 1000 ||
      (photoUrl && !/^https:\/\/\S+$/i.test(photoUrl))
    ) {
      return json({ error: "Photo URL must be a valid HTTPS URL" }, 400);
    }

    if (![0, 1].includes(active)) {
      return json({ error: "Active must be 0 or 1" }, 400);
    }

    if (id) {
      if (!Number.isSafeInteger(id) || id < 1) {
        return json({ error: "Invalid restaurant ID" }, 400);
      }

      const result = await env.DB.prepare(`
        UPDATE restaurants
        SET name = ?, photo_url = ?, active = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(name, photoUrl, active, id).run();

      if (!result.meta?.changes) {
        return json({ error: "Restaurant not found" }, 404);
      }

      return json({ success: true, id });
    }

    const result = await env.DB.prepare(`
      INSERT INTO restaurants (name, photo_url, active)
      VALUES (?, ?, ?)
    `).bind(name, photoUrl, active).run();

    return json({
      success: true,
      id: result.meta?.last_row_id
    }, 201);
  } catch (error) {
    console.error("Admin restaurants POST failed:", error);
    return json({ error: "Unable to save restaurant" }, 500);
  }
}
