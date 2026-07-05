// Swagger UI webview — renders with bundled swagger-ui-dist assets (offline/firewall safe).
// The spec is injected inline to avoid CORS when loading the document,
// and "Try it out" calls proxy the webview's fetch through the extension (node) to bypass CORS
// (the webview origin is vscode-webview://, so cross-origin fetch is blocked by CORS and yields "Failed to fetch").
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { request as httpRequest, stripSensitiveHeaders, type HttpOptions } from "./http";
import type { OpenApiSpec } from "./types";

export type FocusTarget =
  | { kind: "operation"; tag: string; operationId?: string; method: string; path: string }
  | { kind: "model"; name: string };

let panel: vscode.WebviewPanel | null = null;
let currentBase = ""; // spec origin the current panel is showing (re-render if different)
// The panel is reused, so keep the latest options (token/proxy/CA) in the module for the message handler to read.
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

  // Same spec: don't redraw, just move focus (preserve state). Different spec: re-render.
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

// Execute the webview's proxied fetch in node and return the result (CORS bypass + token/proxy/CA applied).
async function handleMessage(msg: any): Promise<void> {
  if (!panel || msg?.type !== "swaggerFetch") return;
  const { id, url, method, headers, body } = msg;
  try {
    // Token/cookies are only sent to the same host as the spec origin (prevents credential leakage to other hosts).
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

// OpenAPI 3: inject servers / Swagger 2: inject host+schemes (only when missing)
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

    // Proxy Try it out calls (arbitrary API origin) through the extension (node) to bypass CORS.
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

    // Scroll to and expand the operation/model selected in the tree (poll briefly since rendering is async)
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
