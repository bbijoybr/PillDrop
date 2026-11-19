/* PillDrop API Worker (optional hardened reference).
   Secret:   FREEMODEL_API_KEY   (wrangler secret put FREEMODEL_API_KEY)
   Optional: RATE_LIMITER binding (Cloudflare Rate Limiting) - see wrangler.toml note below.
   NOTE: the upstream call assumes FreeModel is OpenAI-compatible (POST /v1/chat/completions).
   If your current worker calls FreeModel differently, keep YOUR upstream call and copy only
   the CORS / validation / rate-limit parts. */
const ALLOWED = ["https://bbijoybr.github.io"];
const MODEL = "claude-opus-5-5", BASE = "https://freemodel.in/v1";
const MAX_MSG = 7000, MAX_BODY = 16000;
const ROUTES = { "/v1/chat": "chat", "/v1/symptom": "symptom", "/v1/medicine": "medicine" };
const SYS = {
  common: "You are PillDrop, a health-information assistant for people in Bangladesh. You are NOT a doctor: never claim to diagnose, never set medicine doses, never invent medicine facts (say you are not sure instead). For emergency signs tell the person to go to the nearest hospital or call 999 at once. Follow any output format given in the user message exactly (for example JSON only). Answer in the language the user asks for (Bangla or English).",
  chat: "Be concise. Use light Markdown.",
  symptom: "Give general self-care and when-to-see-a-doctor information only.",
  medicine: "Give general medicine information only. If unsure about a brand or generic name, say so."
};
const hits = new Map(); // fallback limiter (per isolate)

function cors(origin) {
  const ok = ALLOWED.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
  return { "Access-Control-Allow-Origin": ok ? origin : ALLOWED[0], "Access-Control-Allow-Methods": "POST, OPTIONS",
           "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", "Vary": "Origin" };
}
const json = (o, status, h) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...h } });

async function limited(env, ip) {
  if (env.RATE_LIMITER) { const { success } = await env.RATE_LIMITER.limit({ key: ip }); return !success; }
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a);
  if (hits.size > 5000) hits.clear();
  return a.length > 12; // 12 requests / minute / IP
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "", h = cors(origin), url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const kind = ROUTES[url.pathname];
    if (!kind) return json({ ok: false, error: "not_found" }, 404, h);
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, h);
    if (origin && !h["Access-Control-Allow-Origin"].includes(origin)) return json({ ok: false, error: "forbidden_origin" }, 403, h);
    if (+(req.headers.get("Content-Length") || 0) > MAX_BODY) return json({ ok: false, error: "too_large" }, 413, h);
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    if (await limited(env, ip)) return json({ ok: false, error: "rate_limited" }, 429, { ...h, "Retry-After": "60" });

    let body; try { body = JSON.parse(await req.text()); } catch { return json({ ok: false, error: "bad_json" }, 400, h); }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > MAX_MSG) return json({ ok: false, error: "bad_message" }, 400, h);
    if (!env.FREEMODEL_API_KEY) return json({ ok: false, error: "server_not_configured" }, 500, h);

    try {
      const up = await fetch(BASE + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.FREEMODEL_API_KEY },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, temperature: 0.3,
          messages: [{ role: "system", content: SYS.common + " " + SYS[kind] }, { role: "user", content: message }] })
      });
      if (!up.ok) return json({ ok: false, error: "upstream_" + up.status }, 502, h);
      const d = await up.json();
      const text = d.choices?.[0]?.message?.content ?? (Array.isArray(d.content) ? d.content.map(c => c.text || "").join("") : "");
      if (!text) return json({ ok: false, error: "empty_response" }, 502, h);
      return json({ ok: true, provider: "FreeModel", model: MODEL, response: text }, 200, h);
    } catch { return json({ ok: false, error: "upstream_unreachable" }, 502, h); }
  }
};
/* wrangler.toml (optional, better rate limiting):
   [[unsafe.bindings]]
   name = "RATE_LIMITER"
   type = "ratelimit"
   namespace_id = "1001"
   simple = { limit = 12, period = 60 }
*/
