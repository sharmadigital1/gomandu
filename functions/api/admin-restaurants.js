
const PROJECT_ID = "gomandu-7026e";
const ADMIN_ORIGIN = "https://admin.go-mandu.com";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": ADMIN_ORIGIN,
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Vary": "Origin"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);

  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function verifyFirebaseToken(token) {
  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error("Invalid token");
  }

  const header = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(parts[0]))
  );

  const payload = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(parts[1]))
  );

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Invalid token header");
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    payload.aud !== PROJECT_ID ||
    payload.iss !== `https://securetoken.google.com/${PROJECT_ID}` ||
    !payload.sub ||
    payload.exp <= now ||
    payload.iat > now + 60
  ) {
    throw new Error("Invalid token claims");
  }

  const response = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  );

  if (!response.ok) {
    throw new Error("Unable to load signing keys");
  }

  const jwks = await response.json();
  const jwk = jwks.keys.find(key => key.kid === header.kid);

  if (!jwk) {
    throw new Error("Signing key not found");
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );

  if (!valid) {
    throw new Error("Invalid token signature");
  }

  return payload;
}

async function verifyAdmin(uid, token) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
    `/databases/(default)/documents/admins/${encodeURIComponent(uid)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    return false;
  }

  const document = await response.json();

  return document.fields?.role?.stringValue === "admin";
}

async function authenticateAdmin(request) {
  if (request.headers.get("Origin") !== ADMIN_ORIGIN) {
    return {
      success: false,
      status: 403,
      message: "Origin not allowed"
    };
  }

  const authHeader = request.headers.get("Authorization") || "";

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!token) {
    return {
      success: false,
      status: 401,
      message: "Login required"
    };
  }

  try {
    const firebaseUser = await verifyFirebaseToken(token);

    const isAdmin = await verifyAdmin(firebaseUser.sub, token);

    if (!isAdmin) {
      return {
        success: false,
        status: 403,
        message: "Admin access denied"
      };
    }

    return {
      success: true
    };

  } catch (error) {
    return {
      success: false,
      status: 401,
      message: "Authentication failed"
    };
  }
}

function getRestaurantData(data) {
  return {
    name: String(data.name || "").trim(),
    photo_url: String(data.photo_url || "").trim(),
    phone: String(data.phone || "").trim(),
    address: String(data.address || "").trim(),
    latitude: Number(data.latitude),
    longitude: Number(data.longitude),
    cuisine: String(data.cuisine || "").trim(),
    featured: data.featured === 1 || data.featured === true ? 1 : 0,
    active: data.active === 0 || data.active === false ? 0 : 1
  };
}

function validRestaurant(data) {
  return data.name.length >= 2 && data.name.length <= 100 &&
    Number.isFinite(data.latitude) && Number.isFinite(data.longitude) &&
    Math.abs(data.latitude) <= 90 && Math.abs(data.longitude) <= 180;
}

export async function onRequestOptions() {
  return new Response("OK", {
    status: 200,
    headers
  });
}

// GET: Load restaurants
export async function onRequestGet({ request, env }) {
  const auth = await authenticateAdmin(request);

  if (!auth.success) {
    return json({
      success: false,
      message: auth.message
    }, auth.status);
  }

  if (!env.DB) {
    return json({
      success: false,
      message: "Database unavailable"
    }, 500);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT *
      FROM restaurants
      ORDER BY id DESC
    `).all();

    return json({
      success: true,
      restaurants: result.results || []
    });

  } catch (error) {
    return json({
      success: false,
      message: "Could not load restaurants"
    }, 500);
  }
}

