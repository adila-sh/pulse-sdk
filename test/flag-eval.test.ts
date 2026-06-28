import { describe, expect, test } from "bun:test";
import { assignVariant, evaluate, evaluateAll } from "../src/flag-eval";
import type { LocalFlag } from "../src/types";

// Parity vectors captured by running the BACKEND evaluator
// (back/src/lib/flag-eval.ts) with node:crypto. If the SDK's WebCrypto bucketing
// ever drifts from the server's, these break — which is exactly the point.
const NOW = 1_700_000_000_000;

describe("flag-eval parity with backend bucketing", () => {
  test("boolean rollout buckets users identically to the server", async () => {
    const flag: LocalFlag = { key: "simple-50", enabled: true, rolloutPct: 50 };
    // Backend buckets: u1,u2,u3,bob >= 50 (off); alice < 50 (on).
    expect((await evaluate(flag, { distinctId: "u1", now: NOW })).enabled).toBe(false);
    expect((await evaluate(flag, { distinctId: "u2", now: NOW })).enabled).toBe(false);
    expect((await evaluate(flag, { distinctId: "u3", now: NOW })).enabled).toBe(false);
    expect((await evaluate(flag, { distinctId: "alice", now: NOW })).enabled).toBe(true);
    expect((await evaluate(flag, { distinctId: "bob", now: NOW })).enabled).toBe(false);
  });

  test("rollout 100 is always on, kill-switch always off", async () => {
    const on: LocalFlag = { key: "always-on", enabled: true, rolloutPct: 100 };
    const killed: LocalFlag = { key: "killed", enabled: false, rolloutPct: 100 };
    for (const id of ["u1", "u2", "alice", "bob"]) {
      expect((await evaluate(on, { distinctId: id, now: NOW })).enabled).toBe(true);
      expect((await evaluate(killed, { distinctId: id, now: NOW })).enabled).toBe(false);
    }
  });

  test("scheduled release stays off until releaseAt passes", async () => {
    const flag: LocalFlag = {
      key: "scheduled",
      enabled: true,
      rolloutPct: 100,
      releaseAt: "2030-01-01T00:00:00Z",
    };
    expect((await evaluate(flag, { distinctId: "u1", now: NOW })).enabled).toBe(false);
    // After the instant passes it follows the rollout (100 -> on).
    const after = new Date("2030-01-02T00:00:00Z").getTime();
    expect((await evaluate(flag, { distinctId: "u1", now: after })).enabled).toBe(true);
  });

  test("filters gate eligibility (AND) before rollout", async () => {
    const flag: LocalFlag = {
      key: "gated",
      enabled: true,
      rolloutPct: 100,
      filters: [{ property: "plan", operator: "eq", value: "pro" }],
    };
    expect(
      (await evaluate(flag, { distinctId: "u1", properties: { plan: "pro" }, now: NOW }))
        .enabled,
    ).toBe(true);
    expect(
      (await evaluate(flag, { distinctId: "u1", properties: { plan: "free" }, now: NOW }))
        .enabled,
    ).toBe(false);
    // Missing property -> filter mismatch.
    expect((await evaluate(flag, { distinctId: "u1", now: NOW })).enabled).toBe(false);
  });

  test("multivariate assignment matches the server's variant buckets", async () => {
    const variants = [
      { key: "control", rolloutPct: 50 },
      { key: "treatment", rolloutPct: 50 },
    ];
    // Backend assignVariant("ab", ...): u1,u2 -> treatment; u3,alice,bob -> control.
    expect(await assignVariant("ab", variants, "u1")).toBe("treatment");
    expect(await assignVariant("ab", variants, "u2")).toBe("treatment");
    expect(await assignVariant("ab", variants, "u3")).toBe("control");
    expect(await assignVariant("ab", variants, "alice")).toBe("control");
    expect(await assignVariant("ab", variants, "bob")).toBe("control");
  });

  test("evaluate surfaces the assigned variant for a multivariate flag", async () => {
    const flag: LocalFlag = {
      key: "ab",
      enabled: true,
      rolloutPct: 100,
      variants: [
        { key: "control", rolloutPct: 50 },
        { key: "treatment", rolloutPct: 50 },
      ],
    };
    expect(await evaluate(flag, { distinctId: "u1", now: NOW })).toEqual({
      enabled: true,
      variant: "treatment",
    });
    expect(await evaluate(flag, { distinctId: "u3", now: NOW })).toEqual({
      enabled: true,
      variant: "control",
    });
  });

  test("a user outside the variant distribution gets the flag off", async () => {
    const flag: LocalFlag = {
      key: "ab",
      enabled: true,
      rolloutPct: 100,
      variants: [{ key: "control", rolloutPct: 10 }], // only 10% covered
    };
    // Backend "ab:variant" buckets: bob ~7.97 (< 10, in control) vs u3 ~24.5 (out).
    expect(await evaluate(flag, { distinctId: "bob", now: NOW })).toEqual({
      enabled: true,
      variant: "control",
    });
    expect((await evaluate(flag, { distinctId: "u3", now: NOW })).enabled).toBe(false);
  });

  test("evaluateAll returns the /decide-shaped map", async () => {
    const flags: LocalFlag[] = [
      { key: "always-on", enabled: true, rolloutPct: 100 },
      { key: "killed", enabled: false, rolloutPct: 100 },
    ];
    const result = await evaluateAll(flags, { distinctId: "u1", now: NOW });
    expect(result).toEqual({
      "always-on": { enabled: true },
      killed: { enabled: false },
    });
  });
});
