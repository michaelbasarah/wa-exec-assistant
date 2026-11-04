/** In-memory stand-ins for Google Calendar and the Sheet. Used by the tests and by `npm run demo`. */
export function fakeCalendar(events = []) {
  let n = 0;
  const cal = {
    events, // { calId, id, summary, start, end, status, recurringEventId }
    calls: [],
    async list(calId, { timeMin, timeMax } = {}) {
      cal.calls.push(["list", calId]);
      const t = (e) => Date.parse(e.start.dateTime || `${e.start.date}T00:00:00Z`);
      return events.filter((e) => e.calId === calId && e.status !== "cancelled"
        && (!timeMin || t(e) >= Date.parse(timeMin)) && (!timeMax || t(e) <= Date.parse(timeMax)))
        .sort((a, b) => t(a) - t(b));
    },
    async create(calId, body) {
      cal.calls.push(["create", calId]);
      // Treat the naive dateTime as already carrying the zone offset passed in by the test/demo.
      const off = cal.offset || "+00:00";
      const ev = { calId, id: `ev${++n}`, status: "confirmed", summary: body.summary,
        start: { dateTime: body.start.dateTime + off }, end: { dateTime: body.end.dateTime + off }, recurrence: body.recurrence };
      events.push(ev);
      return ev;
    },
    async patch(calId, id, body) {
      cal.calls.push(["patch", calId]);
      const ev = events.find((e) => e.calId === calId && e.id === id);
      const off = cal.offset || "+00:00";
      ev.start = { dateTime: body.start.dateTime + off };
      ev.end = { dateTime: body.end.dateTime + off };
      return ev;
    },
    async remove(calId, id) {
      cal.calls.push(["remove", calId]);
      for (const e of events) if (e.calId === calId && (e.id === id || e.recurringEventId === id)) e.status = "cancelled";
      return true;
    },
  };
  return cal;
}

export function fakeSheet(rows = []) {
  const data = rows.map((r) => ({ ...r }));
  return {
    data,
    async rows() { return data.map((r, i) => ({ rowNumber: i + 2, ...r })); },
    async put(rowNumber, fields) {
      if (rowNumber == null) data.push({ ...fields });
      else data[rowNumber - 2] = { ...fields };
    },
    async remove(rowNumber) { data.splice(rowNumber - 2, 1); },
  };
}
