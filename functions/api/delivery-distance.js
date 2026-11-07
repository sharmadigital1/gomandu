const ALLOWED_ORIGIN = "https://go-mandu.com";

function corsHeaders(request) {
  // Same-origin requests need no CORS header. Only the production site is
  // allowed when a browser sends an Origin header.
  const origin = request.headers.get("Origin");
  return origin === ALLOWED_ORIGIN
    ? {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        Vary: "Origin"
      }
    : {};
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request) }
  });
}

function calculateDeliveryCharge(distanceKm) {
  if (distanceKm <= 1) return 20;
  if (distanceKm <= 2) return 30;
  if (distanceKm <= 4) return 40;
  if (distanceKm <= 10) return 50;
  return 50 + Math.ceil(distanceKm - 10) * 20;
}

function coordinates(location) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function onRequestPost({ request, env }) {
  if (!env.GOOGLE_MAPS_API_KEY) {
    return json(request, { success: false, message: "Delivery service is not configured." }, 503);
  }

  try {
    const body = await request.json();
    const origin = coordinates(body.origin);
    const destination = coordinates(body.destination);
    if (!origin || !destination) {
      return json(request, { success: false, message: "Invalid restaurant or delivery coordinates." }, 400);
    }

    const routeResponse = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration"
      },
      body: JSON.stringify({
        origin: { location: { latLng: origin } },
        destination: { location: { latLng: destination } },
        travelMode: "DRIVE"
      })
    });
    const data = await routeResponse.json().catch(() => ({}));
    const meters = Number(data.routes?.[0]?.distanceMeters);
    if (!routeResponse.ok || !Number.isFinite(meters) || meters < 0) {
      return json(request, { success: false, message: "Unable to calculate delivery distance." }, 422);
    }

    const distanceKm = meters / 1000;
    return json(request, {
      success: true,
      distanceKm: Math.round(distanceKm * 100) / 100,
      deliveryCharge: calculateDeliveryCharge(distanceKm),
      currency: "NPR",
      duration: data.routes[0].duration || ""
    });
  } catch (error) {
    console.error("Delivery calculation failed", error);
    return json(request, { success: false, message: "Delivery calculation failed. Please try again." }, 500);
  }
}
