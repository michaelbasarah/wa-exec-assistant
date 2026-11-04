import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "../src/time.mjs";

const Z = "Asia/Jakarta"; // UTC+7, no DST: deterministic

test("naive local time ↔ instant", () => {
  assert.equal(T.naiveToInstant("2026-07-08T15:00", Z).toISOString(), "2026-07-08T08:00:00.000Z");
  assert.equal(T.instantToNaive(new Date("2026-07-08T08:00:00Z"), Z), "2026-07-08T15:00");
  assert.equal(T.naiveToInstant("2026-07-08", Z).toISOString(), "2026-07-07T17:00:00.000Z");
});

test("dayRange covers the whole local day", () => {
  assert.deepEqual(T.dayRange("2026-07-08", "2026-07-08", Z), { timeMin: "2026-07-07T17:00:00.000Z", timeMax: "2026-07-08T16:59:00.000Z" });
  assert.equal(T.dayRange("2026-07-08T09:00", "2026-07-08", Z).timeMin, "2026-07-07T17:00:00.000Z");
});

test("nowInZone", () => {
  assert.deepEqual(T.nowInZone(Z, new Date("2026-07-08T08:30:00Z")), { date: "2026-07-08", time: "15:30", weekday: "Wednesday", zone: Z });
});

test("addMinutesInTz is DST-correct", () => {
  assert.equal(T.addMinutesInTz("2026-07-08T15:00", 90, Z), "2026-07-08T16:30:00");
  // US spring-forward 2026-03-08 02:00 → 03:00: 60 real minutes after 01:30 is 03:30 wall-clock.
  assert.equal(T.addMinutesInTz("2026-03-08T01:30", 60, "America/New_York"), "2026-03-08T03:30:00");
});

test("formatting and small helpers", () => {
  assert.equal(T.fmtWhen("2026-07-13T14:00", Z), "Mon 13 Jul, 14:00");
  assert.equal(T.fmtEventWhen({ start: { dateTime: "2026-07-13T07:00:00Z" } }, Z), "Mon 13 Jul, 14:00");
  assert.equal(T.fmtEventWhen({ start: { date: "2026-07-13" } }, Z), "Mon 13 Jul");
  assert.equal(T.addDays("2026-07-20", 14), "2026-08-03");
  assert.equal(T.durationMinutes("2026-07-13T10:00:00Z", "2026-07-13T11:30:00Z"), 90);
  assert.ok(T.isValidNaive("2026-07-07T15:00"));
  for (const bad of ["", "2026-07-07", "2026-07-07T15:00Z+07:00/2026-07-07T15:45"]) assert.ok(!T.isValidNaive(bad));
});
