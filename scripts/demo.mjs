/**
 * Offline demo: `npm run demo`. Plays a scripted conversation through the REAL handlers (console
 * routing, assistant, sales, reminder sweep, SQLite store) with three things faked: the model's JSON
 * replies are scripted, and Google Calendar and the Sheet are in memory. No keys, no network.
 * Everything the bot prints is produced by the code; only what the model "said" is canned.
 */
process.env.DB_PATH = ":memory:";
process.env.ASSISTANT_OWNER_NUMBER = "15550100001";
process.env.ASSISTANT_CALENDAR_ID = "alice@example.com";
process.env.ASSISTANT_TZ = "Asia/Jakarta";
process.env.TEAM = JSON.stringify({ "15550100001": { name: "Alice" }, "15550100002": { name: "Bob", role: "sales" } });
process.env.ROLES = JSON.stringify({ sales: ["sales"] });

const { handleMessage } = await import("../src/server.mjs");
const { runReminderSweep } = await import("../src/assistant.mjs");
const { fakeCalendar, fakeSheet } = await import("../test/fakes.mjs");

const ALICE = "15550100001", BOB = "15550100002";
const now = new Date("2026-11-09T01:00:00Z"); // Mon 9 Nov, 08:00 in Jakarta
const cal = fakeCalendar([
  { calId: "alice@example.com", id: "e1", summary: "Team standup", status: "confirmed", start: { dateTime: "2026-11-09T09:00:00+07:00" }, end: { dateTime: "2026-11-09T09:30:00+07:00" } },
  { calId: "alice@example.com", id: "e2", summary: "Dentist", status: "confirmed", start: { dateTime: "2026-11-10T16:00:00+07:00" }, end: { dateTime: "2026-11-10T17:00:00+07:00" } },
  { calId: "alice@example.com", id: "e3", summary: "Dentist (follow-up)", status: "confirmed", start: { dateTime: "2026-11-17T16:00:00+07:00" }, end: { dateTime: "2026-11-17T16:30:00+07:00" } },
]);
cal.offset = "+07:00";
const sheet = fakeSheet([
  { date: "2026-11-02", rep: "Bob", business: "Kopi Senja", vertical: "Cafe", channel: "WhatsApp", status: "No reply", notes: "" },
  { date: "2026-11-03", rep: "Bob", business: "Sunrise Bakery", vertical: "Bakery", channel: "Walk-in", status: "Consult", notes: "" },
]);

// What the model returns for each message (scripted).
const MODEL = {
  "book a call with Sam tomorrow 4pm for an hour": { action: { type: "create", summary: "Call with Sam", start: "2026-11-10T16:00", durationMinutes: 60 }, reply: "Booked!" },
  "gym every Mon and Thu 7am until end of Dec, and remind me to renew my passport": { actions: [
    { type: "create", summary: "Gym", start: "2026-11-12T07:00", durationMinutes: 60, repeat: "weekly", byDay: ["MO", "TH"], until: "2026-12-31" },
    { type: "task_add", task: "renew my passport" }] },
  "what's on today and tomorrow?": { action: { type: "list", rangeStart: "2026-11-09", rangeEnd: "2026-11-10" } },
  "cancel the dentist": { action: { type: "cancel", matchText: "dentist" } },
  "remember the office wifi is on the fridge, and add buy printer ink": { actions: [
    { type: "remember", note: "the office wifi is on the fridge" }, { type: "task_add", task: "buy printer ink" }] },
  "my tasks": { action: { type: "tasks" } },
  "done 2": { action: { type: "task_done", pick: 2 } },
  "move the call with Sam to Wednesday 10am": { action: { type: "reschedule", matchText: "call with sam", newStart: "2026-11-11T10:00" } },
  "nudge me 15 minutes before meetings": { action: { type: "remind_set", kind: "events", leadMinutes: 15 } },
  "push the standup to 11": { action: { type: "reschedule", matchText: "standup", atTime: "09:00", newStart: "2026-11-09T11:00" } },
};
const SALES = {
  "Kopi Senja replied, they want a consult next week": [{ action: "write", operation: "update", business: "Kopi Senja", status: "Consult", notes: "consult next week" }],
  "the bread place said no": [{ action: "write", operation: "update", business: "Sunrise Bakery", status: "Rejected", notes: "said no" }],
  "new lead Toko Maju, retail, met them walk-in, no reply yet": [{ action: "write", operation: "add", business: "Toko Maju", vertical: "Retail", channel: "Walk-in", status: "No reply" }],
};

const deps = {
  cal, sheet, now,
  interpret: async (text) => MODEL[text] ?? { action: { type: "none" }, reply: "Okay." },
  transcribe: async () => "push the standup to 11",
  gen: async ({ contents }) => JSON.stringify({ updates: SALES[contents[0].parts[0].text.match(/<rep>\n([\s\S]*)\n<\/rep>/)[1].split("\n---\n").pop()] ?? [] }),
  fetchMedia: async () => ({ data: "(audio bytes)", mimeType: "audio/ogg" }),
  send: async (to, text) => console.log(`bot → ${to === ALICE ? "Alice" : "Bob"}:\n${text.replace(/^/gm, "  ")}\n`),
};
const say = async (from, text, extra = {}) => {
  console.log(`${from === ALICE ? "Alice" : "Bob"}: ${extra.audio ? "🎙️ (voice note)" : text}`);
  await handleMessage({ from, text, ...extra }, deps);
};

await say(ALICE, "/@assistant");
for (const t of ["book a call with Sam tomorrow 4pm for an hour", "gym every Mon and Thu 7am until end of Dec, and remind me to renew my passport",
  "what's on today and tomorrow?", "cancel the dentist", "1", "remember the office wifi is on the fridge, and add buy printer ink",
  "my tasks", "done 2", "move the call with Sam to Wednesday 10am", "nudge me 15 minutes before meetings"]) await say(ALICE, t);
await say(ALICE, "", { audio: { id: "media-1" } });

await say(BOB, "/@assistant");
await say(BOB, "/@sales");
for (const t of ["Kopi Senja replied, they want a consult next week", "the bread place said no", "yes", "new lead Toko Maju, retail, met them walk-in, no reply yet"]) await say(BOB, t);

console.log("── 10:45, the reminder sweep runs ──\n");
await runReminderSweep({ send: deps.send, cal, now: new Date("2026-11-09T03:45:00Z") });

console.log("── The sales sheet now ──");
console.table(sheet.data.map(({ date, rep, business, vertical, channel, status }) => ({ date, rep, business, vertical, channel, status })));
