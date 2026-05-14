// POST /api/subscribe
// Body: { email: string, source?: string }
// Writes a row to the `subscribers` table in the bound D1 (binding name: DB).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const email = String(payload?.email || "").trim().toLowerCase();
  const source = String(payload?.source || "").slice(0, 200);

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return json({ error: "Please enter a valid email address." }, 400);
  }

  if (!env.DB) {
    return json({ error: "Storage not configured." }, 500);
  }

  const ip = request.headers.get("cf-connecting-ip") || "";
  const ua = (request.headers.get("user-agent") || "").slice(0, 300);
  const now = new Date().toISOString();

  try {
    await env.DB
      .prepare(
        "INSERT INTO subscribers (email, signup_at, source, ip, ua) VALUES (?1, ?2, ?3, ?4, ?5) " +
          "ON CONFLICT(email) DO UPDATE SET signup_at = excluded.signup_at, source = excluded.source"
      )
      .bind(email, now, source, ip, ua)
      .run();
  } catch (err) {
    return json({ error: "Could not save your email. Try again in a minute." }, 500);
  }

  return json({ ok: true });
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }
  return onRequestPost(context);
}
