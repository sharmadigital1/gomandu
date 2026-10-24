
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

export async function onRequestGet({ request, env }) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)gm_session=([a-f0-9]{64})(?:;|$)/);

  if (!match || !env.DB) {
   return Response.json(
  { authenticated: false },
  {
    status: 401,
    headers: { "Cache-Control": "no-store" }
  }
);
  }

  try {
    const tokenHash = await sha256Hex(match[1]);

    const session = await env.DB.prepare(
      `SELECT c.id, c.name, c.email
       FROM customer_sessions s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.token_hash = ?
         AND s.expires_at > datetime('now')`
    ).bind(tokenHash).first();

    if (!session) {
      return Response.json(
        { authenticated: false },
        {
          status: 401,
          headers: { "Cache-Control": "no-store" }
        }
      );
    }

    return Response.json(
      {
        authenticated: true,
        customer: {
          id: session.id,
          name: session.name,
          email: session.email
        }
      },
      {
        headers: { "Cache-Control": "no-store" }
      }
    );
  } catch (error) {
    console.error("Session verification failed:", error);

    return Response.json(
      { error: "Unable to verify session" },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" }
      }
    );
  }
}
