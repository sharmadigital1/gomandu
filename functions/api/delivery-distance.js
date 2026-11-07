
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://go-mandu.com",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    }
  });

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "https://go-mandu.com",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    }
  });
}

function calculateDeliveryCharge(distanceKm) {
  if (distanceKm <= 1) return 20;
  if (distanceKm <= 2) return 30;
  if (distanceKm <= 4) return 40;
  if (distanceKm <= 10) return 50;

  // 10 km भन्दा बढीमा प्रत्येक सुरु भएको थप km को NPR 20
  return 50 + Math.ceil(distanceKm - 10) * 20;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.GOOGLE_MAPS_API_KEY) {
      return json({
        success: false,
        message: "Google Maps API key missing"
      }, 500);
    }

    const body = await request.json();
    const origin = body.origin;
    const destination = body.destination;

    if (!origin || !destination) {
      return json({
        success: false,
        message: "Restaurant and customer locations are required"
      }, 400);
    }

    const coordinates = [
      origin.latitude,
      origin.longitude,
      destination.latitude,
      destination.longitude
    ].map(Number);

    const [olat, olng, dlat, dlng] = coordinates;

    if (
      !coordinates.every(Number.isFinite) ||
      Math.abs(olat) > 90 ||
      Math.abs(dlat) > 90 ||
      Math.abs(olng) > 180 ||
      Math.abs(dlng) > 180
    ) {
      return json({
        success: false,
        message: "Invalid location coordinates"
      }, 400);
    }

    const response = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": "routes.distanceMeters,routes.duration"
        },
        body: JSON.stringify({
          origin: {
            location: {
              latLng: {
                latitude: olat,
                longitude: olng
              }
            }
          },
          destination: {
            location: {
              latLng: {
                latitude: dlat,
                longitude: dlng
              }
            }
          },
          travelMode: "DRIVE"
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.routes?.length) {
      return json({
        success: false,
        message: "Unable to calculate delivery distance"
      }, 400);
    }

    const distanceKm = data.routes[0].distanceMeters / 1000;
    const roundedDistance = Math.round(distanceKm * 100) / 100;
    const deliveryCharge = calculateDeliveryCharge(distanceKm);

    return json({
      success: true,
      distanceKm: roundedDistance,
      deliveryCharge,
      currency: "NPR",
      duration: data.routes[0].duration
    });

  } catch (error) {
    return json({
      success: false,
      message: "Distance calculation failed"
    }, 500);
  }
}
