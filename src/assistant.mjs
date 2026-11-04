/**
 * /@assistant: a personal secretary over WhatsApp. Each message goes to Gemini, which returns JSON
 * { reply, action | actions[] }; this module executes the actions against Google Calendar and the
 * local notes/tasks store, and writes the confirmation itself (it never trusts the model's "Booked!").
 *
 * Dependencies come in through `deps` so tests and the demo run with fakes:
 *   deps.interpret(text, history, now) → { reply, action|actions }   (default: Gemini)
 *   deps.cal  { list, create, patch, remove }                         (default: gcal.mjs when creds exist)
 *   deps.now  Date                                                    (default: new Date())
 *
 * With no calendar for this user (see team.mjs calendarFor) calendar actions run DRY-RUN: the reply
 * says what would have happened, and nothing touches Google. Notes, tasks and reminders always work.
 */
import { generate, transcribe } from "./gemini.mjs";
import { calendar, hasGoogleCreds } from "./gcal.mjs";
import { cleanField, mentions } from "./clean.mjs";
import { calendarFor, tzFor, member, canUse } from "./team.mjs";
import {
  nowInZone, naiveToInstant, instantToNaive, addMinutesInTz, durationMinutes, dayRange, isValidNaive, addDays, fmtWhen, fmtEventWhen,
} from "./time.mjs";
import * as S from "./store.mjs";

// --- The prompt --------------------------------------------------------------------------------
// JSON via responseMimeType, but no responseSchema: on gemini-2.5-flash a schema this big sometimes
// pushes the decoder into an endless newline loop. The executor validates every field instead.
export function systemPrompt(now) {
  return `You are a concise personal executive assistant inside WhatsApp. Be warm but brief.
Right now it is ${now.weekday}, ${now.date} ${now.time} (${now.zone}). Resolve relative dates against this and
output absolute local times as 'YYYY-MM-DDTHH:MM' (24h). Never output a date in the past.

Return ONLY JSON: {"action": {...}, "reply": "short confirmation or answer"}. If the message has SEVERAL separate
requests, use "actions": [{...}, {...}] instead of "action". Action types and fields:
- create: schedule something. start 'YYYY-MM-DDTHH:MM' (required), summary, durationMinutes (default 30).
    Recurring: repeat daily|weekly|monthly, byDay ["MO".."SU"] for weekly, and until 'YYYY-MM-DD' OR count.
    Several events at once: events: [{summary,start,durationMinutes,repeat,byDay,until,count}, ...].
- list: what's on. rangeStart, rangeEnd 'YYYY-MM-DD' (inclusive).
- cancel: matchText (keywords from the title), optional onDate 'YYYY-MM-DD', atTime 'HH:MM'. wholeSeries: true to
    remove an entire recurring series. Several different events: matches: ["dentist","gym"].
- reschedule: matchText (+onDate/atTime) and newStart 'YYYY-MM-DDTHH:MM', optional newDurationMinutes.
- freebusy: checkStart 'YYYY-MM-DDTHH:MM', optional checkDurationMinutes (default 60).
- remember: note = a fact to keep (string or array). notes: show notes, optional query.
- forget: pick (number from the list) or matchText / matches[] / all: true.
- note_edit: pick or matchText, and to = the new text.
- task_add: task = a to-do with NO clock time (string or array), optional due 'YYYY-MM-DD'. tasks: show the list.
- task_done: pick or matchText / matches[] / all: true.
- task_edit: pick or matchText; to = new text and/or due 'YYYY-MM-DD' / clearDue: true.
- remind_set: kind tasks (everyMinutes) | agenda (atTimes ["07:00","18:00"]) | events (leadMinutes).
- remind_off: optional kind (no kind = all). reminders: show the reminder settings.
- none: greetings, questions, or a request missing a needed time (ask for it in reply).
Rules: something with a clock time is a calendar create; 'remind me to X' with no time is task_add; a fact is
remember. Lists of notes/tasks are numbered: when the user refers to a number ('done 3', 'edit 2 to ...') put it
in pick. You don't know event IDs: for cancel/reschedule, matchText/matches must be words the user actually typed
in this message. Never claim you can't edit a task.`;
}

