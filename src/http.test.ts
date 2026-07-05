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
  const origin = await startServer((req, res) => {
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
