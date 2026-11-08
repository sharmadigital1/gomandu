const json = (data, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

async function getSessionCustomer(request, env) {
  const match = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)gm_session=([a-f0-9]{64})(?:;|$)/);
  if (!match || !env.DB) return null;
  return env.DB.prepare(
    `SELECT c.id FROM customer_sessions s
     JOIN customers c ON c.id = s.customer_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now') LIMIT 1`
  ).bind(await sha256Hex(match[1])).first();
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "Database is not connected" }, 500);

  // Only logged-in customers can use this (protects your Google quota).
  const customer = await getSessionCustomer(request, env);
  if (!customer) return json({ error: "Please log in" }, 401);

  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: "Address lookup is not configured" }, 503);

  try {
    const body = await request.json();
    const lat = Number(body.latitude), lng = Number(body.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return json({ error: "Invalid location" }, 400);
    }

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng", `${lat},${lng}`);
    url.searchParams.set("language", "en");
    url.searchParams.set("result_type", "street_address|route|sublocality|neighborhood|locality");
    url.searchParams.set("key", env.GOOGLE_MAPS_API_KEY);

    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));

    if (data.status !== "OK") {
      if (data.status && data.status !== "ZERO_RESULTS") {
        console.error("Geocoding failed:", data.status, data.error_message || "");
      }
      return json({ success: true, address: "" });
    }

    // Remove a leading Google "plus code" (e.g. "8MRX+4Q ") if present.
    const address = String(data.results?.[0]?.formatted_address || "")
      .replace(/^[A-Z0-9]{4,8}\+[A-Z0-9]{2,3}\s*,?\s*/i, "")
      .slice(0, 300);

    return json({ success: true, address });
  } catch (error) {
    console.error("Reverse geocode failed:", error);
    return json({ error: "Unable to look up address." }, 500);
  }
}
