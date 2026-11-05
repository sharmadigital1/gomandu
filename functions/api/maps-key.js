export async function onRequestGet({ env }) {
  const key = env.GOOGLE_MAPS_BROWSER_KEY;

  if (!key) {
    return new Response(
      JSON.stringify({ success: false, message: "Maps key missing" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  return new Response(
    JSON.stringify({ success: true, key }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "https://go-mandu.com"
      }
    }
  );
}
