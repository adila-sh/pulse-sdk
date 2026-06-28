import { describe, expect, test } from "bun:test";
import { FlushQueue } from "../src/queue";

describe("FlushQueue", () => {
  test("flushes automatically when the buffer reaches flushAt", async () => {
    const batches: number[][] = [];
    const q = new FlushQueue<number>({
      flushAt: 3,
      flushInterval: 100_000,
      send: async (items) => {
        batches.push(items);
      },
    });

    q.enqueue(1);
    q.enqueue(2);
    expect(batches.length).toBe(0); // below threshold
    q.enqueue(3); // hits flushAt -> auto flush
    await q.flush(); // await the in-flight flush

    expect(batches).toEqual([[1, 2, 3]]);
    expect(q.size()).toBe(0);
  });

  test("manual flush sends a partial batch", async () => {
    const batches: string[][] = [];
    const q = new FlushQueue<string>({
      flushAt: 100,
      flushInterval: 100_000,
      send: async (items) => {
        batches.push(items);
      },
    });

    q.enqueue("a");
    q.enqueue("b");
    await q.flush();

    expect(batches).toEqual([["a", "b"]]);
  });

  test("re-queues the batch when send rejects (at-least-once)", async () => {
    let calls = 0;
    const sent: number[][] = [];
    const q = new FlushQueue<number>({
      flushAt: 100,
      flushInterval: 100_000,
      send: async (items) => {
        calls++;
        if (calls === 1) throw new Error("network down");
        sent.push(items);
      },
    });

    q.enqueue(1);
    q.enqueue(2);

    await q.flush(); // fails -> re-queued
    expect(q.size()).toBe(2);
    expect(sent.length).toBe(0);

    await q.flush(); // succeeds
    expect(sent).toEqual([[1, 2]]);
    expect(q.size()).toBe(0);
  });

  test("flush on an empty buffer is a no-op", async () => {
    let calls = 0;
    const q = new FlushQueue<number>({
      flushAt: 10,
      flushInterval: 100_000,
      send: async () => {
        calls++;
      },
    });
    await q.flush();
    expect(calls).toBe(0);
  });
});
