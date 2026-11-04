/**
 * Text that came from a user (or from a Sheet / a calendar invite someone else wrote) made safe to
 * put inside a message we send. Control characters, newlines and bidi overrides become spaces (so a
 * value can't forge extra lines or flip text direction), WhatsApp markdown (* _ ~ `) is removed,
 * links are removed unless keepLinks, and the result is capped at `max` characters.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function cleanField(s, max = 40, { keepLinks = false } = {}) {
  let out = String(s ?? "").replace(UNSAFE, " ");
  if (!keepLinks) {
    out = out
      .replace(/(?:https?:\/\/|www\.)\S*/gi, "")
      .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|id|io|co|me|app|ly|link|xyz|info|biz|gl)\b\S*/gi, "");
  }
  return out.replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** Lowercase, accents and punctuation removed, single spaces: "Café-Lumière!" → "cafe lumiere". */
export const normalize = (s) =>
  String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Does `text` contain `phrase` as whole words (case, accents and punctuation ignored)? */
export function mentions(text, phrase) {
  const p = normalize(phrase);
  return !!p && ` ${normalize(text)} `.includes(` ${p} `);
}
