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
                latitude: Number(origin.latitude),
                longitude: Number(origin.longitude)
              }
            }
          },
          destination: {
            location: {
              latLng: {
                latitude: Number(destination.latitude),
                longitude: Number(destination.longitude)
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

    return json({
      success: true,
      distanceKm: Math.round(distanceKm * 100) / 100,
      duration: data.routes[0].duration
    });

  } catch (error) {
    return json({
      success: false,
      message: "Distance calculation failed"
    }, 500);
  }
}
