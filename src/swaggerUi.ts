// Swagger UI webview — renders with bundled swagger-ui-dist assets (offline/firewall safe).
// The spec is injected inline to avoid CORS when loading the document,
// and "Try it out" calls proxy the webview's fetch through the extension (node) to bypass CORS
// (the webview origin is vscode-webview://, so cross-origin fetch is blocked by CORS and yields "Failed to fetch").
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { request as httpRequest, stripSensitiveHeaders, type HttpOptions } from "./http";
import { absoluteServerTemplate } from "./servers";
import type { OpenApiSpec } from "./types";

export type FocusTarget =
  | { kind: "operation"; tag: string; operationId?: string; method: string; path: string }
  | { kind: "model"; name: string };

let panel: vscode.WebviewPanel | null = null;
let currentSpecUrl = ""; // spec the current panel is showing (re-render if different)
let currentBase = ""; // that spec's origin — credentials are only sent to this origin
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
      currentSpecUrl = "";
      currentBase = "";
    });
    panel.webview.onDidReceiveMessage((msg) => handleMessage(msg));
  }

  const webview = panel.webview;
  panel.title = title;

  // Same spec: don't redraw, just move focus (preserve state). Different spec — even on the
  // same origin, e.g. two services behind one gateway — re-render.
  if (isNew || baseUrl !== currentSpecUrl) {
    const asset = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, f)).toString();
    const nonce = makeNonce();
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; ` +
      `img-src ${webview.cspSource} data:; ` +
      `font-src ${webview.cspSource};`;
    webview.html = render(asset, csp, nonce, specWithServers, httpOptions.headers || {}, focus);
    currentSpecUrl = baseUrl;
    currentBase = base;
  } else if (focus) {
    webview.postMessage({ type: "focus", focus });
  }

  panel.reveal(vscode.ViewColumn.Beside, true);
}

// Execute the webview's proxied fetch in node and return the result (CORS bypass + token/proxy/CA applied).
async function handleMessage(msg: any): Promise<void> {
  if (!panel || msg?.type !== "swaggerFetch") return;
  // body: text body; bodyBase64: binary/multipart body serialized by the webview.
  const { id, url, method, headers, body, bodyBase64 } = msg;
  try {
    // Token/cookies are only sent to the same host as the spec origin (prevents credential leakage to other hosts).
    const sameOrigin = originOf(url) === currentBase;
    const baseHeaders = sameOrigin
      ? currentHttpOptions.headers
      : stripSensitiveHeaders(currentHttpOptions.headers);
    const reqHeaders = sameOrigin ? headers || {} : stripSensitiveHeaders(headers || {});
    const result = await httpRequest(
      { ...currentHttpOptions, headers: { ...baseHeaders, ...reqHeaders } },
      {
        method: method || "GET",
        url,
        body: typeof bodyBase64 === "string" ? Buffer.from(bodyBase64, "base64") : body || undefined,
      }
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
      bodyBase64: result.bodyBytes.toString("base64"), // binary-safe; decoded in the webview
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
  // The spec is injected inline, so Swagger UI has no document URL to resolve relative
  // servers against (it would use the webview origin). Make them absolute here.
  const servers = (spec.servers || [])
    .map((s) => ({ ...s, url: absoluteServerTemplate(s.url ?? "", baseUrl) }))
    .filter((s): s is typeof s & { url: string } => !!s.url);
  return { ...spec, servers: servers.length ? servers : [{ url: u.origin }] } as OpenApiSpec;
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
      const id = ++seq;
      return serializeBody(input, init, method, headers).then(
        (body) =>
          new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject, url });
            vscode.postMessage(Object.assign({ type: "swaggerFetch", id, url, method, headers }, body));
          })
      );
    };

    // Text bodies go as-is. FormData/Blob/URLSearchParams/binary bodies are serialized by the
    // browser itself (new Request) — which also yields the multipart boundary — and sent as base64.
    async function serializeBody(input, init, method, headers) {
      const raw = init && init.body != null ? init.body : null;
      if (raw == null && !(input instanceof Request)) return {};
      if (typeof raw === "string") return { body: raw };
      if (/^(GET|HEAD)$/i.test(method)) return {};
      const req = new Request(input instanceof Request ? input : "http://localhost/", { method, body: raw });
      const bytes = new Uint8Array(await req.arrayBuffer());
      const type = req.headers.get("content-type");
      // For FormData the browser-generated type carries the boundary and must win.
      if (type && (raw instanceof FormData || !hasHeader(headers, "content-type"))) {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-type") delete headers[k];
        headers["Content-Type"] = type;
      }
      return bytes.length ? { bodyBase64: toBase64(bytes) } : {};
    }
    function hasHeader(h, name) {
      return Object.keys(h).some((k) => k.toLowerCase() === name);
    }
    function toBase64(bytes) {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }
    function fromBase64(b64) {
      const s = atob(b64 || "");
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }

    window.addEventListener("message", (e) => {
      const m = e.data || {};
      if (m.type === "swaggerFetchResult") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) { p.reject(new TypeError(m.error)); return; }
        // Null-body statuses must not be given a body (the Response constructor throws).
        const nullBody = [101, 204, 205, 304].includes(m.status);
        const resp = new Response(nullBody ? null : fromBase64(m.bodyBase64), { status: m.status, headers: m.headers || {} });
        try { Object.defineProperty(resp, "url", { value: p.url }); } catch (_) {}
        p.resolve(resp);
      } else if (m.type === "focus") {
        doFocus(m.focus);
      }
    });

    // DOM ids as Swagger UI builds them (swagger-ui 5.x; verified against the bundled 5.32.6):
    //   id = escapeDeepLinkPath(["operations", tag, operationId].join("-"))
    //   operationId: as written in the spec; when absent, method + path with \\W → "_"
    //   escapeDeepLinkPath: trim, whitespace → "_", then CSS.escape
    function swaggerOpId(f) {
      if (f.operationId && f.operationId.replace(/\\s/g, "").length) return f.operationId;
      return f.method.toLowerCase() + f.path.replace(/\\W/g, "_");
    }
    function escapeDeepLinkPath(s) {
      return CSS.escape(String(s).trim().replace(/\\s/g, "_"));
    }

    // Scroll to and expand the operation/model selected in the tree (poll briefly since rendering is async)
    function doFocus(focus) {
      if (!focus) return;
      let n = 0;
      const timer = setInterval(() => {
        n++;
        let el = null;
        if (focus.kind === "operation") {
          el = document.getElementById(escapeDeepLinkPath(["operations", focus.tag, swaggerOpId(focus)].join("-")));
        } else if (focus.kind === "model") {
          el = document.getElementById("model-" + focus.name);
        }
        if (el) {
          clearInterval(timer);
          if (focus.kind === "operation" && !el.classList.contains("is-open")) {
            // swagger-ui 5 toggles on this button; the .opblock-summary container has no handler.
            const ctl = el.querySelector(".opblock-summary-control");
            if (ctl) ctl.click();
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
