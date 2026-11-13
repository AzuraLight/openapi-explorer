// Network layer — supports corporate proxy / private CA / strictSSL / auth headers.
// Does not import the vscode module so it can be unit tested (options are injected by the caller).
import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import * as tls from "node:tls";
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
  body?: string | Buffer; // Buffer for binary/multipart bodies (sent as-is)
}

export interface RequestResult {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  // utf8 decoding of bodyBytes (for text consumers such as the spec loader). Decoded on first read,
  // so binary consumers (Try it out) do not hold a second copy of a large response.
  readonly body: string;
  bodyBytes: Buffer; // raw response bytes (for binary-safe consumers such as Try it out)
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

// NO_PROXY / no_proxy: comma-separated hosts that bypass the environment proxy — exact host,
// ".domain" or "domain" suffix, optional ":port", or "*" (curl / Node conventions).
function bypassesProxy(target: URL): boolean {
  const list = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  return list.some((entry) => {
    if (!entry) return false;
    if (entry === "*") return true;
    const m = /^(.*?)(?::(\d+))?$/.exec(entry)!;
    const name = m[1].replace(/^\*?\./, "").replace(/^\[|\]$/g, "");
    if (m[2] && m[2] !== port) return false;
    return host === name || host.endsWith("." + name);
  });
}

// An explicit proxy setting wins; otherwise HTTPS_PROXY / HTTP_PROXY unless NO_PROXY lists the host.
export function resolveProxy(explicit: string | undefined, target: URL): string | undefined {
  if (explicit) return explicit;
  if (bypassesProxy(target)) return undefined;
  const env = process.env;
  if (target.protocol === "https:")
    return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  return env.HTTP_PROXY || env.http_proxy;
}

// Node's `ca` option replaces the default trust store, so the private CA is added to Node's own
// root certificates (and NODE_EXTRA_CA_CERTS, which tls.rootCertificates does not include).
// The file is read once per path; clearHttpCaches() forgets it.
const caCache = new Map<string, string[]>();
export function caBundle(caCertPath?: string): string[] | undefined {
  if (!caCertPath) return undefined;
  let ca = caCache.get(caCertPath);
  if (!ca) {
    let pem: string;
    try {
      pem = fs.readFileSync(caCertPath, "utf8");
    } catch (e) {
      throw new Error(
        `Cannot read the CA certificate file (swaggerViewer.caCertPath): ${caCertPath} — ${(e as Error).message}`
      );
    }
    const extra = process.env.NODE_EXTRA_CA_CERTS;
    let extraPem: string[] = [];
    try {
      if (extra) extraPem = [fs.readFileSync(extra, "utf8")];
    } catch {
      /* Node ignores an unreadable NODE_EXTRA_CA_CERTS too */
    }
    ca = [...tls.rootCertificates, ...extraPem, pem];
    caCache.set(caCertPath, ca);
  }
  return ca;
}

// One keep-alive agent per TLS/proxy setting, so repeated requests (spec discovery, Try it out)
// reuse connections instead of a new TLS handshake each time.
const agentCache = new Map<string, http.Agent>();
export function agentFor(opts: HttpOptions, target: URL): http.Agent | undefined {
  const proxy = resolveProxy(opts.proxy, target);
  const isHttps = target.protocol === "https:";
  if (!proxy && !isHttps) return undefined; // Node's global http agent already keeps connections alive
  const rejectUnauthorized = opts.strictSSL !== false;
  const key = JSON.stringify([proxy || "", opts.caCertPath || "", rejectUnauthorized]);
  let agent = agentCache.get(key);
  if (!agent) {
    const ca = caBundle(opts.caCertPath);
    agent = proxy
      ? new HttpsProxyAgent(proxy, { ca, rejectUnauthorized, keepAlive: true })
      : new https.Agent({ ca, rejectUnauthorized, keepAlive: true });
    agentCache.set(key, agent);
  }
  return agent;
}

// Settings changed or Refresh: re-read CA files and rebuild agents on next use.
export function clearHttpCaches(): void {
  for (const a of agentCache.values()) a.destroy();
  agentCache.clear();
  caCache.clear();
}

// Arbitrary method/body request (executed via the extension = CORS bypass). Manually follows up to 5 redirects.
export function request(opts: HttpOptions, input: RequestInput, redirectsLeft = 5): Promise<RequestResult> {
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
    let agent: http.Agent | undefined;
    try {
      agent = agentFor(opts, target);
    } catch (e) {
      reject(e);
      return;
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "swagger-viewer",
      ...(opts.headers || {}),
      ...(input.headers || {}),
    };
    const bodyBuf =
      input.body === undefined || input.body.length === 0
        ? undefined
        : Buffer.isBuffer(input.body)
          ? input.body
          : Buffer.from(input.body, "utf8");
    if (bodyBuf) headers["Content-Length"] = String(bodyBuf.length);

    const req = lib.request(target, { method: input.method.toUpperCase(), agent, headers }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const nextUrl = new URL(res.headers.location, target);
        // For cross-origin redirects, strip auth/cookie headers to prevent token leakage.
        const crossOrigin = nextUrl.origin !== target.origin;
        const nextOpts = crossOrigin ? { ...opts, headers: stripSensitiveHeaders(opts.headers) } : opts;
        let nextInput: RequestInput = crossOrigin
          ? { ...input, url: nextUrl.href, headers: stripSensitiveHeaders(input.headers) }
          : { ...input, url: nextUrl.href };
        // Fetch standard (HTTP-redirect fetch): 303 (except HEAD), and 301/302 after POST, continue
        // as GET without the body and its content headers. 307/308 keep method and body.
        const m = input.method.toUpperCase();
        if ((status === 303 && m !== "HEAD") || ((status === 301 || status === 302) && m === "POST")) {
          const h = { ...(nextInput.headers || {}) };
          for (const k of Object.keys(h)) {
            if (/^(content-type|content-length|content-encoding|content-language|content-location)$/i.test(k))
              delete h[k];
          }
          nextInput = { ...nextInput, method: "GET", body: undefined, headers: h };
        }
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
      res.on("end", () => {
        const bodyBytes = Buffer.concat(chunks);
        let text: string | undefined;
        resolve({
          status,
          contentType: String(res.headers["content-type"] || ""),
          headers: flatHeaders,
          get body() {
            return (text ??= bodyBytes.toString("utf8"));
          },
          bodyBytes,
          timeMs: Date.now() - started,
          finalUrl: target.href,
        });
      });
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
