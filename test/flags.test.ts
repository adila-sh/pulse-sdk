import { describe, expect, test } from "bun:test";
import { FlagsClient } from "../src/flags";
import { Transport } from "../src/transport";
import { mockFetch } from "./helpers";

const makeFlags = (fn: typeof fetch, environment = "production") =>
  new FlagsClient(
    new Transport({
      apiKey: "pulse_test",
      host: "https://api.example.com",
      fetchImpl: fn,
      maxRetries: 0,
      timeoutMs: 5_000,
    }),
    environment,
  );

const DECIDE_BODY = {
  featureFlags: {
    "new-checkout": { enabled: true },
    "pricing-test": { enabled: true, variant: "b" },
    "off-flag": { enabled: false },
  },
};

describe("FlagsClient", () => {
  test("posts distinctId + environment to /decide and reads verdicts", async () => {
    const { fn, calls } = mockFetch(() => ({ body: DECIDE_BODY }));
    const flags = makeFlags(fn, "staging");

    expect(await flags.isEnabled("new-checkout", "u1")).toBe(true);
    expect(calls[0]?.path).toBe("/decide");
    expect(calls[0]?.body).toEqual({ distinctId: "u1", environment: "staging" });
  });

  test("caches per distinctId — a second read does not refetch", async () => {
    const { fn, calls } = mockFetch(() => ({ body: DECIDE_BODY }));
    const flags = makeFlags(fn);

    await flags.isEnabled("new-checkout", "u1");
    await flags.isEnabled("off-flag", "u1");
    expect(calls.length).toBe(1); // one /decide, served from cache after
  });

  test("reload bypasses the cache", async () => {
    const { fn, calls } = mockFetch(() => ({ body: DECIDE_BODY }));
    const flags = makeFlags(fn);

    await flags.getAll("u1");
    await flags.getAll("u1", { reload: true });
    expect(calls.length).toBe(2);
  });

  test("getValue returns the variant key, the boolean, or undefined", async () => {
    const { fn } = mockFetch(() => ({ body: DECIDE_BODY }));
    const flags = makeFlags(fn);

    expect(await flags.getValue("pricing-test", "u1")).toBe("b");
    expect(await flags.getValue("new-checkout", "u1")).toBe(true);
    expect(await flags.getValue("unknown", "u1")).toBeUndefined();
  });

  test("unknown flags are not enabled", async () => {
    const { fn } = mockFetch(() => ({ body: DECIDE_BODY }));
    const flags = makeFlags(fn);
    expect(await flags.isEnabled("does-not-exist", "u1")).toBe(false);
  });
});
