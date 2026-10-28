
export async function onRequestGet({ env }) {
  if (!env.DB) {
    return Response.json(
      { error: "Database binding DB is missing" },
      { status: 500 }
    );
  }

  try {
    const result = await env.DB.prepare(`
      SELECT id, name, photo_url
      FROM restaurants
      WHERE active = 1
      ORDER BY id
    `).all();

    return Response.json(
      { restaurants: result.results || [] },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Restaurants load failed:", error);

    return Response.json(
      { error: "Unable to load restaurants" },
      { status: 500 }
    );
  }
}
