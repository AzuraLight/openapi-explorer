import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { request, stripSensitiveHeaders } from "./http";

test("stripSensitiveHeaders removes auth/cookie case-insensitively, keeps others", () => {
  const out = stripSensitiveHeaders({
    Authorization: "Bearer x",
    cookie: "a=b",
    "Proxy-Authorization": "y",
    Accept: "application/json",
  });
  assert.deepEqual(out, { Accept: "application/json" });
});

// Start a test server that dispatches to the handler, and return a close function.
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

test("cross-origin redirect drops Authorization header", async () => {
  // Destination server: echoes the received authorization header straight into the body
  const dest = await startServer((req, res) => {
    res.end(JSON.stringify({ auth: req.headers["authorization"] ?? null }));
  });
  // Origin server: 302 redirects to dest on a different port (= different origin)
  const origin = await startServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${dest.port}/echo` });
    res.end();
  });
  try {
    const r = await request(
      { headers: { Authorization: "Bearer secret" } },
      { method: "GET", url: `http://127.0.0.1:${origin.port}/start` }
    );
    assert.equal(JSON.parse(r.body).auth, null, "token must not be forwarded to a different origin");
  } finally {
    await origin.close();
    await dest.close();
  }
});

test("same-origin redirect keeps Authorization header", async () => {
  const srv = await startServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { Location: "/echo" });
      res.end();
      return;
    }
    res.end(JSON.stringify({ auth: req.headers["authorization"] ?? null }));
  });
  try {
    const r = await request(
      { headers: { Authorization: "Bearer secret" } },
      { method: "GET", url: `http://127.0.0.1:${srv.port}/start` }
    );
    assert.equal(JSON.parse(r.body).auth, "Bearer secret", "same-origin redirect keeps the token");
  } finally {
    await srv.close();
  }
});

// ---- defects found on 2026-11-13 ----
import * as tls from "node:tls";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caBundle, resolveProxy, agentFor } from "./http";

test("caCertPath adds to Node's trusted CAs instead of replacing them; a missing file is an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "oae-ca-"));
  const pem = tls.rootCertificates[0];
  writeFileSync(join(dir, "ca.pem"), pem);
  const ca = caBundle(join(dir, "ca.pem"))!;
  assert.ok(ca.length > tls.rootCertificates.length);
  assert.ok(ca.includes(tls.rootCertificates[5]));
  assert.throws(() => caBundle(join(dir, "missing.pem")), /missing\.pem/);
  assert.equal(caBundle(undefined), undefined);
});

test("NO_PROXY: listed hosts (exact, domain suffix, port, *) bypass the environment proxy", () => {
  const saved = { ...process.env };
  try {
    process.env.HTTP_PROXY = "http://proxy:8080";
    process.env.HTTPS_PROXY = "http://proxy:8080";
    process.env.NO_PROXY = "127.0.0.1,.corp.example, localhost:3000";
    assert.equal(resolveProxy(undefined, new URL("http://127.0.0.1:9/x")), undefined);
    assert.equal(resolveProxy(undefined, new URL("https://api.corp.example/x")), undefined);
    assert.equal(resolveProxy(undefined, new URL("http://localhost:3000/")), undefined);
    assert.equal(resolveProxy(undefined, new URL("http://localhost:4000/")), "http://proxy:8080");
    assert.equal(resolveProxy(undefined, new URL("https://example.com/")), "http://proxy:8080");
    // An explicit proxy setting is the user's choice and wins.
    assert.equal(resolveProxy("http://p2:1", new URL("http://127.0.0.1/")), "http://p2:1");
    process.env.NO_PROXY = "*";
    assert.equal(resolveProxy(undefined, new URL("https://example.com/")), undefined);
  } finally {
    process.env = saved;
  }
});

test("303 (and 301/302 after POST) continue as GET without the body; 307 keeps method and body", async () => {
  const seen: string[] = [];
  const srv = await startServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${b}`);
      const to: Record<string, [number, string]> = {
        "/s303": [303, "/done"],
        "/s302": [302, "/done"],
        "/s307": [307, "/done"],
      };
      const r = to[req.url || ""];
      if (r) {
        res.writeHead(r[0], { Location: r[1] });
        res.end();
      } else res.end("ok");
    });
  });
  try {
    for (const p of ["/s303", "/s302", "/s307"]) {
      await request({}, { method: "POST", url: `http://127.0.0.1:${srv.port}${p}`, body: "x=1" });
    }
    assert.deepEqual(seen, [
      "POST /s303 x=1",
      "GET /done ",
      "POST /s302 x=1",
      "GET /done ",
      "POST /s307 x=1",
      "POST /done x=1",
    ]);
  } finally {
    await srv.close();
  }
});

test("HTTPS agents are reused (keep-alive) for the same TLS settings", () => {
  const a = agentFor({ strictSSL: true }, new URL("https://a.example/x"));
  const b = agentFor({ strictSSL: true }, new URL("https://b.example/y"));
  const c = agentFor({ strictSSL: false }, new URL("https://a.example/x"));
  assert.ok(a && a === b);
  assert.notEqual(a, c);
  assert.equal((a as any).keepAlive, true);
});
