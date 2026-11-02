const PROJECT_ID = "gomandu-7026e";
const ADMIN_ORIGIN =
  "https://gomandu-admin.neerxpressbhwbranch.workers.dev";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": ADMIN_ORIGIN,
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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
  if (parts.length !== 3) throw new Error("Invalid token");

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

  if (!response.ok) throw new Error("Unable to load signing keys");

  const jwks = await response.json();
  const jwk = jwks.keys.find(key => key.kid === header.kid);

  if (!jwk) throw new Error("Signing key not found");

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

  if (!valid) throw new Error("Invalid token signature");

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

  if (!response.ok) return false;

  const document = await response.json();

  return document.fields?.role?.stringValue === "admin";
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers
  });
}

export async function onRequestGet({ request, env }) {
  try {
    if (request.headers.get("Origin") !== ADMIN_ORIGIN) {
      return json({ success: false, message: "Origin not allowed" }, 403);
    }

    if (!env.DB) {
      return json({ success: false, message: "Database unavailable" }, 500);
    }

    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    if (!token) {
      return json({ success: false, message: "Login required" }, 401);
    }

    const firebaseUser = await verifyFirebaseToken(token);

    const isAdmin = await verifyAdmin(firebaseUser.sub, token);

    if (!isAdmin) {
      return json({ success: false, message: "Admin access denied" }, 403);
    }

    const result = await env.DB.prepare(`
      SELECT id, customer_name, phone, address,
        total_amount, payment_method, payment_status,
        order_status, created_at,
        delivery_person_name, delivery_person_phone,
        delivery_notes
      FROM orders
      ORDER BY id DESC
      LIMIT 100
    `).all();

    const orders = result.results || [];

    if (orders.length === 0) {
      return json({ success: true, orders: [] });
    }

    const placeholders = orders.map(() => "?").join(",");

    const itemResult = await env.DB.prepare(`
      SELECT order_id, product_name, quantity, unit_price
      FROM order_items
      WHERE order_id IN (${placeholders})
    `).bind(...orders.map(order => order.id)).all();

    const items = itemResult.results || [];

    const ordersWithItems = orders.map(order => ({
      ...order,
      items: items.filter(item => item.order_id === order.id)
    }));

    return json({
      success: true,
      orders: ordersWithItems
    });

  } catch (error) {
    return json({
      success: false,
      message: "Authentication or server error"
    }, 401);
  }
}
