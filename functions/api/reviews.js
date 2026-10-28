async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

async function getSessionCustomer(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)gm_session=([a-f0-9]{64})(?:;|$)/);
  if (!match || !env.DB) return null;
  const tokenHash = await sha256Hex(match[1]);
  return await env.DB.prepare(`
    SELECT c.id, c.name, c.email
    FROM customer_sessions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.token_hash = ?
      AND s.expires_at > datetime('now')
    LIMIT 1
  `).bind(tokenHash).first();
}

const noStore = { "Cache-Control": "no-store" };

// GET /api/reviews  -> the logged-in customer's own reviews
export async function onRequestGet({ request, env }) {
  try {
    const customer = await getSessionCustomer(request, env);
    if (!customer) {
      return Response.json({ error: "Please log in" }, { status: 401, headers: noStore });
    }
    const result = await env.DB.prepare(`
      SELECT id, order_id, restaurant_id, restaurant_name,
             food_rating, delivery_rating, comment, created_at
      FROM reviews
      WHERE customer_id = ?
      ORDER BY id DESC
      LIMIT 100
    `).bind(String(customer.id)).all();
    return Response.json({ reviews: result.results || [] }, { headers: noStore });
  } catch (error) {
    console.error("Reviews load failed:", error);
    return Response.json({ error: "Unable to load reviews" }, { status: 500, headers: noStore });
  }
}

// POST /api/reviews -> only for the customer's own DELIVERED order, one review per order
export async function onRequestPost({ request, env }) {
  try {
    const customer = await getSessionCustomer(request, env);
    if (!customer) {
      return Response.json({ error: "Please log in to leave a review" }, { status: 401 });
    }

    const body = await request.json();
    const orderId = Number(body.order_id);
    const food = Number(body.food_rating);
    const delivery = Number(body.delivery_rating);
    const comment = String(body.comment || "").trim().slice(0, 500);
    const restaurantId = String(body.restaurant_id || "").trim();
    const restaurantName = String(body.restaurant_name || "").trim().slice(0, 100);

    if (
      !Number.isSafeInteger(orderId) || orderId < 1 ||
      !Number.isInteger(food) || food < 1 || food > 5 ||
      !Number.isInteger(delivery) || delivery < 1 || delivery > 5 ||
      (restaurantId && !/^[a-z0-9-]{1,50}$/.test(restaurantId))
    ) {
      return Response.json({ error: "Please check your review" }, { status: 400 });
    }

    const order = await env.DB.prepare(
      "SELECT id, order_status FROM orders WHERE id = ? AND customer_id = ?"
    ).bind(orderId, String(customer.id)).first();

    if (!order) {
      return Response.json({ error: "Order not found" }, { status: 404 });
    }
    if (order.order_status !== "delivered") {
      return Response.json(
        { error: "You can review an order only after it is delivered" },
        { status: 403 }
      );
    }

    try {
      await env.DB.prepare(`
        INSERT INTO reviews
        (order_id, customer_id, customer_name, restaurant_id, restaurant_name,
         food_rating, delivery_rating, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).bind(
        orderId, String(customer.id), String(customer.name || "Customer").slice(0, 100),
        restaurantId || null, restaurantName || null, food, delivery, comment || null
      ).run();
    } catch (error) {
      if (String(error && error.message).includes("UNIQUE")) {
        return Response.json({ error: "This order was already reviewed" }, { status: 409 });
      }
      throw error;
    }

    return Response.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error("Review creation failed:", error);
    return Response.json({ error: "Unable to save review. Please try again." }, { status: 500 });
  }
}
