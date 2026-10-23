
export async function onRequestGet({ env }) {
  if (!env.DB) {
    return Response.json(
      { error: "Database binding DB is missing" },
      { status: 500 }
    );
  }

  try {
    const result = await env.DB.prepare(
      `SELECT id, name, price_paisa
       FROM products
       WHERE active = 1
       ORDER BY id`
    ).all();

    return Response.json(
      { products: result.results || [] },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch {
    return Response.json(
      { error: "Unable to load products" },
      { status: 500 }
    );
  }
}
