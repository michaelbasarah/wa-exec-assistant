/**
 * The sales tracker: one Google Sheet tab, one row per lead, raw Sheets REST.
 *
 *   Date | Rep | Business | Vertical | Channel | Status | Notes      (columns A–G, header in row 1)
 *
 * Rows are written with values.update on an explicit A{n}:G{n} range, never values.append: append
 * guesses where "the table" starts and can land a row several columns to the right when a sparse
 * row sits above it. RAW input, so a cell starting with "=" stays text instead of becoming a formula.
 */
import { getAccessToken } from "./google.mjs";

export const COLS = ["date", "rep", "business", "vertical", "channel", "status", "notes"];
const sheetId = () => process.env.SALES_SHEET_ID || "";
const tab = () => process.env.SALES_SHEET_TAB || "";
const a1 = (range) => (tab() ? `'${tab().replace(/'/g, "''")}'!${range}` : range);

export const sheetConfigured = () => !!sheetId();

async function api(path, opts = {}) {
  const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId()}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) throw new Error(`Sheets ${opts.method || "GET"} failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

const readValues = async () => (await api(`/values/${encodeURIComponent(a1("A:G"))}`)).values || [];

/** First row (from 2 down) with an empty Business cell, else the row after the last one. */
export function nextRow(values) {
  for (let i = 1; i < values.length; i++) if (!String(values[i][2] ?? "").trim()) return i + 1;
  return Math.max(values.length, 1) + 1;
}

export const sheet = {
  /** Every lead row as { rowNumber, date, rep, business, ... }, skipping blank ones. */
  async rows() {
    return (await readValues())
      .map((r, i) => ({ rowNumber: i + 1, ...Object.fromEntries(COLS.map((c, j) => [c, r[j] ?? ""])) }))
      .slice(1)
      .filter((r) => r.business.trim());
  },
  /** Write a row in place; rowNumber null = the next free row. */
  async put(rowNumber, fields) {
    const n = rowNumber ?? nextRow(await readValues());
    await api(`/values/${encodeURIComponent(a1(`A${n}:G${n}`))}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [COLS.map((c) => fields[c] ?? "")] }),
    });
    return n;
  },
  /** Delete a whole row (rows below shift up). */
  async remove(rowNumber) {
    const { sheets = [] } = await api("?fields=sheets.properties(sheetId,title)");
    const target = tab() ? sheets.find((s) => s.properties?.title === tab()) : sheets[0];
    if (!target) throw new Error(`Sheet tab not found: ${tab() || "(first)"}`);
    await api(":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests: [{ deleteDimension: {
        range: { sheetId: target.properties.sheetId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber },
      } }] }),
    });
  },
};
