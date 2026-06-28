// Public entrypoint for @adila/pulse-js.
export { PulseClient } from "./client";
export { FlagsClient, LocalFlagsClient } from "./flags";
export type { FlagQueryOptions, FlagEvaluator } from "./flags";
export { evaluate, evaluateAll, assignVariant } from "./flag-eval";
export type { EvalContext } from "./flag-eval";
export { Transport, PulseApiError } from "./transport";
export { FlushQueue } from "./queue";
export type { QueueOptions } from "./queue";
export { VERSION, LIB_NAME } from "./version";
export type {
  PulseConfig,
  PulseEvent,
  CaptureOptions,
  EvaluatedFlag,
  EvaluatedFlags,
  DecideResponse,
  FlagValue,
  FlagMode,
  FlagFilter,
  FlagFilterOperator,
  FlagVariant,
  LocalFlag,
  LocalEvaluationPayload,
  IngestSpan,
  SpanKind,
  SpanStatus,
  RrwebEvent,
  ReplayChunk,
  PersistenceMode,
} from "./types";

import { PulseClient } from "./client";
import type { PulseConfig } from "./types";

/** Convenience factory mirroring the `new PulseClient(config)` constructor. */
export const createPulse = (config: PulseConfig): PulseClient =>
  new PulseClient(config);
