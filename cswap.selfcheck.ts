/**
 * rpiv-wfex cswap self-check — `node --import jiti/register cswap.selfcheck.ts`.
 * Assert-only tripwire for parseSwitchOutcome against the real cswap JSON shapes
 * (verified live: switch payload, switched:false/exhausted, { error } envelope).
 */
import { strict as assert } from "node:assert";
import { parseSwitchOutcome } from "./cswap.js";

// success: switched to another account
const ok = parseSwitchOutcome(JSON.stringify({ schemaVersion: 1, switched: true, to: { number: 3, email: "flex@datecs.bg" }, reason: "switched" }));
assert.equal(ok.switched, true, "switch payload → switched true");
assert.equal(ok.account, "3 (flex@datecs.bg)", "account label is 'number (email)'");

// already-active: from == to (switched false)
const same = parseSwitchOutcome(JSON.stringify({ switched: false, to: { number: 6, email: "x@y.z" }, reason: "already-active" }));
assert.equal(same.switched, false, "already-active → switched false");

// exhausted: every managed account at its limit
const ex = parseSwitchOutcome(JSON.stringify({ switched: false, to: { number: 6, email: "x@y.z" }, reason: "exhausted" }));
assert.equal(ex.switched, false, "exhausted → switched false");
assert.equal(ex.reason, "exhausted", "exhausted reason preserved");

// error envelope (e.g. no stored credentials) — cswap exits 0, body carries the error
const err = parseSwitchOutcome(JSON.stringify({ schemaVersion: 1, error: { type: "SwitchError", message: "Account-2 has no stored credentials." } }));
assert.equal(err.switched, false, "error envelope → switched false");
assert.equal(err.reason, "Account-2 has no stored credentials.", "error message surfaced as reason");

// switched:true without a 'to' block → no account label, still parses
const noTo = parseSwitchOutcome(JSON.stringify({ switched: true }));
assert.equal(noTo.switched, true, "switched true without 'to'");
assert.equal(noTo.account, undefined, "no 'to' → undefined account");

// non-JSON / empty → switched false, never throws
assert.equal(parseSwitchOutcome("not json").switched, false, "garbage → switched false");
assert.equal(parseSwitchOutcome("").switched, false, "empty → switched false");

console.log("cswap.selfcheck: OK");
