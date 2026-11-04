import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanField } from "../src/clean.mjs";

test("newlines, bidi overrides and markdown can't forge message structure", () => {
  assert.equal(cleanField("Lunch\n🔔 Your bank account is locked", 80), "Lunch 🔔 Your bank account is locked");
  assert.equal(cleanField("abc\u202edcba", 20), "abc dcba");
  assert.equal(cleanField("*urgent* _now_ ~x~ `y`", 40), "urgent now x y");
});

test("links are stripped unless kept", () => {
  assert.equal(cleanField("Sync, join at https://evil.example/login now", 80), "Sync, join at now");
  assert.equal(cleanField("pay at evil-site.com/x", 80), "pay at");
  assert.equal(cleanField("zoom https://zoom.example/j/1", 80, { keepLinks: true }), "zoom https://zoom.example/j/1");
});

test("length cap and empty input", () => {
  assert.equal(cleanField("x".repeat(100), 10), "x".repeat(10));
  assert.equal(cleanField(null), "");
});
