// Shared test helpers: fake ExtensionContext + local HTTP servers (no external network).
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");

// The fake vscode module's recorder (test/fake-vscode/vscode/index.js).
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const fakeVscode = require("vscode") as {
  __rec: any;
  __reset: () => void;
  __resolveView: (id: string) => Promise<any>;
};

export interface FakeContext {
  context: any;
  secrets: Record<string, string>;
}

export function makeContext(): FakeContext {
  const secrets: Record<string, string> = {};
  const context = {
    subscriptions: [] as { dispose(): void }[],
    extensionUri: { fsPath: REPO_ROOT },
    secrets: {
      get: async (k: string) => secrets[k],
      store: async (k: string, v: string) => void (secrets[k] = v),
      delete: async (k: string) => void delete secrets[k],
    },
  };
  return { context, secrets };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Route = (req: RecordedRequest) => { status?: number; type?: string; body: string | Buffer };

export interface TestServer {
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

// host: "127.0.0.1" or "localhost" — two different hosts (origins) on one machine.
export function startServer(routes: Record<string, Route>, host = "127.0.0.1"): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rr: RecordedRequest = {
        method: req.method || "",
        url: req.url || "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(rr);
      const route = routes[(req.url || "").split("?")[0]];
      if (!route) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const r = route(rr);
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", r.type ?? "application/json");
      res.end(r.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, host === "localhost" ? "127.0.0.1" : host, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://${host}:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

export function specJson(title: string, paths: Record<string, unknown> = {}): string {
  return JSON.stringify({ openapi: "3.0.0", info: { title, version: "1" }, paths });
}

// Poll until cond() is truthy (for fire-and-forget work such as activation-time migration).
export async function waitFor(cond: () => unknown, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function hostOf(origin: string): string {
  return new URL(origin).host;
}
