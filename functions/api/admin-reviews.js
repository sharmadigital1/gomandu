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

export async function onRequestGet({ request, env }) {
  const headers = { "Cache-Control": "no-store" };

  if (!env.DB) {
    return Response.json(
      { error: "Database is not connected" },
      { status: 500, headers }
    );
  }

  try {
    const cookie = request.headers.get("Cookie") || "";
    const match = cookie.match(
      /(?:^|;\s*)gm_session=([a-f0-9]{64})(?:;|$)/
    );

    if (!match) {
      return Response.json(
        { error: "Please log in" },
        { status: 401, headers }
      );
    }

    const tokenHash = await sha256Hex(match[1]);

    const session = await env.DB.prepare(
      `SELECT c.id, c.is_admin
       FROM customer_sessions s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.token_hash = ?
         AND s.expires_at > datetime('now')`
    ).bind(tokenHash).first();

    if (!session) {
      return Response.json(
        { error: "Invalid or expired session" },
        { status: 401, headers }
      );
    }

    if (Number(session.is_admin) !== 1) {
      return Response.json(
        { error: "Admin access required" },
        { status: 403, headers }
      );
    }

    const result = await env.DB.prepare(
      `SELECT id, order_id, customer_name, restaurant_name,
              food_rating, delivery_rating, comment, created_at
       FROM reviews
       ORDER BY id DESC
       LIMIT 200`
    ).all();

    return Response.json(
      { success: true, reviews: result.results || [] },
      { headers }
    );
  } catch (error) {
    console.error("Admin reviews request failed:", error);

    return Response.json(
      { error: "Unable to load reviews" },
      { status: 500, headers }
    );
  }
}
