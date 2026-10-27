
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

async function getSessionCustomer(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    /(?:^|;\s*)gm_session=([a-f0-9]{64})(?:;|$)/
  );

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

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return Response.json(
      { error: "Database is not connected" },
      { status: 500 }
    );
  }

const customer = await getSessionCustomer(request, env);

if (!customer) {
  return Response.json(
    { error: "Please log in to place an order" },
    { status: 401 }
  );
}

  try {
    const body = await request.json();

    const customerName = String(body.customer_name || "").trim();
    const phone = String(body.phone || "").trim();
    const address = String(body.address || "").trim();
    const items = body.items;

    if (
      customerName.length < 2 ||
      customerName.length > 100 ||
      !/^[0-9+\-\s()]{7,20}$/.test(phone) ||
      address.length < 5 ||
      address.length > 500 ||
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > 32
    ) {
      return Response.json(
        { error: "Please check your order details" },
        { status: 400 }
      );
    }

    const quantities = new Map();

    for (const item of items) {
      const menuKey = String(item.menu_key || "");
      const qty = Number(item.quantity);

      if (
        !/^[a-z0-9-]+:[a-z0-9-]+$/.test(menuKey) ||
        !Number.isSafeInteger(qty) ||
        qty < 1 ||
        qty > 20
      ) {
        return Response.json(
          { error: "Invalid product or quantity" },
          { status: 400 }
        );
      }

      quantities.set(
        menuKey,
        (quantities.get(menuKey) || 0) + qty
      );
    }

    for (const qty of quantities.values()) {
      if (qty > 20) {
        return Response.json(
          { error: "Maximum quantity is 20 per product" },
          { status: 400 }
        );
      }
    }

    const menuKeys = [...quantities.keys()];
    const placeholders = menuKeys.map(() => "?").join(",");

    const result = await env.DB.prepare(
      `SELECT menu_key, name, price_npr
       FROM products
       WHERE active = 1
         AND menu_key IN (${placeholders})`
    ).bind(...menuKeys).all();

    const products = result.results || [];

    if (
      products.length !== menuKeys.length ||
      products.some(p =>
        !Number.isSafeInteger(Number(p.price_npr)) ||
        Number(p.price_npr) < 0
      )
    ) {
      return Response.json(
        {
          error:
            "A menu item is unavailable. Please refresh your cart."
        },
        { status: 400 }
      );
    }

    const orderItems = products.map(product => ({
      name: product.name,
      quantity: quantities.get(product.menu_key),
      price: Number(product.price_npr)
    }));

    const total = orderItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    const orderResult = await env.DB.prepare(
      
const orderResult = await env.DB.prepare(
  `INSERT INTO orders
   (customer_name, phone, address, total_amount, customer_id,
    payment_method, payment_status, order_status, created_at)
   VALUES (?, ?, ?, ?, ?, 'cod', 'pending', 'new', datetime('now'))`
).bind(
  customerName,
  phone,
  address,
  total,
  String(customer.id)
).run();

    ).bind(
      customerName,
      phone,
      address,
      total
    ).run();

    const orderId = orderResult.meta?.last_row_id;

    if (!orderId) {
      throw new Error("Order ID was not returned");
    }

    const statements = orderItems.map(item =>
      env.DB.prepare(
        `INSERT INTO order_items
         (order_id, product_name, quantity, unit_price)
         VALUES (?, ?, ?, ?)`
      ).bind(
        orderId,
        item.name,
        item.quantity,
        item.price
      )
    );

    await env.DB.batch(statements);

    return Response.json(
      {
        success: true,
        order_id: orderId,
        currency: "NPR",
        total_amount: total,
        message: "Order placed successfully"
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Order creation failed:", error);

    return Response.json(
      { error: "Unable to place order. Please try again." },
      { status: 500 }
    );
  }
}

export async function onRequestGet({ request, env }) {
  try {
    const customer = await getSessionCustomer(request, env);

    if (!customer) {
      return Response.json(
        { error: "Please log in to view your orders" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }

    const result = await env.DB.prepare(`
      SELECT id, total_amount, order_status, created_at
      FROM orders
      WHERE customer_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).bind(String(customer.id)).all();

    const orders = result.results || [];

    for (const order of orders) {
      const itemResult = await env.DB.prepare(`
        SELECT product_name AS name, quantity, unit_price
        FROM order_items
        WHERE order_id = ?
      `).bind(order.id).all();

      order.items = (itemResult.results || []).map(item => ({
        name: item.name,
        quantity: item.quantity,
        price: item.unit_price
      }));

      order.status = order.order_status;
    }

    return Response.json(
      { orders },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Order history failed:", error);

    return Response.json(
      { error: "Unable to load order history" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
