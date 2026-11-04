/**
 * Who may use the bot, which modes they may use, and which calendar they drive. All from env:
 *
 *   ASSISTANT_OWNER_NUMBER  the owner's WhatsApp number. Always a member, every mode.
 *   TEAM   {"<number>": {"name": "Bob", "role": "sales", "calendarId": "...", "tz": "Europe/London"}}
 *   ROLES  {"sales": ["sales"], "admin": ["assistant", "sales"]}
 *
 * Numbers are compared digits only, so "+1 555-0100" and "15550100" are the same person.
 * Anyone else is ignored. A member with no role gets every mode; a member whose role is not in
 * ROLES gets none (fail closed: a typo in config never grants access).
 *
 * Calendar scoping: a user only drives a calendar mapped to THEM (TEAM[n].calendarId). The shared
 * ASSISTANT_CALENDAR_ID applies to the owner number only; every other member stays in DRY-RUN until
 * they have their own mapping, so no teammate can read or edit the owner's calendar.
 */
export const CONSOLES = ["assistant", "sales"];
export const digits = (s) => String(s ?? "").replace(/\D/g, "");

const cache = {};
function jsonEnv(name) {
  const raw = process.env[name] || "{}";
  if (cache[name]?.raw !== raw) {
    let v = {};
    try { v = JSON.parse(raw); } catch { /* bad JSON = empty */ }
    cache[name] = { raw, v: v && typeof v === "object" && !Array.isArray(v) ? v : {} };
  }
  return cache[name].v;
}

export const isOwner = (from) => {
  const owner = digits(process.env.ASSISTANT_OWNER_NUMBER);
  return !!owner && digits(from) === owner;
};

/** { waId, name, role, calendarId, tz } for a member, else null. */
export function member(from) {
  const d = digits(from);
  if (!d) return null;
  const hit = Object.entries(jsonEnv("TEAM")).find(([k]) => digits(k) === d)?.[1];
  if (!hit && !isOwner(from)) return null;
  const m = hit && typeof hit === "object" ? hit : {};
  return { waId: d, name: String(m.name || "").trim(), role: String(m.role || "").trim(), calendarId: String(m.calendarId || "").trim(), tz: String(m.tz || "").trim() };
}

export function allowedConsoles(from) {
  const m = member(from);
  if (!m) return [];
  if (isOwner(from) || !m.role) return [...CONSOLES];
  const roles = jsonEnv("ROLES");
  const key = Object.keys(roles).find((r) => r.toLowerCase() === m.role.toLowerCase());
  return key && Array.isArray(roles[key]) ? CONSOLES.filter((c) => roles[key].includes(c)) : [];
}

export const canUse = (from, consoleName) => allowedConsoles(from).includes(consoleName);

/** The calendar this user may drive: their own mapping, or the default for the owner only. "" = DRY-RUN. */
export function calendarFor(from) {
  const m = member(from);
  if (!m) return "";
  if (m.calendarId) return m.calendarId;
  return isOwner(from) ? process.env.ASSISTANT_CALENDAR_ID || "" : "";
}

const validTz = (z) => { try { new Intl.DateTimeFormat("en", { timeZone: z }); return true; } catch { return false; } };

export function tzFor(from) {
  const z = member(from)?.tz;
  if (z && validTz(z)) return z;
  const d = process.env.ASSISTANT_TZ;
  return d && validTz(d) ? d : "UTC";
}
