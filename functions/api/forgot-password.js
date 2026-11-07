const json = (data, status = 200, extraHeaders = {}) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...extraHeaders }
  });

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

const TOKEN_TTL_MIN = 30;
const MAX_PER_ACCOUNT_HOUR = 3;
const MAX_PER_IP_HOUR = 5;

async function sendResetEmail(env, to, link) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to,
      subject: "Reset your GoMandu password",
      html: `<p>We received a request to reset your GoMandu password.</p>
             <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#e8590c;color:#fff;border-radius:10px;text-decoration:none">Reset password</a></p>
             <p>This link expires in ${TOKEN_TTL_MIN} minutes. If you didn't ask for this, you can ignore this email.</p>
             <p style="color:#888;font-size:12px">GoMandu will never ask for your password or OTP by phone, SMS or email.</p>`,
      text: `Reset your GoMandu password: ${link}\nThis link expires in ${TOKEN_TTL_MIN} minutes. If you didn't request it, ignore this email.`
    })
  });
  if (!res.ok) console.error("Resend error:", res.status, await res.text());
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DB) {
    return json({ error: "Database connection failed" }, 500);
  }

  const generic = json({
    success: true,
    message: "If an account exists for that email, a reset link has been sent."
  });

  try {
    const body = await request.json();
    const email = String(body.email || "").trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return json({ error: "Please enter a valid email." }, 400);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const hourAgo = now - 3600000;

    // clean old rows
    waitUntil(
      env.DB.prepare("DELETE FROM password_resets WHERE created_at < ?")
        .bind(now - 24 * 3600000).run()
    );

    // rate limit per IP
    const ipCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM password_resets WHERE ip = ? AND created_at > ?"
    ).bind(ip, hourAgo).first();

    if (ipCount.c >= MAX_PER_IP_HOUR) {
      return json({ error: "Too many requests. Please try again later." }, 429);
    }

    const customer = await env.DB.prepare(
      "SELECT id, email FROM customers WHERE email = ?"
    ).bind(email).first();

    if (!customer) {
      // count the attempt, but store an already-used dummy token
      await env.DB.prepare(
        `INSERT INTO password_resets (customer_id, token_hash, expires_at, used_at, ip, created_at)
         VALUES (NULL, ?, ?, ?, ?, ?)`
      ).bind(await sha256Hex(crypto.randomUUID()), now, now, ip, now).run();
      return generic;
    }

    const acct = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM password_resets WHERE customer_id = ? AND created_at > ?"
    ).bind(customer.id, hourAgo).first();

    if (acct.c >= MAX_PER_ACCOUNT_HOUR) {
      return generic;
    }

    const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256Hex(token);

    await env.DB.prepare(
      `INSERT INTO password_resets (customer_id, token_hash, expires_at, ip, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(customer.id, tokenHash, now + TOKEN_TTL_MIN * 60000, ip, now).run();

    const link = `${String(env.SITE_URL).replace(/\/$/, "")}/?reset=${token}`;
    waitUntil(sendResetEmail(env, customer.email, link));

    return generic;
  } catch (error) {
    console.error("Forgot password failed:", error);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
