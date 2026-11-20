import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePing } from "./api/telemetry.ts";

const valid = {
  id: "a".repeat(32),
  v: "0.5.8",
  hv: "0.2.1",
  kind: "web",
  region: "global",
};

test("accepts a complete ping", () => {
  assert.deepEqual(validatePing(valid), valid);
});

test("accepts a null host version", () => {
  assert.deepEqual(validatePing({ ...valid, hv: null }), { ...valid, hv: null });
});

test("rejects malformed pings", () => {
  const bad = [
    null,
    [],
    "ping",
    { ...valid, id: "not-a-hex-id" },
    { ...valid, id: "A".repeat(32) },
    { ...valid, v: "" },
    { ...valid, hv: "0.2.1 extra" },
    { ...valid, kind: "cli" },
    { ...valid, region: "Global" },
  ];
  for (const value of bad) assert.equal(validatePing(value), null);
});
