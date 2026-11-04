process.env.DB_PATH = ":memory:";
process.env.ASSISTANT_OWNER_NUMBER = "+1 555-010-0001";
process.env.ASSISTANT_CALENDAR_ID = "owner-calendar@example.com";
process.env.TEAM = JSON.stringify({
  "15550100002": { name: "Bob", role: "sales" },
  "15550100003": { name: "Carol" }, //                                  no role, no calendar
  "15550100004": { name: "Dave", role: "ghost" }, //                    role not defined in ROLES
  "15550100005": { name: "Eve", calendarId: "eve@example.com", tz: "Europe/London" },
});
process.env.ROLES = JSON.stringify({ sales: ["sales"] });

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const T = await import("../src/team.mjs");
const { route } = await import("../src/console.mjs");
const { handleAssistant, assistantLive } = await import("../src/assistant.mjs");
const { fakeCalendar } = await import("./fakes.mjs");

const OWNER = "15550100001", BOB = "15550100002", CAROL = "15550100003", DAVE = "15550100004", EVE = "15550100005";

test("membership and roles", () => {
  assert.equal(T.member("15550109999"), null);
  assert.equal(T.member(OWNER).waId, OWNER); // owner counts even without a TEAM entry
  assert.deepEqual(T.allowedConsoles(OWNER), ["assistant", "sales"]);
  assert.deepEqual(T.allowedConsoles(BOB), ["sales"]);
  assert.deepEqual(T.allowedConsoles(CAROL), ["assistant", "sales"]); // no role = everything
  assert.deepEqual(T.allowedConsoles(DAVE), []); // unknown role fails closed
});

test("calendar scoping: the default calendar belongs to the owner only", () => {
  assert.equal(T.calendarFor(OWNER), "owner-calendar@example.com");
  assert.equal(T.calendarFor("+1 (555) 010-0001"), "owner-calendar@example.com"); // digits-only compare
  assert.equal(T.calendarFor(CAROL), ""); // a member with no mapping gets NO calendar
  assert.equal(T.calendarFor(EVE), "eve@example.com");
  assert.equal(T.calendarFor("15550109999"), "");
  assert.equal(T.tzFor(EVE), "Europe/London");
});

test("an unmapped member stays in DRY-RUN and never touches the owner's calendar", async () => {
  const cal = fakeCalendar([{ calId: "owner-calendar@example.com", id: "x", summary: "Board meeting", status: "confirmed",
    start: { dateTime: "2026-07-13T09:00:00Z" }, end: { dateTime: "2026-07-13T10:00:00Z" } }]);
  const deps = { cal, now: new Date("2026-07-13T00:00:00Z") };
  assert.equal(assistantLive(CAROL, deps), false);
  assert.equal(assistantLive(OWNER, deps), true);
  const interpret = async () => ({ action: { type: "list", rangeStart: "2026-07-13" }, reply: "Here you go" });
  const reply = await handleAssistant(CAROL, "what's on today?", { ...deps, interpret });
  assert.match(reply, /DRY-RUN/);
  assert.doesNotMatch(reply, /Board meeting/);
  const cancel = async () => ({ action: { type: "cancel", matchText: "board" } });
  assert.match(await handleAssistant(CAROL, "cancel the board meeting", { ...deps, interpret: cancel }), /DRY-RUN/);
  assert.equal(cal.calls.length, 0);
  assert.equal(cal.events[0].status, "confirmed");
  assert.match(await handleAssistant(OWNER, "what's on today?", { ...deps, interpret }), /Board meeting/);
});

test("console routing and role gates", () => {
  assert.deepEqual(route("15550109999", "/@assistant"), { kind: "ignore" });
  assert.match(route(BOB, "/@assistant").text, /isn't enabled/);
  assert.match(route(BOB, "/@sales").text, /Sales mode/);
  assert.deepEqual(route(BOB, "Kopi Senja wants a consult"), { kind: "sales" });
  assert.match(route(BOB, "/@help").text, /\/@sales/);
  assert.doesNotMatch(route(BOB, "/@help").text, /\/@assistant/);
  assert.match(route(BOB, "/@exit").text, /Left/);
  assert.match(route(BOB, "hello").text, /Commands/); // no mode → help
  assert.match(route(DAVE, "/@sales").text, /isn't enabled/);
  assert.match(route(OWNER, "/@asisten").text, /Connected to your calendar|DRY-RUN/);
  assert.deepEqual(route(OWNER, "book lunch"), { kind: "assistant" });
});

test("a mode is dropped when the role loses access mid-mode", () => {
  route(CAROL, "/@assistant");
  assert.deepEqual(route(CAROL, "hi"), { kind: "assistant" });
  process.env.TEAM = JSON.stringify({ ...JSON.parse(process.env.TEAM), [CAROL]: { name: "Carol", role: "sales" } });
  assert.match(route(CAROL, "hi").text, /isn't enabled/);
  assert.match(route(CAROL, "hi").text, /Commands/); // mode is gone
});
