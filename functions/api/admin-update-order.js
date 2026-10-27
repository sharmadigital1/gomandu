
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
    // Reject cross-origin requests when Origin is provided.
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

    if (!request.headers.get("Content-Type")?.includes("application/json")) {
      return Response.json(
        { error: "JSON request required" },
        { status: 415, headers }
      );
    }

    const body = await request.json();
    const orderId = Number(body.order_id);
    const status = String(body.order_status || "");

    const allowedStatuses = [
      "new",
      "accepted",
      "preparing",
      "out_for_delivery",
      "delivered",
      "cancelled"
    ];

    if (
      !Number.isSafeInteger(orderId) ||
      orderId < 1 ||
      !allowedStatuses.includes(status)
    ) {
      return Response.json(
        { error: "Invalid order ID or status" },
        { status: 400, headers }
      );
    }

    const result = await env.DB.prepare(
      `UPDATE orders
       SET order_status = ?
       WHERE id = ?`
    ).bind(status, orderId).run();

    if (!result.meta?.changes) {
      return Response.json(
        { error: "Order not found" },
        { status: 404, headers }
      );
    }

    return Response.json(
      { success: true, order_id: orderId, order_status: status },
      { headers }
    );
  } catch (error) {
    console.error("Admin order update failed:", error);

    return Response.json(
      { error: "Unable to update order status" },
      { status: 500, headers }
    );
  }
}
