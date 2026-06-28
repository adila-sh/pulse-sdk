// PulseClient — the public SDK surface. Orchestrates the event queue, the span
// queue, identity management and feature flags. Isomorphic: in the browser it
// persists an anonymous distinctId and flushes on page hide; in Node it keeps
// identity in memory and relies on explicit flush/shutdown.
import { createStore, generateId, isBrowser, resolveFetch } from "./env";
import type { KeyValueStore } from "./env";
import { FlagsClient, LocalFlagsClient } from "./flags";
import type { FlagEvaluator, FlagQueryOptions } from "./flags";
import { FlushQueue } from "./queue";
import { Transport } from "./transport";
import type {
  CaptureOptions,
  EvaluatedFlags,
  FlagValue,
  IngestSpan,
  PulseConfig,
  PulseEvent,
  ReplayChunk,
} from "./types";
import { LIB_NAME, VERSION } from "./version";

const DEFAULT_HOST = "https://api-pulse.adila.co";
const DEFAULT_FLUSH_AT = 20;
const DEFAULT_FLUSH_INTERVAL = 10_000;
const DEFAULT_ENVIRONMENT = "production";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const DISTINCT_ID_KEY = "pulse_distinct_id";
const IDENTIFY_EVENT = "$identify";

const toIso = (timestamp?: Date | string): string | undefined => {
  if (timestamp === undefined) return undefined;
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
};

export class PulseClient {
  private readonly store: KeyValueStore;
  private readonly transport: Transport;
  private readonly events: FlushQueue<PulseEvent>;
  private readonly spans: FlushQueue<IngestSpan>;
  private readonly flagsClient: FlagEvaluator;

  private distinctId: string;
  /** Whether the current distinctId came from identify() (vs. an anonymous id). */
  private identified = false;

  constructor(private readonly config: PulseConfig) {
    if (!config.apiKey) throw new Error("pulse-js: `apiKey` is required.");

    this.store = createStore(config.persistence);
    this.transport = new Transport({
      apiKey: config.apiKey,
      host: config.host ?? DEFAULT_HOST,
      fetchImpl: resolveFetch(config.fetch),
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      timeoutMs: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      debug: config.debug,
    });

    const flushAt = config.flushAt ?? DEFAULT_FLUSH_AT;
    const flushInterval = config.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.events = new FlushQueue<PulseEvent>({
      flushAt,
      flushInterval,
      label: "events",
      debug: config.debug,
      send: (batch) => this.transport.post("/events/batch", { events: batch }),
    });
    this.spans = new FlushQueue<IngestSpan>({
      flushAt,
      flushInterval,
      label: "spans",
      debug: config.debug,
      send: (batch) => this.transport.post("/traces/batch", { spans: batch }),
    });

    const environment = config.environment ?? DEFAULT_ENVIRONMENT;
    this.flagsClient =
      config.flags === "local"
        ? new LocalFlagsClient(this.transport, environment)
        : new FlagsClient(this.transport, environment);

    this.distinctId = this.resolveInitialDistinctId();
    this.installBrowserFlushHooks();
  }

