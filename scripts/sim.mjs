/**
 * Send a fake WhatsApp message to a running server: `npm start` in one terminal, then
 *   npm run sim -- "book lunch with Sam tomorrow 1pm"
 * Signs the body with WA_APP_SECRET when set (as Meta would). SIM_FROM picks the sender
 * (default: ASSISTANT_OWNER_NUMBER). With no WA_TOKEN the server logs its reply instead of sending.
 */
import { createHmac } from "node:crypto";

const text = process.argv.slice(2).join(" ") || "/@help";
const from = (process.env.SIM_FROM || process.env.ASSISTANT_OWNER_NUMBER || "15550100001").replace(/\D/g, "");
const body = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp",
    messages: [{ from, id: `wamid.sim.${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }],
});
const headers = { "Content-Type": "application/json" };
if (process.env.WA_APP_SECRET) headers["X-Hub-Signature-256"] = "sha256=" + createHmac("sha256", process.env.WA_APP_SECRET).update(body).digest("hex");
const resp = await fetch(`http://localhost:${process.env.PORT || 3000}/webhook`, { method: "POST", headers, body });
console.log(`sent "${text}" as ${from}: HTTP ${resp.status}${resp.status === 401 ? " (set WA_APP_SECRET here too, or ALLOW_UNSIGNED=1 on the server)" : ""}`);
