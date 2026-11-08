const json = (data, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

function getCookie(request, name) {
  const part = (request.headers.get("Cookie") || "")
    .split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
  return part ? part.slice(name.length + 1) : "";
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "Database connection failed" }, 500);

  try {
    const token = getCookie(request, "gm_session");
    if (!/^[a-f0-9]{64}$/i.test(token)) return json({ error: "Not logged in" }, 401);

    const session = await env.DB.prepare(
      `SELECT customer_id FROM customer_sessions
       WHERE token_hash = ? AND expires_at > datetime('now')`
    ).bind(await sha256Hex(token)).first();

    if (!session) return json({ error: "Not logged in" }, 401);

    const total = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_transactions WHERE customer_id = ?"
    ).bind(session.customer_id).first();

    const history = await env.DB.prepare(
      `SELECT id, order_id, type, amount, note, created_at
       FROM wallet_transactions WHERE customer_id = ?
       ORDER BY id DESC LIMIT 20`
    ).bind(session.customer_id).all();

    return json({
      balance: Math.round(total.balance * 100) / 100,
      transactions: history.results || []
    });
  } catch (error) {
    console.error("Cashback load failed:", error);
    return json({ error: "Unable to load cashback." }, 500);
  }
}