  /** The id all capture/flag calls default to, until `identify` replaces it. */
  getDistinctId(): string {
    return this.distinctId;
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  /** Enqueue an analytics event. `properties` and overrides are optional. */
  capture(name: string, options: CaptureOptions = {}): void {
    const event: PulseEvent = {
      name,
      distinctId: options.distinctId ?? this.distinctId,
      properties: {
        $lib: LIB_NAME,
        $lib_version: VERSION,
        ...options.properties,
      },
      ...(toIso(options.timestamp) ? { timestamp: toIso(options.timestamp) } : {}),
      ...(options.set ? { set: options.set } : {}),
    };
    this.events.enqueue(event);
  }

  /** Capture a `pageview` from `window.location` (browser only, no-op in Node). */
  capturePageview(extra?: Record<string, unknown>): void {
    if (!isBrowser()) return;
    const { href, pathname } = window.location;
    this.capture("pageview", {
      properties: { url: href, path: pathname, ...extra },
    });
  }

  // ── Identity ─────────────────────────────────────────────────────────────

  /** Promote the current (anonymous) user to a known id, aliasing prior anonymous
   * activity so it resolves to the same person. `personProperties` is merged
   * server-side (last-write-wins). */
  identify(distinctId: string, personProperties?: Record<string, unknown>): void {
    const previous = this.distinctId;
    const wasAnonymous = !this.identified;

    const event: PulseEvent = {
      name: IDENTIFY_EVENT,
      distinctId,
      properties: { $lib: LIB_NAME, $lib_version: VERSION },
      ...(personProperties ? { set: personProperties } : {}),
      // Only alias when leaving an anonymous identity, and only if it changed.
      ...(wasAnonymous && previous !== distinctId ? { anonId: previous } : {}),
    };
    this.events.enqueue(event);

    this.distinctId = distinctId;
    this.identified = true;
    this.persistDistinctId(distinctId);
    // Cached flag verdicts were keyed to the old id; they no longer apply.
    this.flagsClient.clear(previous);
  }

  /** Explicitly alias an anonymous id into the current identity. */
  alias(anonId: string): void {
    this.events.enqueue({
      name: IDENTIFY_EVENT,
      distinctId: this.distinctId,
      properties: { $lib: LIB_NAME, $lib_version: VERSION },
      anonId,
    });
  }

  /** Forget the identified user and start a fresh anonymous session. Call on logout. */
  reset(): void {
    const fresh = generateId();
    this.distinctId = fresh;
    this.identified = false;
    this.persistDistinctId(fresh);
    this.flagsClient.clear();
  }

  // ── Feature flags ────────────────────────────────────────────────────────

  isFeatureEnabled(key: string, options?: FlagQueryOptions): Promise<boolean> {
    return this.flagsClient.isEnabled(key, this.distinctId, options);
  }

  getFeatureFlag(key: string, options?: FlagQueryOptions): Promise<FlagValue> {
    return this.flagsClient.getValue(key, this.distinctId, options);
  }

  getAllFlags(options?: FlagQueryOptions): Promise<EvaluatedFlags> {
    return this.flagsClient.getAll(this.distinctId, options);
  }

  reloadFlags(): Promise<EvaluatedFlags> {
    return this.flagsClient.getAll(this.distinctId, { reload: true });
  }

  // ── Tracing & replay ─────────────────────────────────────────────────────

  /** Enqueue a span for `POST /traces/batch`. */
  captureSpan(span: IngestSpan): void {
    this.spans.enqueue(span);
  }

  /** Send one rrweb chunk immediately (replay chunks are large — not batched).
   * Defaults `distinctId`/`lib` from the client when the caller omits them. */
  captureReplayChunk(chunk: ReplayChunk): Promise<void> {
    return this.transport.post("/replay", {
      ...chunk,
      distinctId: chunk.distinctId ?? this.distinctId,
      lib: chunk.lib ?? `${LIB_NAME}/${VERSION}`,
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Flush every buffered event and span now. */
  async flush(): Promise<void> {
    await Promise.all([this.events.flush(), this.spans.flush()]);
  }

  /** Flush and stop all timers. Call before a Node process exits. */
  async shutdown(): Promise<void> {
    await this.flush();
    this.events.stop();
    this.spans.stop();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private resolveInitialDistinctId(): string {
    if (this.config.distinctId) {
      this.identified = true;
      this.persistDistinctId(this.config.distinctId);
      return this.config.distinctId;
    }
    const stored = this.store.get(DISTINCT_ID_KEY);
    if (stored) return stored;
    const fresh = generateId();
    this.persistDistinctId(fresh);
    return fresh;
  }

  private persistDistinctId(id: string): void {
    this.store.set(DISTINCT_ID_KEY, id);
  }

  private installBrowserFlushHooks(): void {
    if (!isBrowser()) return;
    // `pagehide`/`visibilitychange` are the reliable "page is going away" signals;
    // a best-effort flush here avoids losing the tail of a session.
    const onHide = (): void => {
      void this.events.flush();
      void this.spans.flush();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("visibilitychange", () => {
      if (window.document.visibilityState === "hidden") onHide();
    });
  }
}
