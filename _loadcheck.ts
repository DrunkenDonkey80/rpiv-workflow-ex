import { strict as assert } from "node:assert";
import "./autonomy.js";
import "./commands.js";
import "./extension.js";
import "./ratelimit.js";
import { __resetWfexState, getAutoMode } from "./state.js";

__resetWfexState();
assert.equal(getAutoMode(), "off");
console.log("off");
console.log("ok");
