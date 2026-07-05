// Network layer — supports corporate proxy / private CA / strictSSL / auth headers.
// Does not import the vscode module so it can be unit tested (options are injected by the caller).
import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import { URL } from "node:url";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Fetcher, HttpResponse } from "./types";

export interface HttpOptions {
  headers?: Record<string, string>;
  strictSSL?: boolean;
  caCertPath?: string;
  proxy?: string; // if empty, use environment variables (HTTPS_PROXY/HTTP_PROXY)
  timeoutMs?: number;
}

export interface RequestInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface RequestResult {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: string;
  timeMs: number;
  finalUrl: string;
}

const DEFAULT_TIMEOUT = 20_000;
const MAX_BODY_BYTES = 25 * 1024 * 1024; // response body limit (memory protection)

// Sensitive headers that must not be forwarded when redirecting to a different origin (same as the browser fetch standard).
const SENSITIVE_HEADERS = /^(authorization|cookie|proxy-authorization)$/i;

export function stripSensitiveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.test(k)) out[k] = v;
  }
  return out;
}

function resolveProxy(explicit: string | undefined, target: URL): string | undefined {
  if (explicit) return explicit;
  const env = process.env;
  if (target.protocol === "https:") return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  return env.HTTP_PROXY || env.http_proxy;
}

function loadCa(caCertPath?: string): Buffer | undefined {
  if (!caCertPath) return undefined;
  try {
    return fs.readFileSync(caCertPath);
  } catch {
    return undefined;
  }
}

// Arbitrary method/body request (executed via the extension = CORS bypass). Manually follows up to 5 redirects.
export function request(opts: HttpOptions, input: RequestInput, redirectsLeft = 5): Promise<RequestResult> {
  const ca = loadCa(opts.caCertPath);
  const rejectUnauthorized = opts.strictSSL !== false;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const started = Date.now();

  return new Promise<RequestResult>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(input.url);
    } catch {
      reject(new Error(`Invalid URL: ${input.url}`));
      return;
    }
    const isHttps = target.protocol === "https:";
    const lib = isHttps ? https : http;
    const proxy = resolveProxy(opts.proxy, target);
    const agent = proxy
      ? new HttpsProxyAgent(proxy, { ca, rejectUnauthorized })
      : isHttps
        ? new https.Agent({ ca, rejectUnauthorized })
        : undefined;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "swagger-viewer",
      ...(opts.headers || {}),
      ...(input.headers || {}),
    };
    const bodyBuf = input.body ? Buffer.from(input.body, "utf8") : undefined;
    if (bodyBuf) headers["Content-Length"] = String(bodyBuf.length);

    const req = lib.request(target, { method: input.method.toUpperCase(), agent, headers }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const nextUrl = new URL(res.headers.location, target);
        // For cross-origin redirects, strip auth/cookie headers to prevent token leakage.
        const crossOrigin = nextUrl.origin !== target.origin;
        const nextOpts = crossOrigin ? { ...opts, headers: stripSensitiveHeaders(opts.headers) } : opts;
        const nextInput = crossOrigin
          ? { ...input, url: nextUrl.href, headers: stripSensitiveHeaders(input.headers) }
          : { ...input, url: nextUrl.href };
        request(nextOpts, nextInput, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      const flatHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v == null) continue;
        flatHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on("data", (c) => {
        received += c.length;
        if (received > MAX_BODY_BYTES) {
          req.destroy(new Error(`Response too large (>${MAX_BODY_BYTES} bytes): ${input.url}`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () =>
        resolve({
          status,
          contentType: String(res.headers["content-type"] || ""),
          headers: flatHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
          timeMs: Date.now() - started,
          finalUrl: target.href,
        })
      );
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`Request timed out (${timeout}ms): ${input.url}`)));
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// GET fetcher for the spec loader (a thin wrapper over request)
export function createHttpFetcher(opts: HttpOptions = {}): Fetcher {
  return async (rawUrl: string): Promise<HttpResponse> => {
    const r = await request(opts, { method: "GET", url: rawUrl });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      contentType: r.contentType,
      body: r.body,
    };
  };
}