/** Squeeze runaway whitespace and cap length before a model reply reaches WhatsApp. */
export function sanitizeReply(reply, fallback = "Okay.") {
  const s = String(reply ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return !s ? fallback : s.length > 700 ? s.slice(0, 697) + "…" : s;
}

/** Recover the (complete, first-emitted) "action" object from JSON truncated by a runaway reply. */
export function salvageAction(text) {
  const s = String(text), open = s.indexOf("{", s.indexOf('"action"'));
  if (s.indexOf('"action"') < 0 || open < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") esc = true;
    else if (c === '"') inStr = !inStr;
    else if (!inStr && c === "{") depth++;
    else if (!inStr && c === "}" && --depth === 0) { try { return JSON.parse(s.slice(open, i + 1)); } catch { return null; } }
  }
  return null;
}

/** Ask the model. A sample that won't parse is retried hotter (breaks a repetition loop), then salvaged. */
export async function interpret(text, history, now, gen = generate) {
  const contents = [
    ...history.flatMap((h) => [{ role: "user", parts: [{ text: h.user }] }, { role: "model", parts: [{ text: h.assistant }] }]),
    { role: "user", parts: [{ text }] },
  ];
  let salvaged = null;
  for (const temperature of [0.2, 0.9]) {
    const out = await gen({ system: systemPrompt(now), contents, json: true, temperature });
    try { const p = JSON.parse(out); p.reply = sanitizeReply(p.reply); return p; } catch { salvaged ||= salvageAction(out); }
  }
  if (salvaged) return { action: salvaged, reply: "Okay." };
  throw new Error("could not parse the model output");
}

// --- Pure helpers (exported for tests) ----------------------------------------------------------
/** User-supplied text (task bodies, event titles that may come from someone else's invite) for display. */
export const show = (s, links = true) => cleanField(s, 200, { keepLinks: links });

const FREQ = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY" };
const DAYS = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

/** A single RRULE for a create action, or null for a one-off. UNTIL = end of that local day, in UTC. */
export function buildRecurrence(a, zone) {
  const freq = FREQ[a.repeat];
  if (!freq) return null;
  const parts = [`FREQ=${freq}`];
  const days = freq === "WEEKLY" && Array.isArray(a.byDay) ? a.byDay.map((d) => String(d).toUpperCase()).filter((d) => DAYS.has(d)) : [];
  if (days.length) parts.push(`BYDAY=${days.join(",")}`);
  if (a.until) parts.push(`UNTIL=${naiveToInstant(`${String(a.until).slice(0, 10)}T23:59`, zone).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`);
  else if (a.count > 0) parts.push(`COUNT=${Math.round(a.count)}`);
  return [`RRULE:${parts.join(";")}`];
}

export function eventBody(a, zone) {
  const start = String(a.start).slice(0, 16), dur = a.durationMinutes > 0 ? a.durationMinutes : 30;
  const recurrence = buildRecurrence(a, zone);
  return {
    summary: cleanField(a.summary, 120, { keepLinks: true }) || "Untitled",
    start: { dateTime: `${start}:00`, timeZone: zone },
    end: { dateTime: addMinutesInTz(start, dur, zone), timeZone: zone },
    ...(recurrence ? { recurrence } : {}),
  };
}

const title = (e, links = true) => show(e.summary, links) || "(no title)";

export function renderAgenda(events, zone, links = true) {
  const live = events.filter((e) => e.status !== "cancelled");
  if (!live.length) return "🗓️ Nothing on the calendar for that window.";
  return ["🗓️ *Your schedule:*", ...live.map((e) => `• ${fmtEventWhen(e, zone)} — ${title(e, links)}`)].join("\n");
}

const localHHMM = (e, zone) => (e.start?.dateTime ? instantToNaive(new Date(e.start.dateTime), zone).slice(11) : "");

/** Events whose title contains matchText (and start at atTime, if given). Cancelled ones dropped. */
export function matchEvents(events, matchText, atTime = "", zone) {
  const needle = String(matchText || "").trim().toLowerCase(), want = String(atTime || "").trim();
  return events.filter((e) => e.status !== "cancelled"
    && (!needle || String(e.summary || "").toLowerCase().includes(needle))
    && (!want || localHHMM(e, zone) === want));
}

export function unionMatchEvents(events, terms, atTime, zone) {
  const seen = new Set();
  return (Array.isArray(terms) ? terms : []).flatMap((t) => matchEvents(events, t, atTime, zone)).filter((e) => !seen.has(e.id) && seen.add(e.id));
}

/** Live events overlapping [start, start+minutes). All-day events block the whole local day. */
export function conflictsAt(events, start, minutes = 60, zone) {
  const s = naiveToInstant(String(start).slice(0, 16), zone), e = new Date(s.getTime() + (minutes > 0 ? minutes : 60) * 60_000);
  return events.filter((ev) => {
    if (ev.status === "cancelled") return false;
    const a = ev.start?.dateTime ? new Date(ev.start.dateTime) : naiveToInstant(`${ev.start?.date}T00:00`, zone);
    const b = ev.start?.dateTime ? (ev.end?.dateTime ? new Date(ev.end.dateTime) : new Date(a.getTime() + 30 * 60_000)) : new Date(a.getTime() + 86_400_000);
    return a < e && b > s;
  });
}

/** If every hit is an occurrence of one recurring series, its parent id. */
export function seriesIdOf(hits) {
  const ids = new Set(hits.map((e) => e.recurringEventId));
  return hits.length > 1 && ids.size === 1 && hits[0].recurringEventId ? hits[0].recurringEventId : null;
}

export const renderCandidates = (events, zone) =>
  ["I found a few. Which one?", ...events.slice(0, 6).map((e, i) => `${i + 1}) ${fmtEventWhen(e, zone)} — ${title(e)}`), "_Reply with the number._"].join("\n");

const ORD_EN = ["first", "second", "third", "fourth", "fifth", "sixth"];
const ORD_ID = ["pertama", "kedua", "ketiga", "keempat", "kelima", "keenam"];

/** "2", "#2", "number 2", "the second one", "yang kedua" → 0-based index within max, else null. */
export function parseChoiceIndex(text, max) {
  const s = String(text || "").trim().toLowerCase().replace(/^(the|yang)\s+/, "").replace(/\s+(one|nya)$/, "").trim();
  const num = s.match(/^(?:number|no\.?|nomor|#)?\s*(\d{1,2})\.?$/);
  const i = num ? Number(num[1]) - 1 : Math.max(ORD_EN.indexOf(s), ORD_ID.indexOf(s));
  return i >= 0 && i < max ? i : null;
}

export function renderBooked(booked, zone) {
  const one = (b) => `*${b.summary}* — ${fmtWhen(b.start, zone)}${b.dur !== 30 ? `, ${b.dur}min` : ""}${b.recurring ? " · repeating" : ""}`;
  const clash = (b) => (b.clash?.length ? `\n⚠️ overlaps *${title(b.clash[0])}* (${fmtEventWhen(b.clash[0], zone)})` : "");
  if (booked.length === 1) return `✅ Booked ${one(booked[0])}.${clash(booked[0])}`;
  return [`✅ Booked (${booked.length}):`, ...booked.map((b) => `• ${one(b)}${clash(b)}`)].join("\n");
}

export function renderCancelled(removed, zone) {
  const one = (e) => (e._series ? `the *${title(e)}* series (all occurrences)` : `*${title(e)}* — ${fmtEventWhen(e, zone)}`);
  if (removed.length === 1) {
    const r = removed[0], hint = !r._series && r.recurringEventId ? "\n_(just that one; say 'the whole series' to remove all)_" : "";
    return `🗑️ Cancelled ${one(r)}.${hint}`;
  }
  return [`🗑️ Cancelled (${removed.length}):`, ...removed.map((e) => `• ${one(e)}`)].join("\n");
}

export const filterByText = (rows, query) => {
  const q = String(query || "").trim().toLowerCase();
  return q ? rows.filter((r) => r.body.toLowerCase().includes(q)) : rows;
};

/** Note/task bodies from a string-or-array field (one message can add several). */
export const collectBodies = (...vals) => vals.flat().map((v) => String(v ?? "").trim()).filter(Boolean);

const terms = (a) => [...(Array.isArray(a.matches) ? a.matches : []), a.matchText].map((t) => String(t ?? "").trim()).filter(Boolean);

/** Rows a forget/task_done acts on: all, or the union of keyword matches. null = no criteria given. */
export function resolveTargets(rows, a) {
  if (a.all === true) return rows;
  const t = terms(a);
  if (!t.length) return null;
  const seen = new Set();
  return t.flatMap((x) => filterByText(rows, x)).filter((r) => !seen.has(r.id) && seen.add(r.id));
}

export const resolveByPick = (rows, pick) => {
  const n = Math.round(Number(pick));
  return Number.isFinite(n) && n >= 1 && n <= rows.length ? rows[n - 1] : null;
};

export const allDuplicates = (rows) => rows.length > 1 && rows.every((r) => r.body.trim().toLowerCase() === rows[0].body.trim().toLowerCase());

const due = (r) => (r.due ? ` _(due ${r.due})_` : "");
export const renderTasks = (rows, links = true) =>
  rows.length ? ["📋 *Your tasks:*", ...rows.map((r, i) => `${i + 1}) ${show(r.body, links)}${due(r)}`)].join("\n") : "📋 No open tasks. You're all clear. 🎉";
export const renderNotes = (rows, query = "") =>
  rows.length ? ["🗒️ *What I remember:*", ...rows.map((r, i) => `${i + 1}) ${show(r.body)}`)].join("\n")
    : query ? `🗒️ No notes matching “${show(query)}”.` : "🗒️ Nothing saved yet. Tell me to _remember_ something.";
const renderList = (emoji, verb, rows) =>
  rows.length === 1 ? `${emoji} ${verb}: _${show(rows[0].body)}_${due(rows[0])}` : [`${emoji} ${verb} (${rows.length}):`, ...rows.map((r) => `• ${show(r.body)}${due(r)}`)].join("\n");
const renderChoices = (rows) => ["I found a few. Which one?", ...rows.slice(0, 6).map((r, i) => `${i + 1}) ${show(r.body)}`)].join("\n");

// --- Reminders (pure) --------------------------------------------------------------------------
export const toHHMM = (s) => {
  const m = String(s ?? "").trim().match(/^(\d{1,2}):?(\d{2})?$/);
  if (!m || +m[1] > 23 || +(m[2] || 0) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2] || "00"}`;
};
export const normalizeTimes = (t) => [...new Set((Array.isArray(t) ? t : [t]).map(toHHMM).filter(Boolean))].sort();
export const clampEvery = (n) => { const v = Math.round(Number(n)); return Number.isFinite(v) && v > 0 ? Math.max(5, v) : null; };
export const withinWindow = (lastSeen, now, hours = 24) => {
  const t = Date.parse(lastSeen || "");
  return Number.isFinite(t) && now.getTime() - t < hours * 3_600_000;
};
export const tasksDue = (p, now) =>
  p.tasks_every_min > 0 && (!p.tasks_last_sent || now.getTime() - Date.parse(p.tasks_last_sent) >= p.tasks_every_min * 60_000);
export function agendaKeyDue(p, nowParts) {
  if (!String(p.agenda_times || "").split(",").includes(nowParts.time)) return null;
  const key = `${nowParts.date} ${nowParts.time}`;
  return key === p.agenda_last_key ? null : key;
}
export const humanEvery = (m) => (m === 60 ? "hour" : m % 60 === 0 ? `${m / 60} hours` : m > 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`);

export function renderReminders(p) {
  const lines = [];
  if (p?.tasks_every_min > 0) lines.push(`• 📋 To-do list every ${humanEvery(p.tasks_every_min)}`);
  if (p?.agenda_times) lines.push(`• 📅 Daily schedule at ${p.agenda_times.split(",").join(", ")}`);
  if (p?.event_lead_min > 0) lines.push(`• 🔔 ${p.event_lead_min} min before each event`);
  return lines.length ? ["⏰ *Your reminders:*", ...lines].join("\n") : "🔕 No reminders set. Try _\"send my schedule at 7am\"_.";
}

// --- Per-user context --------------------------------------------------------------------------
function context(from, deps) {
  const zone = tzFor(from), calId = calendarFor(from);
  const cal = deps.cal ?? (hasGoogleCreds() ? calendar : null);
  return { zone, calId, cal, live: !!(calId && cal), now: deps.now ?? new Date() };
}
export const assistantLive = (from, deps = {}) => context(from, deps).live;

// Last 6 turns per user, in memory on purpose. The assistant side is a neutral summary ("did: list,
// cancel"), never our rendered reply: that reply holds event titles, which anyone who invites you can
// write, and feeding them back to the model would let a crafted title steer the next cancel.
const histories = new Map();
const pending = new Map(); // from → { kind, verb, items, series } after a numbered list or a yes/no question
function remember(from, user, assistant) {
  const h = histories.get(from) || [];
  h.push({ user, assistant });
  histories.set(from, h.slice(-6));
}
export function clearAssistant(from) { histories.delete(from); pending.delete(from); }

const YES_RE = /^(y|ya|yes|yep|ok|oke|okay|sure|confirm|iya)[.!]?$/i;
const NO_RE = /^(n|no|nope|cancel|batal|gak|nggak|tidak)[.!]?$/i;

/** Match terms for cancel/reschedule, or an error reply. Each must be ≥3 chars and typed by the user in `text`. */
export function checkTerms(text, terms) {
  const t = terms.map((x) => String(x ?? "").trim());
  if (!t.length || t.some((x) => x.length < 3)) return { error: "Which event? Say part of its title, e.g. _cancel the dentist_." };
  if (!t.every((x) => mentions(text, x))) return { error: "Which event? Use words from its title in your message, e.g. _cancel the dentist_." };
  return { terms: t };
}

const dryRun = (what) => `_(DRY-RUN: would ${what}. No calendar is mapped to your number yet.)_`;

/** One assistant turn. Returns the reply text. */
export async function handleAssistant(from, text, deps = {}) {
  const { zone, calId, cal, live, now } = context(from, deps);
  const today = nowInZone(zone, now).date;
  const listWindow = (a) => {
    const start = a.onDate ? String(a.onDate).slice(0, 10) : today;
    return cal.list(calId, { ...dayRange(start, a.onDate ? start : addDays(start, 14), zone), maxResults: 50 });
  };
  async function cancelHits(hits, series) {
    const removed = [], done = new Set();
    for (const ev of hits) {
      if (series && ev.recurringEventId) {
        if (done.has(ev.recurringEventId)) continue;
        done.add(ev.recurringEventId);
        await cal.remove(calId, ev.recurringEventId);
        removed.push({ ...ev, _series: true });
      } else { await cal.remove(calId, ev.id); removed.push(ev); }
    }
    return removed;
  }

  // A bare "2" right after a numbered "which one?" list acts on that row without another model call.
  const p = pending.get(from);
  if (p?.kind === "confirm") {
    pending.delete(from);
    let reply = null;
    if (YES_RE.test(text.trim())) {
      try { reply = renderCancelled(await cancelHits(p.items, p.series), zone); } catch (err) { reply = `⚠️ That didn't go through: ${err.message}`; }
    } else if (NO_RE.test(text.trim())) reply = "↩️ Okay, nothing cancelled.";
    if (reply) { remember(from, text, "did: confirm"); return reply; }
  } else if (p) {
    const idx = parseChoiceIndex(text, p.items.length);
    if (idx != null) {
      let reply;
      if (!p.verb) reply = `What should I do with #${idx + 1}? Say e.g. "done ${idx + 1}" or "edit ${idx + 1} to ...".`;
      else {
        pending.delete(from);
        const row = p.items[idx];
        try {
          if (p.verb === "cancel") reply = renderCancelled(await cancelHits([row], false), zone);
          else if (p.verb === "forget") { S.deleteNote(from, row.id); reply = renderList("🗑️", "Forgotten", [row]); }
          else { S.completeTask(from, row.id); reply = renderList("✔️", "Done", [row]); }
        } catch (err) { reply = `⚠️ That didn't go through: ${err.message}`; }
      }
      remember(from, text, `did: pick ${p.verb || "(asked what to do)"}`);
      return reply;
    }
    pending.delete(from);
  }

  let parsed;
  try {
    parsed = await (deps.interpret ?? interpret)(text, histories.get(from) || [], nowInZone(zone, now));
  } catch (err) {
    return `⚠️ Assistant error: ${err.message}`;
  }
  const actions = Array.isArray(parsed.actions) && parsed.actions.length ? parsed.actions : [parsed.action || { type: "none" }];
  const preview = (what) => (actions.length === 1 ? `${parsed.reply || "Okay."}\n\n` : "") + dryRun(what);
  let claimed = false; // only the first ambiguous list in one message gets the "reply with a number" slot
  const claim = (kind, items, verb = null, series = false) => { if (!claimed) { claimed = true; pending.set(from, { kind, items, verb, series }); } };

  async function run(a) {
    try {
      switch (a.type) {
        case "create": {
          const specs = (Array.isArray(a.events) && a.events.length ? a.events : [a]).map((s) => ({ ...s, start: String(s.start || "").slice(0, 16) }));
          const valid = specs.filter((s) => isValidNaive(s.start));
          if (!valid.length) return "When should I schedule it? Give me a day and time (e.g. 'Tue 3pm').";
          if (!live) return preview(valid.map((s) => `create *${eventBody(s, zone).summary}* at ${s.start}`).join("; "));
          const booked = [];
          for (const s of valid) {
            const body = eventBody(s, zone), dur = s.durationMinutes > 0 ? s.durationMinutes : 30;
            let clash = [];
            try { clash = conflictsAt(await cal.list(calId, dayRange(s.start, s.start, zone)), s.start, dur, zone); } catch { /* advisory */ }
            await cal.create(calId, body);
            booked.push({ summary: body.summary, start: s.start, dur, recurring: !!body.recurrence, clash });
          }
          const skipped = specs.length - valid.length;
          return renderBooked(booked, zone) + (skipped ? `\n_(Skipped ${skipped} with no clear time.)_` : "");
        }
        case "list": {
          const start = a.rangeStart || today, end = a.rangeEnd || start;
          if (!live) return preview(`read ${start}${end !== start ? " to " + end : ""}`);
          return renderAgenda(await cal.list(calId, dayRange(start, end, zone)), zone);
        }
        case "cancel": {
          const many = Array.isArray(a.matches) && a.matches.length > 0;
          const chk = checkTerms(text, many ? a.matches : [a.matchText]);
          if (chk.error) return chk.error;
          const what = show(chk.terms.join(", ")), series = a.wholeSeries === true;
          if (!live) return preview(`cancel "${what}"${series ? " (whole series)" : ""}`);
          const evs = await listWindow(a);
          const hits = many ? unionMatchEvents(evs, chk.terms, a.atTime, zone) : matchEvents(evs, chk.terms[0], a.atTime, zone);
          if (!hits.length) return `🔍 I couldn't find "${what}"${a.onDate ? " on " + a.onDate : " in the next 2 weeks"}.`;
          const recurring = series && hits.some((e) => e.recurringEventId);
          if (hits.length === 1 && !recurring) return renderCancelled(await cancelHits(hits, false), zone);
          if (series || many) { // several events or a whole series: always ask first
            claim("confirm", hits, "cancel", series);
            const rows = hits.slice(0, 6).map((e) => `• ${fmtEventWhen(e, zone)} — ${title(e)}${series && e.recurringEventId ? " (whole series)" : ""}`);
            return [hits.length > 1 ? `Cancel these ${hits.length} events?` : "Cancel this event?", ...rows, hits.length > 6 ? `…and ${hits.length - 6} more` : "", "Reply *yes* or *no*."].filter(Boolean).join("\n");
          }
          if (seriesIdOf(hits)) return `🔁 That's a repeating series (${hits.length} coming up). Say "cancel the whole series", or give me a date.`;
          claim("event", hits, "cancel");
          return renderCandidates(hits, zone);
        }
        case "reschedule": {
          if (!isValidNaive(String(a.newStart || "").slice(0, 16))) return "When should I move it to? Give me a new day and time.";
          const ns = String(a.newStart).slice(0, 16);
          const chk = checkTerms(text, [a.matchText]);
          if (chk.error) return chk.error;
          if (!live) return preview(`move "${show(a.matchText)}" to ${ns}`);
          const hits = matchEvents(await listWindow(a), chk.terms[0], a.atTime, zone);
          if (!hits.length) return `🔍 I couldn't find "${show(a.matchText)}"${a.onDate ? " on " + a.onDate : " in the next 2 weeks"}.`;
          if (hits.length > 1) return renderCandidates(hits, zone);
          const ev = hits[0], dur = a.newDurationMinutes > 0 ? a.newDurationMinutes : durationMinutes(ev.start?.dateTime, ev.end?.dateTime) || 30;
          await cal.patch(calId, ev.id, { start: { dateTime: `${ns}:00`, timeZone: zone }, end: { dateTime: addMinutesInTz(ns, dur, zone), timeZone: zone } });
          return `📆 Moved *${title(ev)}* to ${fmtWhen(ns, zone)}.${ev.recurringEventId ? "\n_(that one occurrence)_" : ""}`;
        }
        case "freebusy": {
          if (!isValidNaive(String(a.checkStart || "").slice(0, 16))) return "Which time should I check?";
          const at = String(a.checkStart).slice(0, 16);
          if (!live) return preview(`check if you're free at ${at}`);
          const clash = conflictsAt(await cal.list(calId, dayRange(at, at, zone)), at, a.checkDurationMinutes || 60, zone);
          return clash.length ? `⛔ You're *busy* then: ${clash.map((e) => `${title(e)} (${fmtEventWhen(e, zone)})`).join(", ")}.` : `✅ You're *free* ${fmtWhen(at, zone)}.`;
        }
        case "remember": {
          const saved = collectBodies(a.note, a.items).map((b) => S.addNote(from, b)).filter(Boolean);
          return saved.length ? renderList("📝", "I'll remember", saved) : "What should I remember?";
        }
        case "notes": {
          const rows = filterByText(S.listNotes(from), a.query);
          claim("note", rows);
          return renderNotes(rows, a.query || "");
        }
        case "forget":
        case "task_done": {
          const isNote = a.type === "forget";
          const rows = isNote ? S.listNotes(from) : S.listTasks(from);
          const render = isNote ? renderNotes : renderTasks;
          if (!rows.length) return isNote ? "🗒️ You have no notes." : "📋 You have no open tasks. 🎉";
          let targets;
          if (a.pick != null && a.pick !== "") {
            const t = resolveByPick(rows, a.pick);
            if (!t) { claim(isNote ? "note" : "task", rows); return `That number isn't on the list (1–${rows.length}).\n${render(rows)}`; }
            targets = [t];
          } else {
            targets = resolveTargets(rows, a);
            if (targets === null) {
              if (!isNote && rows.length === 1) targets = rows;
              else { claim(isNote ? "note" : "task", rows, isNote ? "forget" : "done"); return `Which one? Give me a number, a keyword, or say 'all'.\n${renderChoices(rows)}`; }
            }
            if (!targets.length) return `🔍 Nothing matching ${terms(a).map((t) => `“${show(t)}”`).join(", ")}.`;
            if (a.all !== true && allDuplicates(targets)) { claim(isNote ? "note" : "task", targets, isNote ? "forget" : "done"); return renderChoices(targets); }
          }
          for (const r of targets) isNote ? S.deleteNote(from, r.id) : S.completeTask(from, r.id);
          return renderList(isNote ? "🗑️" : "✔️", isNote ? "Forgotten" : "Done", targets);
        }
        case "note_edit":
        case "task_edit": {
          const isNote = a.type === "note_edit", label = isNote ? "note" : "task";
          const rows = isNote ? S.listNotes(from) : S.listTasks(from);
          const render = isNote ? renderNotes : renderTasks;
          if (!rows.length) return `You have no ${label}s to edit.`;
          let target;
          if (a.pick != null && a.pick !== "") target = resolveByPick(rows, a.pick);
          else if (a.matchText) {
            const hits = filterByText(rows, a.matchText);
            if (hits.length !== 1) {
              if (!hits.length) return `🔍 No ${label} matching “${show(a.matchText)}”.`;
              claim(label, hits);
              return `Several ${label}s match. Which one?\n${render(hits)}`;
            }
            target = hits[0];
          } else return `Which ${label} should I edit? Give me its number.`;
          if (!target) { claim(label, rows); return `That number isn't on the list (1–${rows.length}).\n${render(rows)}`; }
          const pos = rows.indexOf(target) + 1;
          const updated = isNote
            ? (String(a.to || "").trim() ? S.updateNote(from, target.id, a.to) : null)
            : (String(a.to || "").trim() || a.clearDue || S.isPlainDate(a.due) ? S.updateTask(from, target.id, { body: a.to, due: a.due, clearDue: a.clearDue === true }) : null);
          if (!updated) return `What should I change ${label} #${pos} to?`;
          return `✏️ Updated ${label} #${pos}: _${show(updated.body)}_${due(updated)}`;
        }
        case "task_add": {
          const saved = collectBodies(a.task, a.items).map((b) => S.addTask(from, b, a.due)).filter(Boolean);
          return saved.length ? renderList("✅", "Added to your tasks", saved) : "What's the task?";
        }
        case "tasks": {
          const rows = S.listTasks(from);
          claim("task", rows);
          return renderTasks(rows);
        }
        case "remind_set": {
          if (a.kind === "tasks") {
            const every = clampEvery(a.everyMinutes);
            if (!every) return "How often should I send your to-do list? (e.g. 'every 2 hours')";
            S.setPrefs(from, { tasks_every_min: every });
            return `⏰ Okay, I'll send your open to-dos every ${humanEvery(every)}.`;
          }
          if (a.kind === "agenda") {
            const times = normalizeTimes(a.atTimes);
            if (!times.length) return "What time(s) should I send your schedule? (e.g. '7am and 6pm')";
            S.setPrefs(from, { agenda_times: times.join(",") });
            return `📅 Okay, I'll send your day's schedule at ${times.join(", ")}.`;
          }
          if (a.kind === "events") {
            const lead = Math.max(0, Math.round(Number(a.leadMinutes) || 0));
            if (!lead) return "How long before each event should I nudge you?";
            S.setPrefs(from, { event_lead_min: lead });
            return `🔔 Okay, I'll nudge you ${lead} min before each event.`;
          }
          return "Remind you about your *to-dos*, your *schedule*, or *before events*?";
        }
        case "remind_off": {
          const k = a.kind;
          S.setPrefs(from, {
            ...(!k || k === "tasks" ? { tasks_every_min: 0 } : {}),
            ...(!k || k === "agenda" ? { agenda_times: "" } : {}),
            ...(!k || k === "events" ? { event_lead_min: 0 } : {}),
          });
          return k ? `🔕 Turned off your ${k} reminders.` : "🔕 All reminders turned off.";
        }
        case "reminders": return renderReminders(S.getPrefs(from));
        default: return ""; // "none": the model's own reply covers it
      }
    } catch (err) {
      return `⚠️ That didn't go through: ${err.message}`;
    }
  }

  const results = [];
  for (const a of actions) results.push(await run(a)); // in order: a later action may depend on an earlier one
  const reply = results.filter(Boolean).join("\n\n") || parsed.reply || "Okay.";
  const did = actions.map((a) => a.type).filter((t) => t && t !== "none");
  remember(from, text, did.length ? `did: ${did.join(", ")}` : sanitizeReply(parsed.reply)); // see `histories`
  return reply;
}

/** Voice note → transcript → the same handler, with "Heard: …" on top so a mis-hear is visible. */
export async function handleVoice(from, audio, handler, deps = {}) {
  if (!audio?.data) return "🎙️ I couldn't fetch that voice note. Mind typing it?";
  let heard;
  try { heard = cleanField(await (deps.transcribe ?? transcribe)(audio), 700, { keepLinks: true }).replace(/^["'“”](.*)["'“”]$/, "$1").trim(); }
  catch (err) { return `⚠️ Couldn't transcribe that voice note: ${err.message}`; }
  if (!heard) return "🎙️ I couldn't make that out. Mind typing it?";
  const out = await handler(from, heard, deps);
  return `🎙️ _Heard: “${heard}”_\n\n${[].concat(out).join("\n")}`;
}

/**
 * One pass of the proactive reminders (the server runs it every minute). A user gets a message only
 * if they are STILL allowed to use the assistant (membership AND role, checked now, not when they
 * set the reminder) and messaged us in the last 24h (WhatsApp only allows free-form sends inside
 * that window). Titles and bodies are cleaned with links stripped: an event title can come from
 * someone else's invite, and this message arrives unprompted.
 */
export async function runReminderSweep({ send, now = new Date(), cal } = {}) {
  const stats = { users: 0, tasks: 0, agendas: 0, events: 0 };
  for (const p of S.listReminderUsers()) {
    try {
      if (!member(p.wa_id) || !canUse(p.wa_id, "assistant")) continue;
      if (!withinWindow(p.last_seen_at, now)) continue;
      stats.users++;
      const { zone, calId, cal: c, live } = context(p.wa_id, { cal, now });
      const parts = nowInZone(zone, now);
      if (tasksDue(p, now)) {
        const open = S.listTasks(p.wa_id);
        if (open.length) { await send(p.wa_id, "⏰ *To-do reminder*\n" + renderTasks(open, false)); stats.tasks++; }
        S.markTasksSent(p.wa_id, now.toISOString());
      }
      const key = agendaKeyDue(p, parts);
      if (key && live) {
        await send(p.wa_id, `🌅 *Today, ${parts.date}*\n` + renderAgenda(await c.list(calId, dayRange(parts.date, parts.date, zone)), zone, false));
        S.markAgendaSent(p.wa_id, key);
        stats.agendas++;
      }
      if (p.event_lead_min > 0 && live) {
        const horizon = now.getTime() + p.event_lead_min * 60_000;
        const evs = await c.list(calId, { timeMin: now.toISOString(), timeMax: new Date(horizon).toISOString(), maxResults: 20 });
        for (const ev of evs) {
          const t = Date.parse(ev.start?.dateTime || "");
          if (ev.status === "cancelled" || !(t > now.getTime() && t <= horizon) || S.wasNudged(p.wa_id, ev.id)) continue;
          await send(p.wa_id, `🔔 In ${Math.max(1, Math.round((t - now.getTime()) / 60_000))} min: *${title(ev, false)}*, ${fmtEventWhen(ev, zone)}.`);
          S.recordNudge(p.wa_id, ev.id, now.toISOString());
          stats.events++;
        }
      }
    } catch (err) {
      console.error("reminder sweep:", p.wa_id, err.message); // one user's failure never stalls the rest
    }
  }
  return stats;
}

export function assistantGreeting(from, deps = {}) {
  const name = show(member(from)?.name || "", false);
  return [
    `🤝 *${name ? `Hi ${name}!` : "Personal assistant"}* Just talk normally:`,
    "📌 _book a sync with Sam next Tue 3pm_ · _gym every Mon and Thu 7am until Dec_",
    "📋 _what's on tomorrow?_ · 🔀 _move the standup to 4pm_ · 🗑️ _cancel the dentist_ · 🟢 _am I free Fri at 4?_",
    "📝 _remember the gate code is 4821_ · ✅ _remind me to call the bank_ · _done 2_ · _edit 1 to ..._",
    "⏰ _send my schedule at 7am_ · _nudge me 15 min before meetings_ · 🎙️ voice notes work too",
    assistantLive(from, deps) ? "✅ Connected to your calendar." : "⚠️ Calendar in DRY-RUN: no calendar is mapped to your number yet.",
    "/@exit to leave.",
  ].join("\n");
}
