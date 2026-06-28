# @adila/pulse-js

Isomorphic (browser + Node) client SDK for the **Adila Pulse** API — analytics
events, feature flags, distributed tracing and session replay. Zero runtime
dependencies; authenticates with a project API key.

## Install

```bash
npm install @adila/pulse-js
# or: bun add @adila/pulse-js
```

## Quick start

```ts
import { PulseClient } from "@adila/pulse-js";

const pulse = new PulseClient({
  apiKey: "pulse_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  host: "https://api-pulse.adila.co", // default
});

// Capture an event (buffered + flushed in batches)
pulse.capture("button_clicked", { properties: { plan: "pro" } });

// Tie anonymous activity to a known user
pulse.identify("user_123", { email: "ada@example.com" });

// Feature flags (evaluated server-side via /decide, cached per user)
if (await pulse.isFeatureEnabled("new-checkout")) {
  // ...
}
const variant = await pulse.getFeatureFlag("pricing-test"); // "b" | true | undefined

// Node: flush before exit. Browser: auto-flushes on page hide.
await pulse.shutdown();
```

## Auth & projects

The SDK sends `Authorization: Bearer <apiKey>`. The **project is derived from
the key** server-side — you never pass a project id, and a key can only write to
its own project. Issue keys from the dashboard (`POST /api-keys`, shown once).

## Configuration

| Option             | Default                        | Description                                        |
| ------------------ | ------------------------------ | -------------------------------------------------- |
| `apiKey`           | — (required)                   | Project API key (`pulse_…`).                       |
| `host`             | `https://api-pulse.adila.co`   | API origin.                                        |
| `flushAt`          | `20`                           | Flush the event buffer at this many events.        |
| `flushInterval`    | `10000`                        | Flush at least this often (ms).                    |
| `environment`      | `production`                   | Flag environment for flag resolution.              |
| `flags`            | `remote`                       | Flag strategy: `remote` (`/decide`) or `local`.    |
| `distinctId`       | auto (anonymous)               | Seed an identified id instead of an anonymous one. |
| `persistence`      | `localStorage` (browser)       | Where the anonymous id is stored.                  |
| `fetch`            | global `fetch`                 | Inject a custom fetch (tests, proxies).            |
| `maxRetries`       | `3`                            | Retries for transient failures (429/5xx/network).  |
| `requestTimeoutMs` | `10000`                        | Per-request timeout.                               |
| `debug`            | `false`                        | Log transport/queue diagnostics.                   |

## Identity model

- A fresh client gets an **anonymous** distinctId (persisted in the browser).
- `identify(id, props)` promotes the user: it emits an `$identify` event whose
  `anonId` aliases the prior anonymous id (so earlier activity merges into the
  person) and whose `set` merges person properties (last-write-wins server-side).
- `alias(anonId)` links an extra anonymous id into the current identity.
- `reset()` (call on logout) starts a new anonymous session.

## Feature flags

```ts
await pulse.isFeatureEnabled("flag-key"); // boolean
await pulse.getFeatureFlag("flag-key"); // variant string | boolean | undefined
await pulse.getAllFlags(); // { [key]: { enabled, variant? } }
await pulse.reloadFlags(); // force-refresh the cache
```

Verdicts are cached per distinctId. Pass `{ reload: true }` to bypass the cache,
and `{ properties }` to supply person properties for filter matching.

### Remote vs local resolution

```ts
const pulse = new PulseClient({ apiKey, flags: "local" }); // default: "remote"
```

| Mode               | How                                                                | Best for                                                  |
| ------------------ | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `remote` (default) | One `POST /decide` per user; verdicts cached per distinctId.       | **Browsers** — no flag definitions are exposed to the client. |
| `local`            | Fetches every flag definition once via `GET /flags/local-evaluation`, then buckets users **in-process**. | **Servers** — zero network per evaluation, no per-user latency. |

Both modes are **bucket-identical**: the local evaluator is a faithful port of
the backend bucketing (SHA-256 of `${salt}:${distinctId}`, first 13 hex digits /
2^52 × 100), so a given user lands in the same bucket either way — verified
against parity vectors captured from the server. Local mode honours the same
rules as the server: kill-switch, scheduled release (`releaseAt`), property
filters (AND), boolean rollout, and multivariate variant assignment.

> **Heads-up:** `local` mode downloads full flag definitions (filters, rollout
> percentages, release schedules). That's fine server-side, but prefer `remote`
> in the browser so you don't ship targeting rules to end users.

Local evaluation uses WebCrypto (`crypto.subtle`) — available in browsers,
Node 18+, and Bun.

## Tracing

```ts
pulse.captureSpan({
  traceId: "abc",
  spanId: "def",
  name: "GET /api/users",
  service: "web",
  startTime: Date.now(), // ISO string or epoch ms
  durationMs: 42,
  status: "ok",
});
```

Spans are batched to `POST /traces/batch`. Times are **milliseconds** (the API
uses `DateTime64(3)` + `duration_ms`, not OTel nanoseconds).

## Session replay

Replay ingests native [rrweb](https://github.com/rrweb-io/rrweb) chunks. `rrweb`
is an optional peer dependency you wire up in the browser:

```ts
import { record } from "rrweb";

const buffer: any[] = [];
record({ emit: (event) => buffer.push(event) });

// Flush a chunk periodically
setInterval(() => {
  if (buffer.length === 0) return;
  void pulse.captureReplayChunk({
    sessionId: mySessionId,
    events: buffer.splice(0),
  });
}, 5000);
```

Privacy (masking inputs, blocking elements) is configured on the rrweb recorder
before events reach the SDK.

## Development

```bash
bun install
bun test          # unit tests
bun run typecheck # tsc --noEmit
bun run build     # emit dist/
```

## License

UNLICENSED — internal Adila project.
