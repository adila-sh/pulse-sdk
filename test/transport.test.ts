import { describe, expect, test } from "bun:test";
import { PulseApiError, Transport } from "../src/transport";
import { mockFetch } from "./helpers";

const makeTransport = (fn: typeof fetch, maxRetries = 3) =>
  new Transport({
    apiKey: "pulse_test",
    host: "https://api.example.com/",
    fetchImpl: fn,
    maxRetries,
    timeoutMs: 5_000,
  });

describe("Transport", () => {
  test("sends Bearer auth and parses a JSON response", async () => {
    const { fn, calls } = mockFetch(() => ({ body: { ok: true } }));
    const t = makeTransport(fn);

    const res = await t.post<{ ok: boolean }>("/events", { name: "x" });

    expect(res).toEqual({ ok: true });
    expect(calls[0]?.headers.authorization).toBe("Bearer pulse_test");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    // Host trailing slash collapsed, no double slash before the path.
    expect(calls[0]?.url).toBe("https://api.example.com/events");
    expect(calls[0]?.body).toEqual({ name: "x" });
  });

  test("retries on 503 then succeeds", async () => {
    const { fn, calls } = mockFetch((_call, attempt) =>
      attempt === 0 ? { status: 503 } : { body: { recovered: true } },
    );
    const t = makeTransport(fn);

    const res = await t.post<{ recovered: boolean }>("/events", {});
    expect(res).toEqual({ recovered: true });
    expect(calls.length).toBe(2);
  });

  test("does not retry a 401 and throws PulseApiError", async () => {
    const { fn, calls } = mockFetch(() => ({ status: 401, body: { error: "nope" } }));
    const t = makeTransport(fn);

    await expect(t.post("/events", {})).rejects.toBeInstanceOf(PulseApiError);
    expect(calls.length).toBe(1); // terminal, no retry
  });

  test("gives up after maxRetries on persistent 500", async () => {
    const { fn, calls } = mockFetch(() => ({ status: 500 }));
    const t = makeTransport(fn, 2);

    await expect(t.post("/events", {})).rejects.toBeInstanceOf(PulseApiError);
    expect(calls.length).toBe(3); // initial + 2 retries
  });
});
