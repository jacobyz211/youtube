import fs from "node:fs";
const src = fs.readFileSync("index.js", "utf8");
const start = src.indexOf("const CLIENT_COOLDOWN_MS");
const anchor = src.indexOf("function clientCoolingDown(name)");
const rest = src.slice(anchor);
const closeAt = rest.indexOf("\n}");
const block = src.slice(start, anchor + closeAt + 2);
if (!block.includes("noteClientFailure") || !block.includes("clientCoolingDown")) {
  throw new Error("extraction failed: " + JSON.stringify(block.slice(-80)));
}

const host = new Function(`${block}
let preferredClient = null;
return {
  noteClientFailure, noteClientSuccess, clientCoolingDown, clientBotBlocked,
  health: () => clientHealth,
  preferred: () => preferredClient,
  now: () => Date.now(),
};`);
const h = host();

const checks = [];
const ck = (name, cond) => checks.push([name, !!cond]);

ck("fresh client is healthy", !h.clientCoolingDown("VisionOS"));
ck("bot regex matches real reason", h.clientBotBlocked("iOS blocked: Sign in to confirm you're not a bot"));
ck("bot regex ignores network", !h.clientBotBlocked("request timed out"));

h.noteClientFailure("VisionOS", "HTTP 500");
ck("one ordinary failure does not park", !h.clientCoolingDown("VisionOS"));
h.noteClientFailure("VisionOS", "socket hang up");
ck("two ordinary failures park it", h.clientCoolingDown("VisionOS"));
const v = h.health().get("VisionOS");
const ttl = v.until - h.now();
ck("ordinary cooldown ~90s", ttl > 80_000 && ttl <= 90_000);

h.noteClientFailure("AndroidNative", "Sign in to confirm you're not a bot");
const b = h.health().get("AndroidNative");
ck("bot verdict parks immediately", h.clientCoolingDown("AndroidNative"));
ck("bot cooldown 5 min", b.until - h.now() > 290_000);

h.noteClientSuccess("AndroidNative");
ck("success clears cooldown", !h.clientCoolingDown("AndroidNative"));
ck("success sets sticky preference", h.preferred() === "AndroidNative");

h.health().get("VisionOS").until = Date.now() - 1;
ck("expired cooldown is healthy again", !h.clientCoolingDown("VisionOS"));

let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); }
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad ? 1 : 0);
