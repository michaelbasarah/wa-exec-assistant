/**
 * WhatsApp Cloud API, single number: check the webhook signature, flatten the payload, send text,
 * download a voice note. With no WA_TOKEN / WA_PHONE_NUMBER_ID, sends are DRY-RUN (logged only).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** Meta signs each POST body: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
export function verifySignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  const want = Buffer.from("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"));
  const got = Buffer.from(String(header));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Meta webhook body → [{ from, id, text, audio?, unsupported? }]. Reactions and receipts are skipped. */
export function parseInbound(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        const base = { from: m.from, id: m.id };
        if (m.type === "text") out.push({ ...base, text: m.text?.body ?? "" });
        else if (m.type === "interactive") out.push({ ...base, text: (m.interactive?.button_reply ?? m.interactive?.list_reply)?.title ?? "" });
        else if (m.type === "audio") out.push({ ...base, text: "", audio: { id: m.audio?.id, mimeType: m.audio?.mime_type } });
        else if (m.type !== "reaction") out.push({ ...base, text: "", unsupported: true });
      }
    }
  }
  return out;
}

const creds = () => ({ token: process.env.WA_TOKEN, phoneId: process.env.WA_PHONE_NUMBER_ID });

export async function sendText(to, text) {
  const { token, phoneId } = creds();
  if (!token || !phoneId) { console.log(`→ ${to}: ${text}\n   (DRY-RUN: no WhatsApp creds, not sent)`); return false; }
  const resp = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: String(text).slice(0, 4096) } }),
  });
  if (!resp.ok) throw new Error(`WhatsApp send failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  return true;
}

/** Download a voice note: GET /{id} → short-lived URL → bytes. Returns { data (base64), mimeType } or null. */
export async function fetchMedia(mediaId) {
  const { token } = creds();
  if (!token || !mediaId) return null;
  try {
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const meta = await (await fetch(`${GRAPH}/${mediaId}`, auth)).json();
    if (!meta.url || meta.file_size > MAX_AUDIO_BYTES) return null;
    const file = await fetch(meta.url, auth);
    const buf = Buffer.from(await file.arrayBuffer());
    if (!file.ok || buf.byteLength > MAX_AUDIO_BYTES) return null;
    return { data: buf.toString("base64"), mimeType: meta.mime_type || "audio/ogg" };
  } catch {
    return null;
  }
}
