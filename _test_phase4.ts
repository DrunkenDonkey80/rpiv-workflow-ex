import { strict as assert } from "node:assert";
import { messagesText, parseResetDelayMs } from "./ratelimit.js";

const seconds = parseResetDelayMs("600");
const httpDate = parseResetDelayMs("Mon, 29 Jun 2026 18:00:00 GMT", new Date("2026-06-29T17:00:00Z"));

assert.equal(seconds, 600_000);
assert.equal(httpDate, 3_600_000);
assert.ok((parseResetDelayMs("usage limit resets 7:30pm (UTC)", new Date("2026-06-29T17:00:00Z")) ?? 0) > 0);
assert.equal(messagesText([{ content: [{ text: "usage" }, { text: "limit" }] }]), "usage\nlimit");

console.log(seconds);
console.log(httpDate);
console.log("_test_phase4: OK");
