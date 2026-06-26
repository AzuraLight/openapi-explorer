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

// 테스트용 서버를 띄워 핸들러로 분기, 종료 함수를 돌려준다.
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
  // 목적지 서버: 받은 authorization 헤더를 그대로 본문에 echo
  const dest = await startServer((req, res) => {
    res.end(JSON.stringify({ auth: req.headers["authorization"] ?? null }));
  });
  // 출발 서버: 다른 포트(=다른 origin)인 dest로 302 리다이렉트
  const origin = await startServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${dest.port}/echo` });
    res.end();
  });
  try {
    const r = await request(
      { headers: { Authorization: "Bearer secret" } },
      { method: "GET", url: `http://127.0.0.1:${origin.port}/start` }
    );
    assert.equal(JSON.parse(r.body).auth, null, "토큰이 타 origin으로 전달되면 안 된다");
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
    assert.equal(JSON.parse(r.body).auth, "Bearer secret", "동일 origin 리다이렉트는 토큰 유지");
  } finally {
    await srv.close();
  }
});
