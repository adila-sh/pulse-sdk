import { describe, expect, test } from "bun:test";
import { PulseClient } from "../src/client";
import { mockFetch } from "./helpers";
import type { PulseConfig } from "../src/types";

const baseConfig = (fn: typeof fetch): PulseConfig => ({
  apiKey: "pulse_test",
  host: "https://api.example.com",
  fetch: fn,
  persistence: "memory",
  flushAt: 100, // high, so tests control flushing explicitly
  flushInterval: 100_000,
});

describe("PulseClient", () => {
  test("generates an anonymous distinctId when none is given", () => {
    const { fn } = mockFetch(() => ({ status: 200 }));
    const client = new PulseClient(baseConfig(fn));
    expect(client.getDistinctId()).toMatch(/[0-9a-f-]{36}/);
  });

  test("uses a seeded distinctId", () => {
    const { fn } = mockFetch(() => ({ status: 200 }));
    const client = new PulseClient({ ...baseConfig(fn), distinctId: "user-42" });
    expect(client.getDistinctId()).toBe("user-42");
  });

  test("capture buffers events and flush sends them to /events/batch", async () => {
    const { fn, calls } = mockFetch(() => ({ status: 204 }));
    const client = new PulseClient({ ...baseConfig(fn), distinctId: "u1" });

    client.capture("button_clicked", { properties: { plan: "pro" } });
    client.capture("page_scrolled");
    expect(calls.length).toBe(0); // nothing sent until flush

    await client.flush();

    expect(calls.length).toBe(1);
    expect(calls[0]?.path).toBe("/events/batch");
    const events = (calls[0]?.body as { events: Array<Record<string, unknown>> })
      .events;
    expect(events.length).toBe(2);
    expect(events[0]?.name).toBe("button_clicked");
    expect(events[0]?.distinctId).toBe("u1");
    expect((events[0]?.properties as Record<string, unknown>).plan).toBe("pro");
    expect((events[0]?.properties as Record<string, unknown>).$lib).toBe("pulse-js");
  });

  test("identify aliases the prior anonymous id and sets person properties", async () => {
    const { fn, calls } = mockFetch(() => ({ status: 204 }));
    const client = new PulseClient(baseConfig(fn));
    const anon = client.getDistinctId();

    client.identify("user-99", { email: "a@b.com" });
    await client.flush();

    const events = (calls[0]?.body as { events: Array<Record<string, unknown>> })
      .events;
    const identify = events[0];
    expect(identify?.name).toBe("$identify");
    expect(identify?.distinctId).toBe("user-99");
    expect(identify?.anonId).toBe(anon);
    expect(identify?.set).toEqual({ email: "a@b.com" });
    expect(client.getDistinctId()).toBe("user-99");
  });

  test("a second identify does not alias (no longer anonymous)", async () => {
    const { fn, calls } = mockFetch(() => ({ status: 204 }));
    const client = new PulseClient(baseConfig(fn));

    client.identify("user-1");
    client.identify("user-2");
    await client.flush();

    const events = (calls[0]?.body as { events: Array<Record<string, unknown>> })
      .events;
    expect(events[0]?.anonId).toBeDefined(); // first leaves anonymous
    expect(events[1]?.anonId).toBeUndefined(); // second is identified->identified
  });

  test("reset returns to a fresh anonymous id", () => {
    const { fn } = mockFetch(() => ({ status: 204 }));
    const client = new PulseClient(baseConfig(fn));
    client.identify("user-7");
    expect(client.getDistinctId()).toBe("user-7");
    client.reset();
    expect(client.getDistinctId()).not.toBe("user-7");
    expect(client.getDistinctId()).toMatch(/[0-9a-f-]{36}/);
  });

  test("captureSpan flushes to /traces/batch", async () => {
    const { fn, calls } = mockFetch(() => ({ status: 204 }));
    const client = new PulseClient({ ...baseConfig(fn), distinctId: "u1" });

    client.captureSpan({
      traceId: "t1",
      spanId: "s1",
      name: "GET /api",
      startTime: 1700000000000,
      durationMs: 12,
    });
    await client.flush();

    expect(calls[0]?.path).toBe("/traces/batch");
    const spans = (calls[0]?.body as { spans: unknown[] }).spans;
    expect(spans.length).toBe(1);
  });

  test("captureReplayChunk posts immediately with defaulted distinctId/lib", async () => {
    const { fn, calls } = mockFetch(() => ({ status: 204 }));
    const client = new PulseClient({ ...baseConfig(fn), distinctId: "u1" });

    await client.captureReplayChunk({
      sessionId: "sess-1",
      events: [{ type: 2, data: {}, timestamp: 1700000000000 }],
    });

    expect(calls[0]?.path).toBe("/replay");
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.sessionId).toBe("sess-1");
    expect(body.distinctId).toBe("u1");
    expect(String(body.lib)).toContain("pulse-js");
  });

  test("isFeatureEnabled evaluates via /decide for the current id", async () => {
    const { fn, calls } = mockFetch(() => ({
      body: { featureFlags: { beta: { enabled: true } } },
    }));
    const client = new PulseClient({ ...baseConfig(fn), distinctId: "u1" });

    expect(await client.isFeatureEnabled("beta")).toBe(true);
    expect(calls[0]?.path).toBe("/decide");
    expect(calls[0]?.body).toEqual({ distinctId: "u1", environment: "production" });
  });
});
