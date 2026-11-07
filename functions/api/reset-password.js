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

// Same format as login: pbkdf2_sha256$100000$<salt hex>$<hash hex>
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return `pbkdf2_sha256$100000$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({ error: "Database connection failed" }, 500);
  }

  try {
    const body = await request.json();
    const token = String(body.token || "");
    const password = String(body.password || "");

    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return json({ error: "Reset link is invalid or expired." }, 400);
    }
    if (password.length < 8 || password.length > 128) {
      return json({ error: "Password must be 8–128 characters long." }, 400);
    }

    const now = Date.now();
    const tokenHash = await sha256Hex(token);

    // claim the token (one-time use)
    const claim = await env.DB.prepare(
      `UPDATE password_resets
       SET used_at = ?
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND customer_id IS NOT NULL
       RETURNING customer_id`
    ).bind(now, tokenHash, now).first();

    if (!claim) {
      return json({ error: "Reset link is invalid or expired." }, 400);
    }

    const newHash = await hashPassword(password);

    await env.DB.batch([
      env.DB.prepare("UPDATE customers SET password_hash = ? WHERE id = ?")
        .bind(newHash, claim.customer_id),
      env.DB.prepare(
        "UPDATE password_resets SET used_at = ? WHERE customer_id = ? AND used_at IS NULL"
      ).bind(now, claim.customer_id),
      // log the user out everywhere
      env.DB.prepare("DELETE FROM customer_sessions WHERE customer_id = ?")
        .bind(claim.customer_id)
    ]);

    return json({ success: true, message: "Password updated" });
  } catch (error) {
    console.error("Reset password failed:", error);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
