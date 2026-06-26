// 네트워크 레이어 — 사내 프록시 / 사설 CA / strictSSL / 인증 헤더 지원.
// vscode 모듈을 import 하지 않아 단위 테스트가 가능하다(옵션은 호출측에서 주입).
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
  proxy?: string; // 빈 값이면 환경변수(HTTPS_PROXY/HTTP_PROXY) 사용
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
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 응답 본문 상한 (메모리 보호)

// 다른 origin으로 리다이렉트될 때 따라가면 안 되는 민감 헤더 (브라우저 fetch 표준과 동일).
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

// 임의 메서드/바디 요청 (확장 경유 실행 = CORS 우회). 리다이렉트 최대 5회 수동 추적.
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
      reject(new Error(`잘못된 URL: ${input.url}`));
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
        // 크로스-오리진 리다이렉트면 인증/쿠키 헤더를 제거해 토큰 유출을 막는다.
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
          req.destroy(new Error(`응답이 너무 큽니다(>${MAX_BODY_BYTES} bytes): ${input.url}`));
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
    req.setTimeout(timeout, () => req.destroy(new Error(`요청 시간 초과(${timeout}ms): ${input.url}`)));
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// 스펙 로더용 GET fetcher (request 위에 얇게)
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
