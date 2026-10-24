
export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return Response.json(
      { error: "Database is not connected" },
      { status: 500 }
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
      items.length > 30
    ) {
      return Response.json(
        { error: "Please check your order details" },
        { status: 400 }
      );
    }

    const quantities = new Map();

    for (const item of items) {
      const id = Number(item.id);
      const qty = Number(item.quantity);

      if (
        !Number.isSafeInteger(id) ||
        id < 1 ||
        !Number.isSafeInteger(qty) ||
        qty < 1 ||
        qty > 20
      ) {
        return Response.json(
          { error: "Invalid product or quantity" },
          { status: 400 }
        );
      }

      quantities.set(id, (quantities.get(id) || 0) + qty);
    }

    for (const qty of quantities.values()) {
      if (qty > 20) {
        return Response.json(
          { error: "Maximum quantity is 20 per product" },
          { status: 400 }
        );
      }
    }

    const ids = [...quantities.keys()];
    const placeholders = ids.map(() => "?").join(",");

    const result = await env.DB.prepare(
      `SELECT id, name, price_paisa
       FROM products
       WHERE active = 1 AND id IN (${placeholders})`
    ).bind(...ids).all();

    const products = result.results || [];

    if (products.length !== ids.length) {
      return Response.json(
        { error: "A product is unavailable. Please refresh your cart." },
        { status: 400 }
      );
    }

    const orderItems = products.map(product => ({
      name: product.name,
      quantity: quantities.get(Number(product.id)),
      price: Number(product.price_paisa) / 100
    }));

    const total = orderItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    const orderResult = await env.DB.prepare(
      `INSERT INTO orders
       (customer_name, phone, address, total_amount,
        payment_method, payment_status, order_status, created_at)
       VALUES (?, ?, ?, ?, 'cod', 'pending', 'new', datetime('now'))`
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
