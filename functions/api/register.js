
const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return json({ error: "Database connection failed" }, 500);
  }

  try {
    const body = await request.json();
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (name.length < 2 || name.length > 80) {
      return json({ error: "Enter a valid name" }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        email.length > 254) {
      return json({ error: "Enter a valid email address" }, 400);
    }

    if (password.length < 8 || password.length > 128) {
      return json({
        error: "Password must be 12–128 characters long"
      }, 400);
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
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
        iterations: 100000,
        hash: "SHA-256"
      },
      key,
      256
    );

    const toHex = bytes =>
      Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

    const passwordHash =
  `pbkdf2_sha256$100000$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;

    await env.DB.prepare(
      `INSERT INTO customers (name, email, password_hash)
       VALUES (?, ?, ?)`
    ).bind(name, email, passwordHash).run();

    return json({
      success: true,
      message: "Registration successful. You can now log in."
    }, 201);

  } catch (error) {
    if (error?.cause?.message?.includes("UNIQUE") ||
        String(error?.message || "").includes("UNIQUE constraint failed")) {
      return json({ error: "This email is already registered" }, 409);
    }

    console.error("Registration failed:", error);
    return json({ error: "Unable to register. Please try again." }, 500);
  }
}
