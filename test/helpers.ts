// A scriptable fetch double for transport/client tests. Records every call and
// lets the test decide the response per (method+path) attempt.
export interface FetchCall {
  url: string;
  path: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
}

type Handler = (call: FetchCall, attempt: number) => MockResponse;

export interface MockFetch {
  fn: typeof fetch;
  calls: FetchCall[];
}

export const mockFetch = (handler: Handler): MockFetch => {
  const calls: FetchCall[] = [];
  const attempts = new Map<string, number>();

  const fn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string" && rawBody.length > 0
        ? JSON.parse(rawBody)
        : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;

    calls.push({ url, path, method, body, headers });

    const key = `${method} ${path}`;
    const attempt = attempts.get(key) ?? 0;
    attempts.set(key, attempt + 1);

    const res = handler({ url, path, method, body, headers }, attempt);
    const status = res.status ?? 200;
    const payload = res.body === undefined ? "" : JSON.stringify(res.body);
    return new Response(payload, {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  return { fn: fn as unknown as typeof fetch, calls };
};
