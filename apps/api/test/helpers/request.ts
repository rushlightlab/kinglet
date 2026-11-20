import type { Hono } from "hono";
import type { AppEnv } from "../../src/auth/middleware.js";
import type { JsonValue } from "../../src/json.js";
import { isString } from "../../src/json.js";

const ORIGIN = "http://localhost:3000";

export type RequestBody = JsonValue | Uint8Array;

/** Minimal cookie jar for `Set-Cookie` round-trips through `app.request`. */
export interface CookieJar {
  readonly size: number;
  header(): string;
  absorb(response: Response): void;
  clear(): void;
}

export interface TestRequestOptions {
  method?: string;
  body?: RequestBody;
  headers?: Record<string, string>;
  /** A jar or a raw `Cookie` header value. */
  cookies?: CookieJar | string;
  /** Bearer token; exempts the request from the CSRF marker, like production. */
  bearer?: string;
  /**
   * Send `X-Kinglet-Request: 1` on mutations. Defaults to true for cookie
   * requests and false when a Bearer token is supplied; set explicitly to
   * exercise either CSRF branch.
   */
  csrf?: boolean;
}

export interface SignInResult {
  jar: CookieJar;
  response: Response;
}

export function createCookieJar(): CookieJar {
  const values = new Map<string, string>();

  return {
    get size() {
      return values.size;
    },
    header() {
      return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    absorb(response) {
      for (const raw of response.headers.getSetCookie()) {
        const terminated = raw.split(";")[0];

        if (terminated === undefined) continue;
        const separator = terminated.indexOf("=");

        if (separator <= 0) continue;
        const name = terminated.slice(0, separator).trim();
        const value = terminated.slice(separator + 1).trim();

        if (value === "") values.delete(name);
        else values.set(name, value);
      }
    },
    clear() {
      values.clear();
    },
  };
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * Wraps `app.request`: absolute local URL, JSON encoding, cookies, Bearer
 * tokens, and the CSRF marker. Never opens a socket.
 */
export async function request(
  app: Hono<AppEnv>,
  path: string,
  options: TestRequestOptions = {},
): Promise<Response> {
  const method = (options.method ?? (options.body === undefined ? "GET" : "POST")).toUpperCase();
  const headers = new Headers(options.headers);
  let body: string | Uint8Array | undefined;

  if (options.body !== undefined) {
    if (isString(options.body) || options.body instanceof Uint8Array) {
      body = options.body;
    } else {
      body = JSON.stringify(options.body);

      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }

  if (options.bearer !== undefined) headers.set("authorization", `Bearer ${options.bearer}`);

  const cookie =
    options.cookies === undefined
      ? ""
      : isString(options.cookies)
        ? options.cookies
        : options.cookies.header();

  if (cookie !== "") headers.set("cookie", cookie);

  const csrf = options.csrf ?? (options.bearer === undefined && isMutation(method));

  if (csrf) headers.set("x-kinglet-request", "1");

  const url = path.startsWith("http://") || path.startsWith("https://") ? path : `${ORIGIN}${path}`;

  return app.request(url, { method, headers, body });
}

/** Signs in through Better Auth and returns the resulting session cookie jar. */
export async function signIn(
  app: Hono<AppEnv>,
  email: string,
  password: string,
  jar: CookieJar = createCookieJar(),
): Promise<SignInResult> {
  const response = await request(app, "/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
    headers: { origin: ORIGIN },
  });

  jar.absorb(response);

  return { jar, response };
}
