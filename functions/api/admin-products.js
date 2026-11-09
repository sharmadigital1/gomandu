
const PROJECT_ID = "gomandu-7026e";
const ADMIN_ORIGIN = "https://admin.go-mandu.com";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": ADMIN_ORIGIN,
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Vary": "Origin"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
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

  const now = Math.floor(Date.now() / 1000);

  if (
    header.alg !== "RS256" ||
    !header.kid ||
    payload.aud !== PROJECT_ID ||
    payload.iss !== `https://securetoken.google.com/${PROJECT_ID}` ||
    !payload.sub ||
    payload.exp <= now ||
    payload.iat > now + 60
  ) throw new Error("Invalid token claims");

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
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
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

async function authenticateAdmin(request) {
  if (request.headers.get("Origin") !== ADMIN_ORIGIN) {
    return { success: false, status: 403, message: "Origin not allowed" };
  }

  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!token) {
    return { success: false, status: 401, message: "Login required" };
  }

  try {
    const user = await verifyFirebaseToken(token);

    const url =
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
      `/databases/(default)/documents/admins/${encodeURIComponent(user.sub)}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      return { success: false, status: 403, message: "Admin access denied" };
    }

    const document = await response.json();

    if (document.fields?.role?.stringValue !== "admin") {
      return { success: false, status: 403, message: "Admin access denied" };
    }

    return { success: true };
  } catch {
    return { success: false, status: 401, message: "Authentication failed" };
  }
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export async function onRequestOptions() {
  return new Response("OK", { status: 200, headers });
}

// GET: Admin menu list
export async function onRequestGet({ request, env }) {
  const auth = await authenticateAdmin(request);
  if (!auth.success) {
    return json({ success: false, message: auth.message }, auth.status);
  }

  if (!env.DB) return json({ success: false, message: "Database unavailable" }, 500);

  try {
    const result = await env.DB.prepare(`
      SELECT id, name, price_npr, menu_key, restaurant_id, active
      FROM products
      ORDER BY id DESC
    `).all();

    return json({ success: true, products: result.results || [] });
  } catch (error) {
    console.error("ADMIN PRODUCTS GET:", error);
    return json({ success: false, message: "Could not load products" }, 500);
  }
}

// POST: Add or update product
export async function onRequestPost({ request, env }) {
  const auth = await authenticateAdmin(request);
  if (!auth.success) {
    return json({ success: false, message: auth.message }, auth.status);
  }

  if (!env.DB) return json({ success: false, message: "Database unavailable" }, 500);

  try {
    const body = await request.json();

    const restaurantId = Number(body.restaurant_id);
    const name = String(body.name || "").trim();
    const price = Number(body.price_npr);
    const active = body.active === 0 || body.active === false ? 0 : 1;

    if (
      !Number.isSafeInteger(restaurantId) ||
      restaurantId < 1 ||
      name.length < 2 ||
      name.length > 100 ||
      !Number.isSafeInteger(price) ||
      price < 0
    ) {
      return json({ success: false, message: "Invalid product details" }, 400);
    }

    const restaurant = await env.DB.prepare(`
      SELECT id FROM restaurants WHERE id = ? AND active = 1 LIMIT 1
    `).bind(restaurantId).first();

    if (!restaurant) {
      return json({ success: false, message: "Restaurant not found" }, 404);
    }

    // Update an existing D1 product
    if (body.id !== undefined && body.id !== null && body.id !== "") {
      const id = Number(body.id);

      if (!Number.isSafeInteger(id) || id < 1) {
        return json({ success: false, message: "Invalid product ID" }, 400);
      }

      const existing = await env.DB.prepare(`
        SELECT id FROM products WHERE id = ? LIMIT 1
      `).bind(id).first();

      if (!existing) {
        return json({ success: false, message: "Product not found" }, 404);
      }

      await env.DB.prepare(`
        UPDATE products
        SET name = ?, price_npr = ?, restaurant_id = ?, active = ?
        WHERE id = ?
      `).bind(name, price, restaurantId, active, id).run();

      return json({ success: true, message: "Product updated successfully", id });
    }

    // Create a unique menu_key: restaurantId:food-name
    const baseSlug = slugify(name);
    if (!baseSlug) {
      return json({ success: false, message: "Invalid product name" }, 400);
    }

    let menuKey = `${restaurantId}:${baseSlug}`;
    let suffix = 2;

    while (await env.DB.prepare(`
      SELECT id FROM products WHERE menu_key = ? LIMIT 1
    `).bind(menuKey).first()) {
      menuKey = `${restaurantId}:${baseSlug}-${suffix++}`;
      if (suffix > 1000) throw new Error("Could not generate unique menu key");
    }

    const result = await env.DB.prepare(`
      INSERT INTO products (name, price_npr, menu_key, restaurant_id, active)
      VALUES (?, ?, ?, ?, ?)
    `).bind(name, price, menuKey, restaurantId, active).run();

    return json({
      success: true,
      message: "Product added successfully",
      id: result.meta.last_row_id,
      menu_key: menuKey
    });
  } catch (error) {
    console.error("ADMIN PRODUCTS POST:", error);
    return json({ success: false, message: error.message || "Could not save product" }, 500);
  }
}

// DELETE: Remove product
export async function onRequestDelete({ request, env }) {
  const auth = await authenticateAdmin(request);
  if (!auth.success) {
    return json({ success: false, message: auth.message }, auth.status);
  }

  if (!env.DB) return json({ success: false, message: "Database unavailable" }, 500);

  try {
    const body = await request.json();
    const id = Number(body.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return json({ success: false, message: "Valid product ID is required" }, 400);
    }

    const result = await env.DB.prepare(`
      DELETE FROM products WHERE id = ?
    `).bind(id).run();

    if (!result.meta || result.meta.changes === 0) {
      return json({ success: false, message: "Product not found" }, 404);
    }

    return json({ success: true, message: "Product deleted successfully" });
  } catch (error) {
    console.error("ADMIN PRODUCTS DELETE:", error);
    return json({ success: false, message: "Could not delete product" }, 500);
  }
}
