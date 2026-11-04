process.env.DB_PATH = ":memory:";
process.env.ASSISTANT_OWNER_NUMBER = "15550100001";
process.env.WA_APP_SECRET = "test-secret";
process.env.WA_VERIFY_TOKEN = "verify-me";
delete process.env.WA_TOKEN;
delete process.env.ALLOW_UNSIGNED;

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { createHmac, generateKeyPairSync } = await import("node:crypto");
const W = await import("../src/whatsapp.mjs");
const { createApp, handleMessage } = await import("../src/server.mjs");

const payload = (from, msg) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [{ from, id: "wamid.1", ...msg }] } }] }] });
const sign = (raw) => "sha256=" + createHmac("sha256", "test-secret").update(raw).digest("hex");

test("signature check", () => {
  const raw = Buffer.from('{"a":1}');
  assert.ok(W.verifySignature(raw, sign(raw), "test-secret"));
  assert.ok(!W.verifySignature(raw, sign(Buffer.from('{"a":2}')), "test-secret"));
  assert.ok(!W.verifySignature(raw, "sha256=short", "test-secret"));
  assert.ok(!W.verifySignature(raw, undefined, "test-secret"));
  assert.ok(!W.verifySignature(raw, sign(raw), ""));
});

test("parseInbound flattens text, taps, voice and unsupported types", () => {
  const body = { entry: [{ changes: [{ value: { messages: [
    { from: "1", id: "a", type: "text", text: { body: "hi" } },
    { from: "1", id: "b", type: "interactive", interactive: { button_reply: { id: "x", title: "Yes" } } },
    { from: "1", id: "c", type: "audio", audio: { id: "m1", mime_type: "audio/ogg" } },
    { from: "1", id: "d", type: "reaction" },
    { from: "1", id: "e", type: "sticker" },
  ] } }] }] };
  assert.deepEqual(W.parseInbound(body), [
    { from: "1", id: "a", text: "hi" },
    { from: "1", id: "b", text: "Yes" },
    { from: "1", id: "c", text: "", audio: { id: "m1", mimeType: "audio/ogg" } },
    { from: "1", id: "e", text: "", unsupported: true },
  ]);
});

test("handleMessage: members get replies, strangers get silence", async () => {
  const sent = [];
  const send = async (to, t) => sent.push([to, t]);
  await handleMessage({ from: "15550109999", text: "/@help" }, { send });
  assert.equal(sent.length, 0);
  await handleMessage({ from: "15550100001", text: "/@help" }, { send });
  assert.match(sent[0][1], /\/@assistant/);
});

test("webhook server: verify handshake, signature gate, end to end", async () => {
  const sent = [];
  const server = createApp({ send: async (to, t) => sent.push([to, t]) }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await (await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`)).text(), "42");
    assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status, 403);
    const raw = JSON.stringify(payload("15550100001", { type: "text", text: { body: "/@help" } }));
    assert.equal((await fetch(`${base}/webhook`, { method: "POST", body: raw })).status, 401);
    assert.equal((await fetch(`${base}/webhook`, { method: "POST", body: raw, headers: { "x-hub-signature-256": sign("tampered") } })).status, 401);
    assert.equal((await fetch(`${base}/webhook`, { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } })).status, 200);
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent[0][0], "15550100001");
    assert.match(sent[0][1], /Commands/);
  } finally {
    server.close();
  }
});

test("sendText is DRY-RUN without creds", async () => {
  const log = console.log;
  console.log = () => {};
  try { assert.equal(await W.sendText("15550100001", "hi"), false); } finally { console.log = log; }
});

test("sheet REST: explicit row ranges, RAW input, next free row, delete by gid", async () => {
  process.env.SALES_SHEET_ID = "test-sheet";
  process.env.SALES_SHEET_TAB = "Leads";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "sa@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const { sheet, nextRow } = await import("../src/sheet.mjs");
  const values = [["Date", "Rep", "Business"], ["d", "r", "Kopi Senja"], ["", "", ""], ["d", "r", "Toko Maju"]];
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push([opts.method || "GET", decodeURIComponent(String(url)), opts.body]);
    if (String(url).includes("oauth2")) return Response.json({ access_token: "t", expires_in: 3600 });
    if (String(url).includes("?fields=")) return Response.json({ sheets: [{ properties: { sheetId: 0, title: "Other" } }, { properties: { sheetId: 7, title: "Leads" } }] });
    if (!opts.method) return Response.json({ values });
    return Response.json({});
  };
  try {
    assert.equal(nextRow(values), 3);
    assert.equal(nextRow([["h"]]), 2);
    assert.deepEqual((await sheet.rows()).map((r) => [r.rowNumber, r.business]), [[2, "Kopi Senja"], [4, "Toko Maju"]]);
    await sheet.put(null, { business: "New", status: "=HYPERLINK()" });
    const put = calls.find((c) => c[0] === "PUT");
    assert.match(put[1], /values\/'Leads'!A3:G3\?valueInputOption=RAW$/);
    assert.deepEqual(JSON.parse(put[2]).values[0], ["", "", "New", "", "", "=HYPERLINK()", ""]);
    await sheet.remove(4);
    const del = JSON.parse(calls.find((c) => c[1].endsWith(":batchUpdate"))[2]);
    assert.deepEqual(del.requests[0].deleteDimension.range, { sheetId: 7, dimension: "ROWS", startIndex: 3, endIndex: 4 });
  } finally {
    globalThis.fetch = real;
  }
});
