
export async function onRequestGet({ env, request }) {
  if (!env.DB) {
    return Response.json(
      { error: "Database binding DB is missing" },
      { status: 500 }
    );
  }

  try {
    const url = new URL(request.url);
    const restaurantId = url.searchParams.get("restaurant_id");

    let query = `
      SELECT id, name, price_npr, menu_key, restaurant_id
      FROM products
      WHERE active = 1
    `;

    let statement;

    if (restaurantId) {
      query += " AND restaurant_id = ?";
      statement = env.DB.prepare(query + " ORDER BY id")
        .bind(Number(restaurantId));
    } else {
      statement = env.DB.prepare(query + " ORDER BY id");
    }

    const result = await statement.all();

    return Response.json(
      { products: result.results || [] },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return Response.json(
      { error: "Unable to load products" },
      { status: 500 }
    );
  }
}
