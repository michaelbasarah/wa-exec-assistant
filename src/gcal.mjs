/**
 * Google Calendar REST, through the shared service account (google.mjs). No googleapis package.
 * Each user shares their own calendar with the service account's client_email ("Make changes to
 * events"); see team.mjs for which calendar a user is allowed to drive.
 */
import { getAccessToken } from "./google.mjs";

const SCOPE = "https://www.googleapis.com/auth/calendar.events"; // events only, not ACLs/settings
const API = "https://www.googleapis.com/calendar/v3/calendars";

export const hasGoogleCreds = () =>
  !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE);

async function call(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await getAccessToken(SCOPE)}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === "DELETE" && (resp.ok || resp.status === 404 || resp.status === 410)) return true; // gone is gone
  if (!resp.ok) throw new Error(`Calendar ${method} failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

const events = (calId, id = "") => `${API}/${encodeURIComponent(calId)}/events${id ? "/" + encodeURIComponent(id) : ""}`;

/** The calendar interface the assistant uses. Tests and the demo pass an in-memory fake instead. */
export const calendar = {
  async list(calId, { timeMin, timeMax, maxResults = 20 } = {}) {
    const qs = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", maxResults: String(maxResults) });
    if (timeMin) qs.set("timeMin", timeMin);
    if (timeMax) qs.set("timeMax", timeMax);
    return (await call("GET", `${events(calId)}?${qs}`)).items || [];
  },
  create: (calId, body) => call("POST", events(calId), body),
  patch: (calId, id, body) => call("PATCH", events(calId, id), body),
  remove: (calId, id) => call("DELETE", events(calId, id)),
};
