import { describe, expect, test } from "bun:test";
import { LocalFlagsClient } from "../src/flags";
import { Transport } from "../src/transport";
import { mockFetch } from "./helpers";

const makeLocal = (fn: typeof fetch, environment = "production") =>
  new LocalFlagsClient(
    new Transport({
      apiKey: "pulse_test",
      host: "https://api.example.com",
      fetchImpl: fn,
      maxRetries: 0,
      timeoutMs: 5_000,
    }),
    environment,
  );

const PAYLOAD = {
  environment: "production",
  flags: [
    { key: "always-on", enabled: true, rolloutPct: 100 },
    { key: "killed", enabled: false, rolloutPct: 100 },
    {
      key: "pro-only",
      enabled: true,
      rolloutPct: 100,
      filters: [{ property: "plan", operator: "eq", value: "pro" }],
    },
  ],
};

describe("LocalFlagsClient", () => {
  test("fetches definitions from /flags/local-evaluation with the environment", async () => {
    const { fn, calls } = mockFetch(() => ({ body: PAYLOAD }));
    const flags = makeLocal(fn, "staging");

    expect(await flags.isEnabled("always-on", "u1")).toBe(true);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/flags/local-evaluation");
    expect(calls[0]?.url).toContain("environment=staging");
  });

  test("loads definitions exactly once, then evaluates everyone locally", async () => {
    const { fn, calls } = mockFetch(() => ({ body: PAYLOAD }));
    const flags = makeLocal(fn);

    await flags.getAll("u1");
    await flags.getAll("u2");
    await flags.isEnabled("killed", "u3");
    // One network round-trip total — bucketing for u1/u2/u3 is in-process.
    expect(calls.length).toBe(1);
  });

  test("dedups concurrent definition loads into a single request", async () => {
    const { fn, calls } = mockFetch(() => ({ body: PAYLOAD }));
    const flags = makeLocal(fn);

    await Promise.all([flags.getAll("a"), flags.getAll("b"), flags.getAll("c")]);
    expect(calls.length).toBe(1);
  });

  test("evaluates filters against per-call properties", async () => {
    const { fn } = mockFetch(() => ({ body: PAYLOAD }));
    const flags = makeLocal(fn);

    expect(await flags.isEnabled("pro-only", "u1", { properties: { plan: "pro" } })).toBe(
      true,
    );
    expect(
      await flags.isEnabled("pro-only", "u1", { properties: { plan: "free" } }),
    ).toBe(false);
  });

  test("reload refetches the definitions", async () => {
    const { fn, calls } = mockFetch(() => ({ body: PAYLOAD }));
    const flags = makeLocal(fn);

    await flags.getAll("u1");
    await flags.getAll("u1", { reload: true });
    expect(calls.length).toBe(2);
  });

  test("killed flags evaluate off, unknown flags are not enabled", async () => {
    const { fn } = mockFetch(() => ({ body: PAYLOAD }));
    const flags = makeLocal(fn);

    expect(await flags.isEnabled("killed", "u1")).toBe(false);
    expect(await flags.isEnabled("ghost", "u1")).toBe(false);
  });
});
