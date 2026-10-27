
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
      `SELECT id, customer_name, phone, address,
              total_amount, payment_method, payment_status,
              order_status, created_at
       FROM orders
       ORDER BY id DESC
       LIMIT 100`
    ).all();

    const orders = result.results || [];

    if (orders.length === 0) {
      return Response.json(
        { success: true, orders: [] },
        { headers }
      );
    }

    const ids = orders.map(order => order.id);
    const placeholders = ids.map(() => "?").join(",");

    const itemResult = await env.DB.prepare(
      `SELECT order_id, product_name, quantity, unit_price
       FROM order_items
       WHERE order_id IN (${placeholders})`
    ).bind(...ids).all();

    const items = itemResult.results || [];

    const ordersWithItems = orders.map(order => ({
      ...order,
      items: items.filter(
        item => item.order_id === order.id
      )
    }));

    return Response.json(
      { success: true, orders: ordersWithItems },
      { headers }
    );
  } catch (error) {
    console.error("Admin orders request failed:", error);

    return Response.json(
      { error: "Unable to load orders" },
      { status: 500, headers }
    );
  }
}
