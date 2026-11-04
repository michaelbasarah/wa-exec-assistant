/**
 * The webhook server (node:http, no framework).
 *   GET  /webhook  Meta's subscribe check (hub.verify_token must equal WA_VERIFY_TOKEN)
 *   POST /webhook  inbound messages; rejected unless X-Hub-Signature-256 matches WA_APP_SECRET
 *                  (ALLOW_UNSIGNED=1 skips the check for local testing only)
 *   GET  /health
 * Replies to Meta with 200 straight away, then handles each sender's messages one at a time, in order.
 * Also runs the reminder sweep every minute.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { verifySignature, parseInbound, sendText, fetchMedia } from "./whatsapp.mjs";
import { route } from "./console.mjs";
import { handleAssistant, handleVoice, runReminderSweep } from "./assistant.mjs";
import { handleSales } from "./sales.mjs";
import { touchUser } from "./store.mjs";

/** Handle one parsed inbound message. `deps` can replace send/fetchMedia and the handlers' own deps. */
export async function handleMessage(m, deps = {}) {
  const send = deps.send ?? sendText;
  const r = route(m.from, m.text, deps);
  if (r.kind === "ignore") return;
  touchUser(m.from, (deps.now ?? new Date()).toISOString());
  let reply;
  if (r.kind === "text") reply = r.text;
  else if (m.unsupported) reply = "I can read text and voice notes. Mind typing that?";
  else {
    const handler = r.kind === "assistant" ? handleAssistant : handleSales;
    reply = m.audio
      ? await handleVoice(m.from, await (deps.fetchMedia ?? fetchMedia)(m.audio.id), handler, deps)
      : await handler(m.from, m.text, deps);
  }
  for (const t of [].concat(reply)) await send(m.from, t);
}

const chains = new Map(); // sender → promise chain, so one sender's messages never race each other
function enqueue(key, job) {
  const next = (chains.get(key) || Promise.resolve()).then(job).catch((err) => console.error("handle:", err.message));
  chains.set(key, next);
  next.then(() => { if (chains.get(key) === next) chains.delete(key); });
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createApp(deps = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const reply = (code, body = "") => { res.writeHead(code, { "Content-Type": "text/plain" }); res.end(body); };
    if (req.method === "GET" && url.pathname === "/health") return reply(200, "ok");
    if (req.method === "GET" && url.pathname === "/webhook") {
      const ok = url.searchParams.get("hub.mode") === "subscribe" && !!process.env.WA_VERIFY_TOKEN
        && url.searchParams.get("hub.verify_token") === process.env.WA_VERIFY_TOKEN;
      return ok ? reply(200, url.searchParams.get("hub.challenge") || "") : reply(403);
    }
    if (req.method === "POST" && url.pathname === "/webhook") {
      let raw;
      try { raw = await readBody(req); } catch { return reply(413); }
      const signed = verifySignature(raw, req.headers["x-hub-signature-256"], process.env.WA_APP_SECRET);
      if (!signed && process.env.ALLOW_UNSIGNED !== "1") return reply(401);
      let body;
      try { body = JSON.parse(raw); } catch { return reply(400); }
      reply(200);
      for (const m of parseInbound(body)) enqueue(m.from, () => handleMessage(m, deps));
      return;
    }
    reply(404);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`wa-exec-assistant listening on :${port}`));
  setInterval(() => runReminderSweep({ send: sendText }).catch((err) => console.error("sweep:", err.message)), 60_000);
}
