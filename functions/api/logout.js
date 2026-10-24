
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(
    new Uint8Array(digest),
    b => b.toString(16).padStart(2, "0")
  ).join("");
}

export async function onRequestPost({ request, env }) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    /(?:^|;\s*)gm_session=([a-f0-9]{64})(?:;|$)/
  );

  try {
    if (match && env.DB) {
      const tokenHash = await sha256Hex(match[1]);

      await env.DB.prepare(
        "DELETE FROM customer_sessions WHERE token_hash = ?"
      ).bind(tokenHash).run();
    }

    return Response.json(
      { success: true, message: "Logged out successfully" },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie":
            "gm_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
        }
      }
    );
  } catch (error) {
    console.error("Logout failed:", error);

    return Response.json(
      { error: "Unable to log out. Please try again." },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" }
      }
    );
  }
}
