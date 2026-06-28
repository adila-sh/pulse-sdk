// Runtime detection and a tiny storage abstraction so the same client works in
// the browser (localStorage-backed anonymous id) and in Node (in-memory).
import type { PersistenceMode } from "./types";

export const isBrowser = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.document !== "undefined";

/** RFC-4122 v4 id. Uses crypto.randomUUID when available, else a non-crypto
 * fallback (good enough for an anonymous analytics id). */
export const generateId = (): string => {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const memoryStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v);
    },
  };
};

const localStorageStore = (): KeyValueStore => {
  // Wrapped in try/catch: localStorage throws in private-mode Safari and when
  // storage is disabled. Fall back to memory rather than crashing capture.
  try {
    const probe = "__pulse_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
  } catch {
    return memoryStore();
  }
  return {
    get: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* ignore quota / disabled storage */
      }
    },
  };
};

export const createStore = (mode?: PersistenceMode): KeyValueStore => {
  if (mode === "memory") return memoryStore();
  if (mode === "localStorage") return localStorageStore();
  return isBrowser() ? localStorageStore() : memoryStore();
};

/** Resolve a usable fetch: caller-provided, else the global. Throws early with a
 * clear message rather than failing deep in the transport on an old runtime. */
export const resolveFetch = (injected?: typeof fetch): typeof fetch => {
  const f = injected ?? globalThis.fetch;
  if (!f) {
    throw new Error(
      "pulse-js: no global fetch found. Pass `fetch` in the config or run on Node >=18.",
    );
  }
  return f.bind(globalThis);
};
