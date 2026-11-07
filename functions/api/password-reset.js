// password-reset.js — Forgot / Reset password (Cloudflare Worker + D1 + Resend)

/* ===== CONFIG: tapai ko database anusar edit garnus ===== */
const CUSTOMERS_TABLE = "customers";
const COL_ID          = "id";
const COL_EMAIL       = "email";
const COL_PASSWORD    = "password_hash";
const SESSIONS_TABLE  = "sessions";      // chaina bhane null
const SESSIONS_USER   = "customer_id";

const TOKEN_TTL_MIN        = 30;
const MAX_PER_ACCOUNT_HOUR = 3;
const MAX_PER_IP_HOUR      = 5;
/* ======================================================= */

// IMPORTANT: yo tapai ko /api/register ma use bhako hash sanga same hunu parcha
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return `pbkdf2$100000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

const b64 = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function sendResetEmail(env, to, link) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to,
      subject: "Reset your GoMandu password",
      html: `<p>We received a request to reset your GoMandu password.</p>
             <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#e8590c;color:#fff;border-radius:10px;text-decoration:none">Reset password</a></p>
             <p>This link expires in ${TOKEN_TTL_MIN} minutes. If you didn't ask for this, ignore this email.</p>`,
      text: `Reset your GoMandu password: ${link}\nThis link expires in ${TOKEN_TTL_MIN} minutes.`,
    }),
  });
  if (!res.ok) console.error("Resend error", res.status, await res.text());
}

/* POST /api/forgot-password  { email } */
export async function handleForgotPassword(request, env, ctx) {
  const generic = json({ success: true, message: "If an account exists, a reset link has been sent." });

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || email.length > 254) return json({ error: "Please enter your email." }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const hourAgo = now - 3600_000;

  ctx.waitUntil(env.DB.prepare("DELETE FROM password_resets WHERE created_at < ?").bind(now - 24 * 3600_000).run());

  const ipCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM password_resets WHERE ip = ? AND created_at > ?").bind(ip, hourAgo).first();
  if (ipCount.c >= MAX_PER_IP_HOUR) return json({ error: "Too many requests. Please try again later." }, 429);

  const user = await env.DB.prepare(`SELECT ${COL_ID} AS id FROM ${CUSTOMERS_TABLE} WHERE LOWER(${COL_EMAIL}) = ?`).bind(email).first();

  if (!user) {
    await env.DB.prepare("INSERT INTO password_resets (customer_id, token_hash, expires_at, used_at, ip, created_at) VALUES (NULL, ?, ?, ?, ?, ?)")
      .bind(await sha256Hex(crypto.randomUUID()), now, now, ip, now).run();
    return generic;
  }

  const acct = await env.DB.prepare("SELECT COUNT(*) AS c FROM password_resets WHERE customer_id = ? AND created_at > ?").bind(user.id, hourAgo).first();
  if (acct.c >= MAX_PER_ACCOUNT_HOUR) return generic;

  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO password_resets (customer_id, token_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(user.id, await sha256Hex(token), now + TOKEN_TTL_MIN * 60_000, ip, now).run();

  const link = `${env.SITE_URL.replace(/\/$/, "")}/?reset=${encodeURIComponent(token)}`;
  ctx.waitUntil(sendResetEmail(env, email, link));
  return generic;
}

/* POST /api/reset-password  { token, password } */
export async function handleResetPassword(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const token = String(body.token || "");
  const password = String(body.password || "");

  if (!token) return json({ error: "Reset link is invalid or expired." }, 400);
  if (password.length < 8 || password.length > 128) return json({ error: "Password must be 8–128 characters long." }, 400);

  const now = Date.now();
  const tokenHash = await sha256Hex(token);

  const claim = await env.DB.prepare(
    "UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND customer_id IS NOT NULL RETURNING customer_id"
  ).bind(now, tokenHash, now).first();
  if (!claim) return json({ error: "Reset link is invalid or expired." }, 400);

  const newHash = await hashPassword(password);
  const stmts = [
    env.DB.prepare(`UPDATE ${CUSTOMERS_TABLE} SET ${COL_PASSWORD} = ? WHERE ${COL_ID} = ?`).bind(newHash, claim.customer_id),
    env.DB.prepare("UPDATE password_resets SET used_at = ? WHERE customer_id = ? AND used_at IS NULL").bind(now, claim.customer_id),
  ];
  if (SESSIONS_TABLE) stmts.push(env.DB.prepare(`DELETE FROM ${SESSIONS_TABLE} WHERE ${SESSIONS_USER} = ?`).bind(claim.customer_id));
  await env.DB.batch(stmts);

  return json({ success: true });
}