// POST: Add a new restaurant or update an existing one
export async function onRequestPost({ request, env }) {
  const auth = await authenticateAdmin(request);

  if (!auth.success) {
    return json({
      success: false,
      message: auth.message
    }, auth.status);
  }

  if (!env.DB) {
    return json({
      success: false,
      message: "Database unavailable"
    }, 500);
  }

  try {
    const body = await request.json();
    const data = getRestaurantData(body);

    if (!validRestaurant(data)) {
      return json({
        success: false,
        message: "Restaurant name must be 2–100 characters"
      }, 400);
    }

    const id = Number(body.id);

    if (body.id !== undefined && body.id !== null && body.id !== "") {
      if (!Number.isSafeInteger(id) || id < 1) {
        return json({
          success: false,
          message: "Valid restaurant ID is required"
        }, 400);
      }

      const result = await env.DB.prepare(`
        UPDATE restaurants
        SET name = ?,
            photo_url = ?,
            phone = ?,
            address = ?,
            latitude = ?,
            longitude = ?,
            cuisine = ?,
            featured = ?,
            active = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        data.name,
        data.photo_url,
        data.phone,
        data.address,
        data.latitude,
        data.longitude,
        data.cuisine,
        data.featured,
        data.active,
        id
      ).run();

      if (!result.meta || result.meta.changes === 0) {
        return json({
          success: false,
          message: "Restaurant not found"
        }, 404);
      }

      return json({
        success: true,
        message: "Restaurant updated successfully",
        id
      });
    }

    const result = await env.DB.prepare(`
      INSERT INTO restaurants
        (name, photo_url, phone, address, latitude, longitude, cuisine, featured, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.name,
      data.photo_url,
      data.phone,
      data.address,
      data.latitude,
      data.longitude,
      data.cuisine,
      data.featured,
      data.active
    ).run();

    return json({
      success: true,
      message: "Restaurant added successfully",
      id: result.meta.last_row_id
    });

  } catch (error) {
    return json({
      success: false,
      message: "Could not save restaurant"
    }, 500);
  }
}

// PATCH: Update a restaurant
export async function onRequestPatch({ request, env }) {
  const auth = await authenticateAdmin(request);

  if (!auth.success) {
    return json({
      success: false,
      message: auth.message
    }, auth.status);
  }

  if (!env.DB) {
    return json({
      success: false,
      message: "Database unavailable"
    }, 500);
  }

  try {
    const body = await request.json();
    const id = Number(body.id);
    const data = getRestaurantData(body);

    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !validRestaurant(data)
    ) {
      return json({
        success: false,
        message: "Valid restaurant details are required"
      }, 400);
    }

    const result = await env.DB.prepare(`
      UPDATE restaurants
      SET name = ?,
          photo_url = ?,
          phone = ?,
          address = ?,
          latitude = ?,
          longitude = ?,
          cuisine = ?,
          featured = ?,
          active = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      data.name,
      data.photo_url,
      data.phone,
      data.address,
        data.latitude,
        data.longitude,
      data.cuisine,
      data.featured,
      data.active,
      id
    ).run();

    if (!result.meta || result.meta.changes === 0) {
      return json({
        success: false,
        message: "Restaurant not found"
      }, 404);
    }

    return json({
      success: true,
      message: "Restaurant updated successfully"
    });

  } catch (error) {
    return json({
      success: false,
      message: "Could not update restaurant"
    }, 500);
  }
}

// DELETE: Delete a restaurant
export async function onRequestDelete({ request, env }) {
  const auth = await authenticateAdmin(request);

  if (!auth.success) {
    return json({
      success: false,
      message: auth.message
    }, auth.status);
  }

  if (!env.DB) {
    return json({
      success: false,
      message: "Database unavailable"
    }, 500);
  }

  try {
    const body = await request.json();
    const id = Number(body.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return json({
        success: false,
        message: "Valid restaurant ID is required"
      }, 400);
    }

    const result = await env.DB.prepare(`
      DELETE FROM restaurants
      WHERE id = ?
    `).bind(id).run();

    if (!result.meta || result.meta.changes === 0) {
      return json({
        success: false,
        message: "Restaurant not found"
      }, 404);
    }

    return json({
      success: true,
      message: "Restaurant deleted successfully"
    });

  } catch (error) {
    return json({
      success: false,
      message: "Could not delete restaurant"
    }, 500);
  }
}
