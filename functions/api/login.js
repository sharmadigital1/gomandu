
const json = (data, status = 200, extraHeaders = {}) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) {
    throw new Error("Invalid stored hash");
  }
  return Uint8Array.from(
    hex.match(/.{2}/g),
    byte => parseInt(byte, 16)
  );
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return toHex(new Uint8Array(digest));
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");

  if (
    parts.length !== 4 ||
    parts[0] !== "pbkdf2_sha256" ||
    parts[1] !== "600000"
  ) {
    return false;
  }

  try {
    const salt = fromHex(parts[2]);
    const expected = fromHex(parts[3]);

    if (salt.length !== 16 || expected.length !== 32) {
      return false;
    }

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: 600000,
        hash: "SHA-256"
      },
      key,
      256
    );

    const actual = new Uint8Array(bits);
    let difference = 0;

    for (let i = 0; i < expected.length; i++) {
      difference |= actual[i] ^ expected[i];
    }

    return difference === 0;
  } catch {
    return false;
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({ error: "Database connection failed" }, 500);
  }

  try {
    const body = await request.json();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      password.length < 8 ||
      password.length > 128
    ) {
      return json({ error: "Invalid email or password" }, 400);
    }

    const customer = await env.DB.prepare(
      `SELECT id, name, email, password_hash
       FROM customers
       WHERE email = ?`
    ).bind(email).first();

    if (
      !customer ||
      !(await verifyPassword(password, customer.password_hash))
    ) {
      return json({ error: "Invalid email or password" }, 401);
    }

    const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256Hex(token);

    await env.DB.prepare(
      `INSERT INTO customer_sessions
       (customer_id, token_hash, expires_at)
       VALUES (?, ?, datetime('now', '+7 days'))`
    ).bind(customer.id, tokenHash).run();

    return json(
      {
        success: true,
        message: "Login successful",
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email
        }
      },
      200,
      {
        "Set-Cookie":
          `gm_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
      }
    );
  } catch (error) {
    console.error("Login failed:", error);
    return json(
      { error: "Unable to log in. Please try again." },
      500
    );
  }
}
