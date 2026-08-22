// Talking to Rivo's own API.
//
// One wrapper, so that the access token is attached in exactly one place. A
// `fetch` scattered through components is how a route eventually gets called
// without a token and returns a 401 that looks like a bug in the session.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type TokenSource = () => Promise<string | null>;

export async function api<T>(
  getToken: TokenSource,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = await getToken();
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    // Never a cached portfolio. The whole page is about what is true right now.
    cache: "no-store",
  });
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body from an API route means something upstream failed — a
    // proxy, a build, a crash — and the raw HTML is not what a user should see.
    throw new ApiError(res.status, `the server returned something unexpected (${res.status})`);
  }
  if (!res.ok) {
    const message = (payload as { error?: string } | null)?.error ?? `request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return payload as T;
}
