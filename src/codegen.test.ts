// Code generation defects (roadmap E5–E9) and those found on 2026-11-13.
// Reference for types: openapi-typescript 7.13.0's actual output (docs/ROADMAP.md, 1.4.0).
// Done criterion: the generated code passes `tsc --noEmit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  endpointDetail,
  genTsForModel,
  genTsForEndpoint,
  genFetchClient,
  genAxiosClient,
  genCurl,
} from "./model";
import type { OpenApiSpec } from "./types";

const spec = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  servers: [{ url: "https://h.example/api/v1" }],
  paths: {
    "/users/{user-id}": {
      get: {
        operationId: "123-get-user",
        parameters: [
          { name: "user-id", in: "path", required: true, schema: { type: "string" } },
          { name: "page", in: "query", schema: { type: "integer" } },
          { name: "ids", in: "query", schema: { type: "array", items: { type: "integer" } } },
          { name: "X-Trace-Id", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Dto" } } },
          },
        },
      },
    },
    "/items": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["n"],
                properties: { n: { type: "integer" }, o: { type: "object" } },
              },
            },
          },
        },
        responses: { "204": { description: "no content" } },
      },
    },
    "/upload": {
      post: {
        requestBody: {
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: { file: { type: "string", format: "binary" }, note: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Status" } } },
          },
        },
      },
    },
    "/login": {
      post: {
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": {
              schema: { type: "object", properties: { user: { type: "string" }, pass: { type: "string" } } },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      Dto: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          "display-name": { type: "string" },
          t: { type: ["string", "null"] },
          n30: { type: "string", nullable: true },
          anyv: {},
          map: { type: "object", additionalProperties: { type: "integer" } },
          free: { type: "object", additionalProperties: true },
          status: { $ref: "#/components/schemas/Status" },
          child: { $ref: "#/components/schemas/Child" },
        },
      },
      Status: { type: "string", enum: ["A", "B"] },
      Child: {
        allOf: [
          { $ref: "#/components/schemas/Base" },
          { type: "object", properties: { extra: { type: "boolean" } } },
        ],
      },
      Base: { type: "object", properties: { b: { type: "string" } } },
      List: { type: "array", items: { $ref: "#/components/schemas/Base" } },
    },
  },
} as unknown as OpenApiSpec;

const get = (p: string, m: string) => endpointDetail(spec, p, m)!;

test("E6: keys that are not identifiers are quoted; 3.1 type arrays and 3.0 nullable give | null; unknown, not any; additionalProperties index signatures", () => {
  const ts = genTsForModel(spec, "Dto");
  assert.match(ts, /"display-name"\?: string;/);
  assert.match(ts, /\bt\?: string \| null;/);
  assert.match(ts, /n30\?: string \| null;/);
  assert.match(ts, /anyv\?: unknown;/);
  assert.match(ts, /map\?: \{\s*\[key: string\]: number;\s*\};/);
  assert.match(ts, /free\?: \{\s*\[key: string\]: unknown;\s*\};/);
  assert.doesNotMatch(ts, /\bany\b/);
});

test("E7/E8: top-level enum, allOf and array models are type aliases, not empty interfaces", () => {
  assert.match(genTsForModel(spec, "Status"), /export type Status = "A" \| "B";/);
  assert.match(genTsForModel(spec, "Child"), /export type Child = Base & \{\s*extra\?: boolean;\s*\};/);
  assert.match(genTsForModel(spec, "List"), /export type List = Base\[\];/);
  assert.doesNotMatch(genTsForModel(spec, "Child"), /interface Child \{\s*\}/);
});

