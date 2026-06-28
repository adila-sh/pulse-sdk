// Feature-flag resolution. Two interchangeable strategies share one interface:
//   - FlagsClient      — canonical `POST /decide`, one call per user (remote).
//   - LocalFlagsClient — `GET /flags/local-evaluation` once, then buckets users
//                        in-process via the backend-identical evaluator (local).
// Both cache verdicts per distinctId so repeated `isFeatureEnabled` calls in a
// render pass don't each recompute; pass `{ reload: true }` to refresh.
import { evaluateAll } from "./flag-eval";
import type { Transport } from "./transport";
import type {
  DecideResponse,
  EvaluatedFlags,
  FlagValue,
  LocalEvaluationPayload,
  LocalFlag,
} from "./types";

export interface FlagQueryOptions {
  /** Bypass the cache and re-resolve. For local mode this also refetches defs. */
  reload?: boolean;
  /** Person properties for filter matching (sent to `/decide`, or applied
   * locally). When provided, the result is not cached (it is context-specific). */
  properties?: Record<string, unknown>;
}

/** The surface PulseClient depends on, regardless of resolution strategy. */
export interface FlagEvaluator {
  getAll(distinctId: string, options?: FlagQueryOptions): Promise<EvaluatedFlags>;
  isEnabled(
    key: string,
    distinctId: string,
    options?: FlagQueryOptions,
  ): Promise<boolean>;
  getValue(
    key: string,
    distinctId: string,
    options?: FlagQueryOptions,
  ): Promise<FlagValue>;
  clear(distinctId?: string): void;
}

/** Shared `isEnabled`/`getValue` derived from `getAll`; subclasses supply
 * `getAll` and `clear`. */
abstract class BaseFlagEvaluator implements FlagEvaluator {
  abstract getAll(
    distinctId: string,
    options?: FlagQueryOptions,
  ): Promise<EvaluatedFlags>;
  abstract clear(distinctId?: string): void;

  /** True when the flag is enabled for the user. Unknown flags are `false`. */
  async isEnabled(
    key: string,
    distinctId: string,
    options?: FlagQueryOptions,
  ): Promise<boolean> {
    const flags = await this.getAll(distinctId, options);
    return flags[key]?.enabled ?? false;
  }

  /** The variant key for a multivariate flag, the boolean state for a simple
   * flag, or `undefined` when the flag is unknown. */
  async getValue(
    key: string,
    distinctId: string,
    options?: FlagQueryOptions,
  ): Promise<FlagValue> {
    const flags = await this.getAll(distinctId, options);
    const verdict = flags[key];
    if (!verdict) return undefined;
    return verdict.variant ?? verdict.enabled;
  }
}

/** Remote resolution: one `POST /decide` per user, verdict cached per distinctId. */
export class FlagsClient extends BaseFlagEvaluator {
  private readonly cache = new Map<string, EvaluatedFlags>();

  constructor(
    private readonly transport: Transport,
    private readonly environment: string,
  ) {
    super();
  }

  async getAll(
    distinctId: string,
    options: FlagQueryOptions = {},
  ): Promise<EvaluatedFlags> {
    if (!options.reload && !options.properties) {
      const cached = this.cache.get(distinctId);
      if (cached) return cached;
    }
    const res = await this.transport.post<DecideResponse>("/decide", {
      distinctId,
      environment: this.environment,
      ...(options.properties ? { properties: options.properties } : {}),
    });
    const flags = res.featureFlags ?? {};
    // Property-scoped verdicts aren't representative of the default user state.
    if (!options.properties) this.cache.set(distinctId, flags);
    return flags;
  }

  clear(distinctId?: string): void {
    if (distinctId) this.cache.delete(distinctId);
    else this.cache.clear();
  }
}

/** Local resolution: fetch full flag definitions once, bucket users in-process.
 * Definitions are cached and shared across all users; per-user verdicts are
 * cached too (unless `properties` are passed, which make them context-specific). */
export class LocalFlagsClient extends BaseFlagEvaluator {
  private readonly cache = new Map<string, EvaluatedFlags>();
  private definitions: LocalFlag[] | null = null;
  private inflight: Promise<LocalFlag[]> | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly environment: string,
  ) {
    super();
  }

  async getAll(
    distinctId: string,
    options: FlagQueryOptions = {},
  ): Promise<EvaluatedFlags> {
    const cacheable = !options.properties;
    if (cacheable && !options.reload) {
      const cached = this.cache.get(distinctId);
      if (cached) return cached;
    }
    const defs = await this.loadDefinitions(options.reload ?? false);
    const result = await evaluateAll(defs, {
      distinctId,
      ...(options.properties ? { properties: options.properties } : {}),
    });
    if (cacheable) this.cache.set(distinctId, result);
    return result;
  }

  clear(distinctId?: string): void {
    if (distinctId) this.cache.delete(distinctId);
    else this.cache.clear();
  }

  /** Drop cached flag definitions and verdicts, forcing a refetch next time. */
  refresh(): void {
    this.definitions = null;
    this.cache.clear();
  }

  // Fetch definitions once; concurrent callers share one in-flight request.
  private async loadDefinitions(reload: boolean): Promise<LocalFlag[]> {
    if (reload) {
      this.definitions = null;
      this.cache.clear();
    }
    if (this.definitions) return this.definitions;
    if (this.inflight) return this.inflight;

    const path = `/flags/local-evaluation?environment=${encodeURIComponent(
      this.environment,
    )}`;
    this.inflight = this.transport
      .get<LocalEvaluationPayload>(path)
      .then((payload) => {
        this.definitions = payload.flags ?? [];
        return this.definitions;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
