// Pure feature-flag evaluation — a faithful port of the backend's
// `src/lib/flag-eval.ts`. The bucketing MUST stay byte-for-byte identical to the
// server so a user lands in the same bucket whether the flag is resolved locally
// or via `/decide`: SHA-256 of `${salt}:${distinctId}`, first 13 hex digits
// (52 bits) divided by 2^52, scaled to [0, 100).
//
// Hashing uses WebCrypto (`crypto.subtle`), available in browsers, Node 18+, and
// Bun. Because `subtle.digest` is async, evaluation is async too.
import type {
  EvaluatedFlag,
  EvaluatedFlags,
  FlagFilter,
  FlagVariant,
  LocalFlag,
} from "./types";

export interface EvalContext {
  distinctId: string;
  properties?: Record<string, unknown>;
  /** Evaluation instant in epoch millis. Defaults to `Date.now()`; inject it to
   * make scheduled-release evaluation deterministic in tests. */
  now?: number;
}

// 13 hex digits = 52 bits, the largest power-of-two space within
// Number.MAX_SAFE_INTEGER. Dividing by 2^52 maps the hash to [0, 100).
const BUCKET_SPACE = 2 ** 52;

const getSubtle = (): SubtleCrypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new Error(
      "pulse-js: WebCrypto (crypto.subtle) is unavailable — local flag " +
        "evaluation needs a browser, Node 18+, or Bun. Use flags: 'remote' instead.",
    );
  }
  return c.subtle;
};

const sha256Hex = async (input: string): Promise<string> => {
  const bytes = new TextEncoder().encode(input);
  const digest = await getSubtle().digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, "0");
  }
  return hex;
};

const hashBucket = async (salt: string, distinctId: string): Promise<number> => {
  const hex = (await sha256Hex(`${salt}:${distinctId}`)).slice(0, 13);
  return (parseInt(hex, 16) / BUCKET_SPACE) * 100;
};

/**
 * Map a user to a multivariate variant by cumulative rollout, or null when the
 * user falls outside the variant distribution (or there are no variants). Salt
 * matches the backend exactly: `${flagKey}:variant`.
 */
export const assignVariant = async (
  flagKey: string,
  variants: FlagVariant[],
  distinctId: string,
): Promise<string | null> => {
  if (variants.length === 0) return null;
  const bucket = await hashBucket(`${flagKey}:variant`, distinctId);
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.rolloutPct;
    if (bucket < cumulative) return variant.key;
  }
  return null;
};

// Normalize a releaseAt value to epoch millis, or null when unset/invalid.
const toEpochMs = (value: LocalFlag["releaseAt"]): number | null => {
  if (value == null) return null;
  const ms = typeof value === "number" ? value : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};

const matchesFilter = (filter: FlagFilter, actual: unknown): boolean => {
  switch (filter.operator) {
    case "eq":
      return actual === filter.value;
    case "neq":
      return actual !== filter.value;
    case "in":
      return Array.isArray(filter.value) && filter.value.includes(actual);
    case "contains":
      return (
        typeof actual === "string" &&
        typeof filter.value === "string" &&
        actual.includes(filter.value)
      );
    default:
      return false;
  }
};

// All filters must match (logical AND).
const matchesAllFilters = (
  filters: FlagFilter[],
  properties: Record<string, unknown>,
): boolean =>
  filters.every((filter) => matchesFilter(filter, properties[filter.property]));

/**
 * Evaluate one flag for a user. Resolution order mirrors the backend:
 * kill-switch (`enabled`) → scheduled release (`releaseAt`) → filters (AND) →
 * variants (multivariate) or rollout (boolean).
 */
export const evaluate = async (
  flag: LocalFlag,
  context: EvalContext,
): Promise<EvaluatedFlag> => {
  // Manual kill switch wins over everything.
  if (!flag.enabled) return { enabled: false };

  // Scheduled release: not live until releaseAt passes.
  const releaseMs = toEpochMs(flag.releaseAt);
  if (releaseMs !== null && (context.now ?? Date.now()) < releaseMs) {
    return { enabled: false };
  }

  const properties = context.properties ?? {};
  const filters = flag.filters ?? [];
  if (filters.length > 0 && !matchesAllFilters(filters, properties)) {
    return { enabled: false };
  }

  const variants = flag.variants ?? [];
  if (variants.length > 0) {
    const variant = await assignVariant(flag.key, variants, context.distinctId);
    return variant ? { enabled: true, variant } : { enabled: false };
  }

  const bucket = await hashBucket(flag.key, context.distinctId);
  return bucket < flag.rolloutPct ? { enabled: true } : { enabled: false };
};

/** Evaluate every flag for one user, returning the same `{ [key]: verdict }`
 * shape the `/decide` endpoint produces. */
export const evaluateAll = async (
  flags: LocalFlag[],
  context: EvalContext,
): Promise<EvaluatedFlags> => {
  const entries = await Promise.all(
    flags.map(async (flag) => [flag.key, await evaluate(flag, context)] as const),
  );
  return Object.fromEntries(entries);
};