test("E5/E9: path variables are substituted, names are identifiers, header params are arguments, unset query params are left out", () => {
  const code = genFetchClient(spec, get("/users/{user-id}", "GET"), "https://h.example/docs");
  assert.doesNotMatch(code, /function 123/);
  assert.match(code, /export async function _123GetUser\(/);
  assert.match(code, /userId: string/);
  assert.match(code, /\/users\/\$\{userId\}/);
  assert.match(code, /"X-Trace-Id": headers\["X-Trace-Id"\]/);
  assert.match(code, /ids\?: number\[\]/);
  assert.doesNotMatch(code, /new URLSearchParams\(query as Record<string, string>\)/);
});

test("bodies use TS types; 204/void responses do not call res.json()", () => {
  const code = genFetchClient(spec, get("/items", "POST"), "https://h.example/docs");
  assert.match(code, /body: \{\s*n: number;\s*o\?: Record<string, never>;\s*\}/);
  assert.match(code, /Promise<void>/);
  assert.doesNotMatch(code, /res\.json\(\)/);
});

test("multipart bodies are sent as FormData, urlencoded as URLSearchParams; cURL uses -F / --data-urlencode", () => {
  const up = genFetchClient(spec, get("/upload", "POST"), "https://h.example/docs");
  assert.match(up, /new FormData\(\)/);
  assert.doesNotMatch(up, /JSON\.stringify\(body\)/);
  assert.doesNotMatch(up, /"Content-Type": "application\/json"/);
  const login = genFetchClient(spec, get("/login", "POST"), "https://h.example/docs");
  assert.match(login, /new URLSearchParams\(/);
  assert.match(login, /"Content-Type": "application\/x-www-form-urlencoded"/);
  const curlUp = genCurl(spec, get("/upload", "POST"), "https://h.example/docs");
  assert.match(curlUp, /-F 'file=@<file>'/);
  assert.doesNotMatch(curlUp, /Content-Type: multipart\/form-data/);
  assert.match(
    genCurl(spec, get("/login", "POST"), "https://h.example/docs"),
    /--data-urlencode 'user=<user>'/
  );
});

test("deeply chained models do not overflow the stack and each model is emitted once", () => {
  const schemas: Record<string, unknown> = {};
  const N = 5000;
  for (let i = 0; i < N; i++) {
    schemas[`M${i}`] = {
      type: "object",
      properties: { next: { $ref: `#/components/schemas/M${(i + 1) % N}` } },
    };
  }
  const big = {
    openapi: "3.0.0",
    info: { title: "b", version: "1" },
    paths: {},
    components: { schemas },
  } as unknown as OpenApiSpec;
  const ts = genTsForModel(big, "M0");
  assert.equal((ts.match(/export interface /g) || []).length, N);
});

test("generated TS, fetch and axios code compiles with tsc --noEmit", () => {
  const dir = mkdtempSync(join(tmpdir(), "oae-codegen-"));
  try {
    const files: string[] = [];
    const write = (name: string, code: string) => {
      writeFileSync(join(dir, name), code);
      files.push(join(dir, name));
    };
    write(
      "axios.d.ts",
      'declare module "axios" { const axios: { [m: string]: <T>(...a: unknown[]) => Promise<{ data: T }> }; export default axios; }'
    );
    const eps: [string, string][] = [
      ["/users/{user-id}", "GET"],
      ["/items", "POST"],
      ["/upload", "POST"],
      ["/login", "POST"],
    ];
    eps.forEach(([p, m], i) => {
      const d = get(p, m);
      write(`ts${i}.ts`, genTsForEndpoint(spec, d) + "\nexport {};\n");
      write(`fetch${i}.ts`, genFetchClient(spec, d, "https://h.example/docs"));
      write(`axios${i}.ts`, genAxiosClient(spec, d, "https://h.example/docs"));
    });
    for (const m of ["Dto", "Status", "Child", "List"]) write(`model-${m}.ts`, genTsForModel(spec, m));
    const tsc = join(__dirname, "..", "node_modules", "typescript", "bin", "tsc");
    try {
      execFileSync(
        process.execPath,
        [
          tsc,
          "--noEmit",
          "--strict",
          "--target",
          "es2020",
          "--lib",
          "es2020,dom",
          "--moduleResolution",
          "node",
          ...files,
        ],
        { encoding: "utf8" }
      );
    } catch (e: any) {
      assert.fail(String(e.stdout || e.message));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
