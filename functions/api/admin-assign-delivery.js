
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

export async function onRequestPost({ request, env }) {
  const headers = { "Cache-Control": "no-store" };

  if (!env.DB) {
    return Response.json(
      { error: "Database is not connected" },
      { status: 500, headers }
    );
  }

  try {
    const origin = request.headers.get("Origin");

    if (origin && origin !== new URL(request.url).origin) {
      return Response.json(
        { error: "Invalid request origin" },
        { status: 403, headers }
      );
    }

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

    if (
      !request.headers.get("Content-Type")
        ?.includes("application/json")
    ) {
      return Response.json(
        { error: "JSON request required" },
        { status: 415, headers }
      );
    }

    const body = await request.json();
    const orderId = Number(body.order_id);
    const name = String(body.delivery_person_name || "").trim();
    const phone = String(body.delivery_person_phone || "").trim();
    const notes = String(body.delivery_notes || "").trim();

    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      return Response.json(
        { error: "Invalid order ID" },
        { status: 400, headers }
      );
    }

    if (name.length > 100 || phone.length > 30 || notes.length > 500) {
      return Response.json(
        { error: "Delivery details are too long" },
        { status: 400, headers }
      );
    }

    const existing = await env.DB.prepare(
      "SELECT id FROM orders WHERE id = ?"
    ).bind(orderId).first();

    if (!existing) {
      return Response.json(
        { error: "Order not found" },
        { status: 404, headers }
      );
    }

    await env.DB.prepare(
      `UPDATE orders
       SET delivery_person_name = ?,
           delivery_person_phone = ?,
           delivery_notes = ?
       WHERE id = ?`
    ).bind(
      name || null,
      phone || null,
      notes || null,
      orderId
    ).run();

    return Response.json(
      {
        success: true,
        order_id: orderId,
        delivery_person_name: name,
        delivery_person_phone: phone,
        delivery_notes: notes
      },
      { headers }
    );
  } catch (error) {
    console.error("Delivery assignment failed:", error);

    return Response.json(
      { error: "Unable to save delivery details" },
      { status: 500, headers }
    );
  }
}
