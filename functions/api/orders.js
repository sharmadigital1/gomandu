async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
async function getSessionCustomer(request, env) {
  const match = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)gm_session=([a-f0-9]{64})(?:;|$)/);
  if (!match || !env.DB) return null;
  return env.DB.prepare(`SELECT c.id, c.name, c.email FROM customer_sessions s JOIN customers c ON c.id = s.customer_id WHERE s.token_hash = ? AND s.expires_at > datetime('now') LIMIT 1`).bind(await sha256Hex(match[1])).first();
}
const fail = (message, status = 400) => Response.json({ error: message }, { status });
function locationOf(value) {
  const latitude = Number(value?.latitude), longitude = Number(value?.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}
function chargeFor(km) { return km <= 1 ? 20 : km <= 2 ? 30 : km <= 4 ? 40 : km <= 10 ? 50 : 50 + Math.ceil(km - 10) * 20; }
function locationConfig(env) {
  try { const parsed = JSON.parse(env.RESTAURANT_LOCATIONS || "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch (_) { return null; }
}
async function routeQuote(env, origin, destination) {
  if (!env.GOOGLE_MAPS_API_KEY) throw new Error("Delivery service is not configured");
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": "routes.distanceMeters,routes.duration" },
    body: JSON.stringify({ origin: { location: { latLng: origin } }, destination: { location: { latLng: destination } }, travelMode: "DRIVE" })
  });
  const data = await response.json().catch(() => ({})), meters = Number(data.routes?.[0]?.distanceMeters);
  if (!response.ok || !Number.isFinite(meters) || meters < 0) throw new Error("Unable to calculate delivery distance");
  const distanceKm = Math.round((meters / 1000) * 100) / 100;
  return { distanceKm, charge: chargeFor(meters / 1000) };
}
function discountFor(code, subtotal, restaurantId) {
  const rules = { WELCOME20: ["pct", 20, 200, 300], MOMO50: ["flat", 50, 0, 300], GOMANDU100: ["flat", 100, 0, 1000], MART10: ["pct", 10, 150, 500, "mart"] };
  const rule = rules[code]; if (!rule || subtotal < rule[3] || (rule[4] && rule[4] !== restaurantId)) return 0;
  return Math.min(rule[0] === "pct" ? Math.round(subtotal * rule[1] / 100) : rule[1], rule[2] || Infinity, subtotal);
}
export async function onRequestPost({ request, env }) {
  if (!env.DB) return fail("Database is not connected", 500);
  const customer = await getSessionCustomer(request, env); if (!customer) return fail("Please log in to place an order", 401);
  try {
    const body = await request.json(), customerName = String(body.customer_name || "").trim(), phone = String(body.phone || "").trim(), address = String(body.address || "").trim();
    const destination = locationOf({ latitude: body.latitude, longitude: body.longitude }), restaurantId = String(body.restaurant_id || "").trim(), items = body.items;
    if (customerName.length < 2 || customerName.length > 100 || !/^[0-9+\-\s()]{7,20}$/.test(phone) || address.length < 5 || address.length > 500 || !destination || !/^[a-z0-9-]+$/i.test(restaurantId) || !Array.isArray(items) || !items.length || items.length > 32) return fail("Please check your order details");
    const restaurant = locationConfig(env)?.[restaurantId], origin = locationOf(restaurant);
    if (!origin) return fail("This restaurant is not configured for delivery", 422);
    const quantities = new Map();
    for (const item of items) {
      const key = String(item.menu_key || ""), quantity = Number(item.quantity);
      if (!/^[a-z0-9-]+:[a-z0-9-]+$/i.test(key) || key.split(":", 1)[0] !== restaurantId || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) return fail("Invalid product or quantity");
      quantities.set(key, (quantities.get(key) || 0) + quantity);
    }
    if ([...quantities.values()].some(q => q > 20)) return fail("Maximum quantity is 20 per product");
    const keys = [...quantities.keys()], found = await env.DB.prepare(`SELECT menu_key, name, price_npr FROM products WHERE active = 1 AND menu_key IN (${keys.map(() => "?").join(",")})`).bind(...keys).all(), products = found.results || [];
    if (products.length !== keys.length || products.some(p => !Number.isSafeInteger(Number(p.price_npr)) || Number(p.price_npr) < 0)) return fail("A menu item is unavailable. Please refresh your cart.");
    const orderItems = products.map(p => ({ key: p.menu_key, name: p.name, quantity: quantities.get(p.menu_key), price: Number(p.price_npr) }));
    const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0), couponCode = String(body.coupon_code || "").trim().toUpperCase(), discount = discountFor(couponCode, subtotal, restaurantId), delivery = await routeQuote(env, origin, destination), total = subtotal - discount + delivery.charge;
    const result = await env.DB.prepare(`INSERT INTO orders (customer_name, phone, address, delivery_latitude, delivery_longitude, restaurant_id, restaurant_name, delivery_charge, delivery_distance_km, coupon_code, discount_amount, total_amount, customer_id, payment_method, payment_status, order_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cod', 'pending', 'new', datetime('now'))`).bind(customerName, phone, address, destination.latitude, destination.longitude, restaurantId, String(restaurant.name || "Restaurant"), delivery.charge, delivery.distanceKm, couponCode || null, discount, total, String(customer.id)).run();
    const orderId = result.meta?.last_row_id; if (!orderId) throw new Error("Order ID was not returned");
    await env.DB.batch(orderItems.map(i => env.DB.prepare(`INSERT INTO order_items (order_id, menu_key, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)`).bind(orderId, i.key, i.name, i.quantity, i.price)));
    return Response.json({ success: true, order_id: orderId, currency: "NPR", subtotal, discount_amount: discount, delivery_charge: delivery.charge, delivery_distance_km: delivery.distanceKm, total_amount: total, message: "Order placed successfully" }, { status: 201 });
  } catch (cause) {
    console.error("Order creation failed:", cause);
    return fail(cause.message === "Delivery service is not configured" ? cause.message : "Unable to place order. Please try again.", cause.message === "Delivery service is not configured" ? 503 : 500);
  }
}
export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) return fail("Database is not connected", 500);
    const customer = await getSessionCustomer(request, env); if (!customer) return fail("Please log in to view your orders", 401);
    const result = await env.DB.prepare(`SELECT id, total_amount, order_status, created_at, address AS delivery_address, restaurant_name, delivery_charge, delivery_distance_km, payment_method, delivery_person_name, delivery_person_phone, delivery_notes FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 50`).bind(String(customer.id)).all();
    const orders = result.results || [];
    for (const order of orders) { const items = await env.DB.prepare("SELECT menu_key, product_name AS name, quantity, unit_price FROM order_items WHERE order_id = ?").bind(order.id).all(); order.items = (items.results || []).map(i => ({ name: i.name, menu_key: i.menu_key, quantity: i.quantity, price: i.unit_price })); order.status = order.order_status; }
    return Response.json({ orders }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) { console.error("Order history failed:", cause); return fail("Unable to load order history", 500); }
}
