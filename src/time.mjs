/**
 * Timezone helpers, network-free. The model and the user think in naive local wall-clock strings
 * ("2026-07-08T15:00"); Google Calendar takes that string plus a timeZone. These convert between a
 * naive local time in `zone` and an absolute instant, using only Intl (DST-correct, no library).
 */
function partsIn(zone, at) {
  const p = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, hour12: false, weekday: "long",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at)) p[part.type] = part.value;
  if (p.hour === "24") p.hour = "00"; // some ICU builds render midnight as 24
  return p;
}

/** "Now" in `zone`, so the model can resolve "tomorrow 3pm". */
export function nowInZone(zone, at = new Date()) {
  const p = partsIn(zone, at);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday, zone };
}

/** Naive local "YYYY-MM-DDTHH:MM" (or a bare date = midnight) in `zone` → absolute Date. */
export function naiveToInstant(naive, zone) {
  const s = String(naive).length === 10 ? `${naive}T00:00` : String(naive).slice(0, 16);
  const guess = new Date(`${s}:00Z`);
  const p = partsIn(zone, guess);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guess.getTime() - (asUTC - guess.getTime()));
}

/** Absolute Date → naive local "YYYY-MM-DDTHH:MM" in `zone`. */
export function instantToNaive(date, zone) {
  const p = partsIn(zone, date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Naive start + real elapsed minutes → naive end "YYYY-MM-DDTHH:MM:00" (DST-correct). */
export function addMinutesInTz(naive, minutes, zone) {
  return `${instantToNaive(new Date(naiveToInstant(naive, zone).getTime() + minutes * 60_000), zone)}:00`;
}

/** Whole minutes between two event dateTimes, or null. */
export function durationMinutes(startDt, endDt) {
  const ms = Date.parse(endDt) - Date.parse(startDt);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : null;
}

/** RFC3339 [start of first day, end of last day] in `zone`. */
export function dayRange(startDate, endDate = startDate, zone) {
  const d0 = String(startDate).slice(0, 10), d1 = String(endDate).slice(0, 10);
  return { timeMin: naiveToInstant(`${d0}T00:00`, zone).toISOString(), timeMax: naiveToInstant(`${d1}T23:59`, zone).toISOString() };
}

export const isValidNaive = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(s || ""));

/** "YYYY-MM-DD" + n days. */
export function addDays(date, n) {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Mon 13 Jul, 14:00" from a naive local time. */
export function fmtWhen(naive, zone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(naiveToInstant(String(naive).slice(0, 16), zone)).replace(/,(?= \d+ \w+,)/, "");
}

/** Same, from a Calendar event (timed or all-day). */
export function fmtEventWhen(ev, zone) {
  if (ev?.start?.dateTime) return fmtWhen(instantToNaive(new Date(ev.start.dateTime), zone), zone);
  if (!ev?.start?.date) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
    .format(new Date(`${ev.start.date}T00:00:00Z`)).replace(",", "");
}
