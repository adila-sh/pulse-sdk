// Wire types mirroring the Pulse API ingestion contract. Kept hand-written
// (rather than generated from OpenAPI) because the SDK only touches the small
// ingestion + decide surface, and a zero-dependency type file keeps the bundle
// lean. See the backend `docs/event-contract.md` for the authoritative spec.

/** One analytics event as accepted by `POST /events`. `projectId` is never sent —
 * the server derives it from the API key (anti-spoofing). */
export interface PulseEvent {
  name: string;
  distinctId: string;
  properties?: Record<string, unknown>;
  /** ISO-8601. Omit to let the server stamp ingestion time. */
  timestamp?: string;
  /** Person properties merged onto the resolved person (last-write-wins). */
  set?: Record<string, unknown>;
  /** identify-only: anonymous distinctId to alias into `distinctId`. */
  anonId?: string;
}

/** Per-call overrides for `capture`. When `distinctId` is omitted the client's
 * current (anonymous or identified) id is used. */
export interface CaptureOptions {
  distinctId?: string;
  properties?: Record<string, unknown>;
  timestamp?: Date | string;
  set?: Record<string, unknown>;
}

/** A flag verdict from `POST /decide`. */
export interface EvaluatedFlag {
  enabled: boolean;
  variant?: string;
}

export type EvaluatedFlags = Record<string, EvaluatedFlag>;

export interface DecideResponse {
  featureFlags: EvaluatedFlags;
}

/** How feature flags are resolved. `remote` calls `POST /decide` per user (good
 * for browsers — no flag definitions leak to the client). `local` fetches the
 * full flag definitions once via `GET /flags/local-evaluation` and buckets users
 * in-process (good for servers — zero network per evaluation). Default `remote`. */
export type FlagMode = "remote" | "local";

export type FlagFilterOperator = "eq" | "neq" | "in" | "contains";

/** A property predicate that gates flag eligibility (logical AND across filters). */
export interface FlagFilter {
  property: string;
  operator: FlagFilterOperator;
  value: unknown;
}

/** A multivariate variant with its cumulative rollout share (0-100). */
export interface FlagVariant {
  key: string;
  name?: string;
  rolloutPct: number;
}

/** A full flag definition as returned by `GET /flags/local-evaluation`, carrying
 * everything the SDK needs to bucket a user itself. `releaseAt` is ISO-8601 (or
 * epoch ms); null/absent means no scheduled release. */
export interface LocalFlag {
  key: string;
  enabled: boolean;
  rolloutPct: number;
  variants?: FlagVariant[] | null;
  filters?: FlagFilter[] | null;
  releaseAt?: string | number | null;
}

/** Response of `GET /flags/local-evaluation` — every flag for one environment. */
export interface LocalEvaluationPayload {
  environment: string;
  flags: LocalFlag[];
}

/** Convenience shape returned by `getFeatureFlag`: the variant key when the flag
 * is a multivariate, otherwise the boolean enabled state. `undefined` = unknown
 * flag. */
export type FlagValue = boolean | string | undefined;

export type SpanKind =
  | "client"
  | "server"
  | "internal"
  | "producer"
  | "consumer";

export type SpanStatus = "unset" | "ok" | "error";

/** One span as accepted by `POST /traces`. Times accept ISO-8601 or epoch ms. */
export interface IngestSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  service?: string;
  kind?: SpanKind;
  startTime: string | number;
  durationMs?: number;
  endTime?: string | number;
  status?: SpanStatus;
  statusMessage?: string;
  attributes?: Record<string, unknown>;
  distinctId?: string;
  sessionId?: string;
}

/** A single rrweb event, kept opaque (the player consumes the whole object). */
export interface RrwebEvent {
  type: number;
  data: unknown;
  timestamp: number;
}

/** One session-replay chunk as accepted by `POST /replay`. */
export interface ReplayChunk {
  sessionId: string;
  distinctId?: string;
  windowId?: string;
  events: RrwebEvent[];
  startTime?: string | number;
  lib?: string;
}

/** Where the SDK persists the anonymous distinctId between page loads. */
export type PersistenceMode = "localStorage" | "memory";

export interface PulseConfig {
  /** Project API key, shaped `pulse_<base64url>`. */
  apiKey: string;
  /** API origin. Defaults to the Adila Pulse production host. */
  host?: string;
  /** Flush the event buffer once it reaches this many events. Default 20. */
  flushAt?: number;
  /** Flush the event buffer at least this often (ms). Default 10_000. */
  flushInterval?: number;
  /** Flag environment used by `/decide` and `/flags/local-evaluation`. Default "production". */
  environment?: string;
  /** Flag resolution strategy: "remote" (per-user `/decide`) or "local"
   * (definitions fetched once, bucketed in-process). Default "remote". */
  flags?: FlagMode;
  /** Seed an identified distinctId instead of generating an anonymous one. */
  distinctId?: string;
  /** Anonymous-id persistence. Defaults to localStorage in the browser, memory in Node. */
  persistence?: PersistenceMode;
  /** Inject a custom fetch (tests, proxies, non-global runtimes). */
  fetch?: typeof fetch;
  /** Network retries for transient failures (429/5xx/network). Default 3. */
  maxRetries?: number;
  /** Per-request timeout (ms). Default 10_000. */
  requestTimeoutMs?: number;
  /** Log transport/queue diagnostics to console. Default false. */
  debug?: boolean;
}
