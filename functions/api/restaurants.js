export async function onRequestGet({ env }) {
  if (!env.DB) {
    return Response.json(
      { error: "Database binding DB is missing" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const result = await env.DB.prepare(`
      SELECT id, name, photo_url, cuisine, featured, active, phone, address
      FROM restaurants
      WHERE active = 1
      ORDER BY featured DESC, id DESC
    `).all();

    return Response.json(
      { success: true, restaurants: result.results || [] },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Restaurants load failed:", error);
    return Response.json(
      { error: "Unable to load restaurants" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
