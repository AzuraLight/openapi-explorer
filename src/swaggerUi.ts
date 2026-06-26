// Swagger UI 웹뷰 — 번들된 swagger-ui-dist 에셋으로 렌더(오프라인/방화벽 안전).
// 스펙은 인라인(spec)으로 주입해 문서 로딩 시 CORS를 피하고,
// "Try it out" 호출은 웹뷰의 fetch를 확장(node) 경유로 프록시해 CORS를 우회한다
// (웹뷰 origin은 vscode-webview:// 라 cross-origin fetch가 CORS에 막혀 "Failed to fetch"가 난다).
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { request as httpRequest, stripSensitiveHeaders, type HttpOptions } from "./http";
import type { OpenApiSpec } from "./types";

export type FocusTarget =
  | { kind: "operation"; tag: string; operationId?: string; method: string; path: string }
  | { kind: "model"; name: string };

let panel: vscode.WebviewPanel | null = null;
let currentBase = ""; // 현재 패널이 보고 있는 스펙 origin (다르면 새로 렌더)
// 패널은 재사용되므로 최신 옵션(토큰/프록시/CA)을 모듈에 보관해 메시지 핸들러가 읽는다.
let currentHttpOptions: HttpOptions = {};

export function openSwaggerUi(
  context: vscode.ExtensionContext,
  spec: OpenApiSpec,
  title: string,
  baseUrl: string,
  httpOptions: HttpOptions,
  focus?: FocusTarget
): void {
  currentHttpOptions = httpOptions;
  const specWithServers = ensureServers(spec, baseUrl);
  const base = originOf(baseUrl);
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media", "swagger-ui");

  const isNew = !panel;
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "swaggerUi",
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] }
    );
    panel.onDidDispose(() => {
      panel = null;
      currentBase = "";
    });
    panel.webview.onDidReceiveMessage((msg) => handleMessage(msg));
  }

  const webview = panel.webview;
  panel.title = title;

  // 같은 스펙이면 다시 그리지 않고 포커스만 이동(상태 유지). 다른 스펙이면 새로 렌더.
  if (isNew || base !== currentBase) {
    const asset = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, f)).toString();
    const nonce = makeNonce();
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; ` +
      `img-src ${webview.cspSource} data:; ` +
      `font-src ${webview.cspSource};`;
    webview.html = render(asset, csp, nonce, specWithServers, httpOptions.headers || {}, focus);
    currentBase = base;
  } else if (focus) {
    webview.postMessage({ type: "focus", focus });
  }

  panel.reveal(vscode.ViewColumn.Beside, true);
}

// 웹뷰가 프록시한 fetch를 node에서 실행 → 결과를 돌려준다(CORS 우회 + 토큰/프록시/CA 적용).
async function handleMessage(msg: any): Promise<void> {
  if (!panel || msg?.type !== "swaggerFetch") return;
  const { id, url, method, headers, body } = msg;
  try {
    // 토큰/쿠키는 스펙 origin과 같은 호스트로만 보낸다 (타 호스트로의 자격증명 유출 방지).
    const sameOrigin = originOf(url) === currentBase;
    const baseHeaders = sameOrigin
      ? currentHttpOptions.headers
      : stripSensitiveHeaders(currentHttpOptions.headers);
    const reqHeaders = sameOrigin ? headers || {} : stripSensitiveHeaders(headers || {});
    const result = await httpRequest(
      { ...currentHttpOptions, headers: { ...baseHeaders, ...reqHeaders } },
      { method: method || "GET", url, body: body || undefined }
    );
    const safeHeaders = { ...result.headers };
    for (const k of Object.keys(safeHeaders)) {
      if (/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) delete safeHeaders[k];
    }
    panel.webview.postMessage({
      type: "swaggerFetchResult",
      id,
      status: result.status,
      headers: safeHeaders,
      body: result.body,
    });
  } catch (e: any) {
    panel.webview.postMessage({ type: "swaggerFetchResult", id, error: e?.message ?? String(e) });
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// OpenAPI 3: servers 주입 / Swagger 2: host+schemes 주입 (없을 때만)
function ensureServers(spec: OpenApiSpec, baseUrl: string): OpenApiSpec {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return spec;
  }
  if (spec.swagger) {
    if ((spec as any).host) return spec;
    return { ...spec, host: u.host, schemes: [u.protocol.replace(":", "")] } as OpenApiSpec;
  }
  const servers = (spec as any).servers as { url: string }[] | undefined;
  if (servers?.some((s) => /^https?:/i.test(s.url))) return spec;
  return { ...spec, servers: [{ url: u.origin }] } as OpenApiSpec;
}

function render(
  asset: (f: string) => string,
  csp: string,
  nonce: string,
  spec: OpenApiSpec,
  headers: Record<string, string>,
  focus?: FocusTarget
): string {
  const specJson = JSON.stringify(spec).replace(/</g, "\\u003c");
  const headersJson = JSON.stringify(headers).replace(/</g, "\\u003c");
  const focusJson = JSON.stringify(focus ?? null).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${asset("swagger-ui.css")}" />
  <style nonce="${nonce}">
    body { margin: 0; background: #fff; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script nonce="${nonce}" src="${asset("swagger-ui-bundle.js")}"></script>
  <script nonce="${nonce}" src="${asset("swagger-ui-standalone-preset.js")}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const extraHeaders = ${headersJson};

    // Try it out 호출(임의 API origin)을 확장(node)으로 프록시해 CORS를 우회한다.
    const origFetch = window.fetch.bind(window);
    const pending = new Map();
    let seq = 0;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      if (!url || !/^https?:/i.test(url)) return origFetch(input, init);
      const req = typeof input === "object" ? input : {};
      const method = (init && init.method) || req.method || "GET";
      const headers = {};
      const collect = (h) => {
        if (!h) return;
        if (typeof h.forEach === "function" && !Array.isArray(h)) h.forEach((v, k) => (headers[k] = v));
        else if (Array.isArray(h)) h.forEach(([k, v]) => (headers[k] = v));
        else Object.assign(headers, h);
      };
      collect(req.headers);
      collect(init && init.headers);
      const body = init && init.body != null ? String(init.body) : undefined;
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, url });
        vscode.postMessage({ type: "swaggerFetch", id, url, method, headers, body });
      });
    };

    window.addEventListener("message", (e) => {
      const m = e.data || {};
      if (m.type === "swaggerFetchResult") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) { p.reject(new TypeError(m.error)); return; }
        const resp = new Response(m.body, { status: m.status, headers: m.headers || {} });
        try { Object.defineProperty(resp, "url", { value: p.url }); } catch (_) {}
        p.resolve(resp);
      } else if (m.type === "focus") {
        doFocus(m.focus);
      }
    });

    // 트리에서 선택한 오퍼레이션/모델로 스크롤 + 펼치기 (렌더가 비동기라 잠시 폴링)
    function doFocus(focus) {
      if (!focus) return;
      let n = 0;
      const timer = setInterval(() => {
        n++;
        let el = null;
        if (focus.kind === "operation") {
          el = document.getElementById("operations-" + focus.tag + "-" + focus.operationId)
            || document.getElementById("operations-" + focus.tag + "-" + focus.method + focus.path);
        } else if (focus.kind === "model") {
          el = document.getElementById("model-" + focus.name);
        }
        if (el) {
          clearInterval(timer);
          if (focus.kind === "operation" && !el.classList.contains("is-open")) {
            const sum = el.querySelector(".opblock-summary");
            if (sum) sum.click();
          }
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (n > 25) {
          clearInterval(timer);
        }
      }, 120);
    }

    const spec = ${specJson};
    const initialFocus = ${focusJson};
    window.ui = SwaggerUIBundle({
      spec,
      dom_id: "#swagger-ui",
      deepLinking: true,
      validatorUrl: null,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: "StandaloneLayout",
      requestInterceptor: (req) => {
        Object.assign(req.headers, extraHeaders);
        return req;
      },
      onComplete: () => { if (initialFocus) doFocus(initialFocus); },
    });
  </script>
</body>
</html>`;
}

function makeNonce(): string {
  return randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}
