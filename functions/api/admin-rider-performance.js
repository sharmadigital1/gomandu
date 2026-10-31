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

    const session = await env.DB.prepare(`
      SELECT c.id, c.is_admin
      FROM customer_sessions s
      JOIN customers c ON c.id = s.customer_id
      WHERE s.token_hash = ?
        AND s.expires_at > datetime('now')
    `).bind(tokenHash).first();

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

    const result = await env.DB.prepare(`
      SELECT
  delivery_person_name AS rider_name,
  delivery_person_phone AS rider_phone,
  COUNT(*) AS total_assigned,

  SUM(CASE WHEN order_status = 'delivered' THEN 1 ELSE 0 END) AS delivered,

  SUM(CASE WHEN order_status = 'out_for_delivery' THEN 1 ELSE 0 END) AS out_for_delivery,

  SUM(CASE WHEN order_status = 'accepted' THEN 1 ELSE 0 END) AS accepted,

  SUM(CASE WHEN order_status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,

  SUM(CASE
    WHEN order_status IN ('accepted', 'out_for_delivery')
    THEN 1 ELSE 0
  END) AS pending_orders,

  ROUND(
    100.0 * SUM(CASE WHEN order_status = 'delivered' THEN 1 ELSE 0 END)
    / NULLIF(COUNT(*), 0),
    1
  ) AS completion_rate,

  SUM(CASE
    WHEN order_status = 'delivered'
      AND date(delivered_at, '+05:45') = date('now', '+05:45')
    THEN 1 ELSE 0
  END) AS today_delivered,

  CASE
    WHEN SUM(CASE
      WHEN order_status = 'delivered'
        AND date(delivered_at, '+05:45') = date('now', '+05:45')
      THEN 1 ELSE 0
    END) >= 7
    THEN
      SUM(CASE
        WHEN order_status = 'delivered'
          AND date(delivered_at, '+05:45') = date('now', '+05:45')
        THEN 1 ELSE 0
      END) * 60
    ELSE
      SUM(CASE
        WHEN order_status = 'delivered'
          AND date(delivered_at, '+05:45') = date('now', '+05:45')
        THEN 1 ELSE 0
      END) * 40
  END AS today_earnings
    ,

  SUM(CASE
    WHEN order_status = 'delivered'
      AND strftime('%Y-%m', delivered_at, '+05:45') =
          strftime('%Y-%m', 'now', '+05:45')
    THEN 1 ELSE 0
  END) AS monthly_delivered,

  SUM(CASE
    WHEN order_status = 'delivered'
      AND strftime('%Y-%m', delivered_at, '+05:45') =
          strftime('%Y-%m', 'now', '+05:45')
    THEN
      CASE
        WHEN (
          SELECT COUNT(*)
          FROM orders daily
          WHERE daily.delivery_person_name = orders.delivery_person_name
            AND daily.delivery_person_phone = orders.delivery_person_phone
            AND daily.order_status = 'delivered'
            AND date(daily.delivered_at, '+05:45') =
                date(orders.delivered_at, '+05:45')
        ) >= 7
        THEN 60
        ELSE 40
      END
    ELSE 0
  END) AS monthly_earnings

FROM orders
WHERE delivery_person_name IS NOT NULL
  AND TRIM(delivery_person_name) != ''
GROUP BY delivery_person_name, delivery_person_phone
ORDER BY total_assigned DESC
    `).all();

    return Response.json(
      {
        success: true,
        performance: result.results || []
      },
      { headers }
    );

  } catch (error) {
    console.error("Rider performance failed:", error);

    return Response.json(
      { error: "Unable to load rider performance" },
      { status: 500, headers }
    );
  }
}
