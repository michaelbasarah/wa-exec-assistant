/**
 * One WhatsApp number, several "brains". A member texts /@assistant or /@sales to switch mode;
 * every later message goes to that mode until /@exit. The mode is stored in SQLite so a restart
 * doesn't drop anyone out of it. Non-members get no reply at all.
 *
 * Returns { kind: "ignore" } | { kind: "text", text } | { kind: "assistant" | "sales" }.
 */
import { member, canUse, allowedConsoles, CONSOLES } from "./team.mjs";
import { saveMode, loadMode, clearMode, clearSalesState } from "./store.mjs";
import { assistantGreeting, clearAssistant } from "./assistant.mjs";
import { salesGreeting } from "./sales.mjs";

const HELP = {
  assistant: "/@assistant: your calendar, tasks, notes and reminders",
  sales: "/@sales: log lead updates to the sales sheet",
};
const help = (from) => ["🛠 *Commands*", ...allowedConsoles(from).map((c) => HELP[c]), "/@exit: leave the current mode", "/@help: this list"].join("\n");
const denied = (c) => `⛔ /@${c} isn't enabled for your role. /@help shows what you can use.`;

function leave(from) {
  clearMode(from);
  clearAssistant(from);
  clearSalesState(from);
}

export function route(from, text = "", deps = {}) {
  if (!member(from)) return { kind: "ignore" };
  const cmd = String(text).trim().match(/^\/@\s*(\w+)/i)?.[1]?.toLowerCase();
  if (cmd) {
    const wants = cmd === "asisten" ? "assistant" : cmd;
    if (CONSOLES.includes(wants)) {
      if (!canUse(from, wants)) return { kind: "text", text: denied(wants) };
      leave(from);
      saveMode(from, wants);
      return { kind: "text", text: wants === "assistant" ? assistantGreeting(from, deps) : salesGreeting() };
    }
    if (cmd === "exit" || cmd === "stop") { leave(from); return { kind: "text", text: "↩️ Left the mode. /@help for commands." }; }
    if (cmd === "help" || cmd === "menu") return { kind: "text", text: help(from) };
    return { kind: "text", text: `❓ Unknown command /@${cmd}.\n\n${help(from)}` };
  }
  const mode = loadMode(from);
  if (!mode) return { kind: "text", text: help(from) };
  if (!canUse(from, mode)) { // access was removed while they were in the mode
    leave(from);
    return { kind: "text", text: denied(mode) };
  }
  return { kind: mode };
}
