// 1.2.0 — spec reading. Each test cites the rule it checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpec, candidateUrls, clearCache } from "./specLoader";
import { endpointDetail, listEndpoints, genTsForEndpoint, genFetchClient } from "./model";
import { resolveBaseUrl } from "./servers";
import type { Fetcher, OpenApiSpec } from "./types";

type Route = { status?: number; type?: string; body: string };
const fetcherOf =
  (routes: Record<string, Route>): Fetcher =>
  async (url) => {
    const r = routes[url];
    if (!r) return { ok: false, status: 404, contentType: "", body: "" };
    const status = r.status ?? 200;
    return { ok: status < 300, status, contentType: r.type ?? "application/json", body: r.body };
  };

// ---------------- E1: YAML ----------------

const YAML_SPEC = `openapi: 3.0.3
info: { title: Yaml API, version: "1" }
x-common: &okResponse
  description: ok
paths:
  /pets:
    get:
      tags: [pets]
      responses:
        "200": *okResponse
`;

test("E1: a YAML spec (with anchors/aliases) is parsed", async () => {
  clearCache();
  const r = await resolveSpec("https://y.example.com/openapi.yaml", {
    fetcher: fetcherOf({
      "https://y.example.com/openapi.yaml": { type: "application/yaml", body: YAML_SPEC },
    }),
  });
  assert.equal(r.spec.info?.title, "Yaml API");
  assert.equal(listEndpoints(r.spec).length, 1);
  assert.equal((r.spec.paths!["/pets"].get.responses as any)["200"].description, "ok");
});

test("E1: YAML served as text/plain or without a content type is still parsed", async () => {
  clearCache();
  const r = await resolveSpec("https://y.example.com/api-yaml", {
    fetcher: fetcherOf({ "https://y.example.com/api-yaml": { type: "text/plain", body: YAML_SPEC } }),
  });
  assert.equal(r.spec.info?.title, "Yaml API");
});

test("E1: alias bombs are rejected instead of expanding (yaml maxAliasCount)", async () => {
  clearCache();
  const bomb =
    "openapi: 3.0.0\npaths: {}\na: &a [x, x, x, x, x, x, x, x, x, x]\n" +
    Array.from({ length: 9 }, (_, i) => {
      const prev = i === 0 ? "a" : `l${i - 1}`;
      return `l${i}: &l${i} [*${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}]`;
    }).join("\n");
  await assert.rejects(
    resolveSpec("https://y.example.com/bomb.yaml", {
      fetcher: fetcherOf({ "https://y.example.com/bomb.yaml": { type: "application/yaml", body: bomb } }),
    }),
    /alias/i
  );
});

test("E1: candidate URLs include framework YAML paths (springdoc .yaml, NestJS -yaml)", () => {
  const c = candidateUrls("https://gw.example.com/api");
  assert.ok(c.includes("https://gw.example.com/api-yaml"), "NestJS /{path}-yaml");
  assert.ok(c.includes("https://gw.example.com/v3/api-docs.yaml"), "springdoc /v3/api-docs.yaml");
  assert.ok(c.includes("https://gw.example.com/openapi.yaml"));
});

test("an HTML page that is not a spec is not mistaken for YAML", async () => {
  clearCache();
  await assert.rejects(
    resolveSpec("https://h.example.com/", {
      fetcher: fetcherOf({
        "https://h.example.com/": { type: "text/html", body: "<html><body>hi</body></html>" },
      }),
    }),
    /spec not found/
  );
});

// ---------------- E3: springdoc groups ----------------

const springdocUi = "<html><div id=swagger-ui></div><script src=./swagger-initializer.js></script></html>";

test("E3: springdoc swagger-config with urls[] → groups, primary group loaded", async () => {
  clearCache();
  const r = await resolveSpec("https://s.example.com/swagger-ui/index.html", {
    fetcher: fetcherOf({
      "https://s.example.com/swagger-ui/index.html": { type: "text/html", body: springdocUi },
      "https://s.example.com/v3/api-docs/swagger-config": {
        body: JSON.stringify({
          urls: [
            { name: "orders", url: "/v3/api-docs/orders" },
            { name: "payments", url: "/v3/api-docs/payments" },
          ],
          urlsPrimaryName: "payments",
        }),
      },
      "https://s.example.com/v3/api-docs/orders": {
        body: JSON.stringify({ openapi: "3.0.1", info: { title: "Orders" }, paths: {} }),
      },
      "https://s.example.com/v3/api-docs/payments": {
        body: JSON.stringify({ openapi: "3.0.1", info: { title: "Payments" }, paths: {} }),
      },
    }),
  });
  assert.deepEqual(r.groups, [
    { name: "orders", url: "https://s.example.com/v3/api-docs/orders" },
    { name: "payments", url: "https://s.example.com/v3/api-docs/payments" },
  ]);
  assert.equal(r.spec.info?.title, "Payments");
  assert.equal(r.specUrl, "https://s.example.com/v3/api-docs/payments");
});

test("E3: groups are found even when a default /v3/api-docs also exists", async () => {
  clearCache();
  const r = await resolveSpec("https://s.example.com/swagger-ui/index.html", {
    fetcher: fetcherOf({
      "https://s.example.com/swagger-ui/index.html": { type: "text/html", body: springdocUi },
      "https://s.example.com/v3/api-docs": { body: JSON.stringify({ openapi: "3.0.1", paths: {} }) },
      "https://s.example.com/v3/api-docs/swagger-config": {
        body: JSON.stringify({
          urls: [
            { name: "a", url: "/v3/api-docs/a" },
            { name: "b", url: "/v3/api-docs/b" },
          ],
        }),
      },
      "https://s.example.com/v3/api-docs/a": {
        body: JSON.stringify({ openapi: "3.0.1", info: { title: "A" }, paths: {} }),
      },
      "https://s.example.com/v3/api-docs/b": {
        body: JSON.stringify({ openapi: "3.0.1", info: { title: "B" }, paths: {} }),
      },
    }),
  });
  assert.equal(r.groups?.length, 2);
  assert.equal(r.spec.info?.title, "A", "without urlsPrimaryName the first group is primary");
});

test("a direct spec URL does not trigger group discovery", async () => {
  clearCache();
  const r = await resolveSpec("https://s.example.com/v3/api-docs/a", {
    fetcher: fetcherOf({
      "https://s.example.com/v3/api-docs/a": { body: JSON.stringify({ openapi: "3.0.1", paths: {} }) },
      "https://s.example.com/v3/api-docs/swagger-config": {
        body: JSON.stringify({ urls: [{ name: "x", url: "/x" }] }),
      },
    }),
  });
  assert.equal(r.groups, undefined);
});

// ---------------- E4: path-level parameters ----------------

test("E4: path-level parameters apply to operations; the operation overrides same name+in", () => {
  const spec: OpenApiSpec = {
    openapi: "3.0.0",
    paths: {
      "/users/{id}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "X-Trace", in: "header", description: "from path" },
          { $ref: "#/components/parameters/Page" },
        ] as any,
        get: {
          parameters: [{ name: "X-Trace", in: "header", description: "from op" }],
          responses: {},
        },
      },
    },
    components: { parameters: { Page: { name: "page", in: "query", schema: { type: "integer" } } } } as any,
  };
  const d = endpointDetail(spec, "/users/{id}", "GET")!;
  const byKey = Object.fromEntries(d.parameters.map((p) => [`${p.in}:${p.name}`, p]));
  assert.deepEqual(Object.keys(byKey).sort(), ["header:X-Trace", "path:id", "query:page"]);
  assert.equal(byKey["header:X-Trace"].description, "from op");
});

// ---------------- E12–E14: Swagger 2 ----------------

const s2: OpenApiSpec = {
  swagger: "2.0",
  host: "api.example.com",
  basePath: "/v2",
  schemes: ["https"],
  consumes: ["application/json"],
  paths: {
    "/pets": {
      post: {
        operationId: "addPet",
        parameters: [{ in: "body", name: "body", required: true, schema: { $ref: "#/definitions/Pet" } }],
        responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } } },
      },
    },
    "/pets/{id}/photo": {
      post: {
        consumes: ["multipart/form-data"],
        parameters: [
          { in: "path", name: "id", required: true, type: "integer" },
          { in: "formData", name: "file", required: true, type: "file" },
          { in: "formData", name: "note", type: "string" },
        ],
        responses: { "204": { description: "done" } },
      },
    },
  },
  definitions: { Pet: { type: "object", properties: { name: { type: "string" } } } },
} as any;

test("E12: Swagger 2 `in: body` becomes the request body (content type from consumes)", () => {
  const d = endpointDetail(s2, "/pets", "POST")!;
  assert.deepEqual(d.requestBody, { contentType: "application/json", schema: "Pet", required: true });
  assert.equal(d.parameters.length, 0, "the body parameter is not listed as a parameter");
});

test("E13: Swagger 2 `in: formData` becomes a form request body (content type from the operation's consumes)", () => {
  const d = endpointDetail(s2, "/pets/{id}/photo", "POST")!;
  assert.equal(d.requestBody?.contentType, "multipart/form-data");
  assert.equal(d.requestBody?.schema, "{ file: file; note: string }");
  assert.equal(d.requestBody?.required, true);
  assert.deepEqual(
    d.parameters.map((p) => `${p.in}:${p.name}:${p.type}`),
    ["path:id:integer"]
  );
});

test("E14: Swagger 2 `responses.*.schema` is the response type", () => {
  const d = endpointDetail(s2, "/pets", "POST")!;
  assert.equal(d.responses[0].schema, "Pet");
  assert.match(genTsForEndpoint(s2, d), /type Response = Pet;/);
});

// ---------------- servers / base URL ----------------

test("base URL: OpenAPI 3 relative server URL resolves against the spec URL", () => {
  const spec = { openapi: "3.0.0", servers: [{ url: "/api/v1" }], paths: {} } as OpenApiSpec;
  assert.equal(
    resolveBaseUrl(spec, "https://gw.example.com/svc/v3/api-docs"),
    "https://gw.example.com/api/v1"
  );
});

test("base URL: OpenAPI 3 server variables use their defaults", () => {
  const spec = {
    openapi: "3.0.0",
    servers: [
      {
        url: "https://{env}.example.com:{port}/v1",
        variables: { env: { default: "dev" }, port: { default: "8443" } },
      },
    ],
    paths: {},
  } as OpenApiSpec;
  assert.equal(resolveBaseUrl(spec, "https://x.test/spec"), "https://dev.example.com:8443/v1");
});

test("base URL: no servers → origin of the spec URL", () => {
  assert.equal(
    resolveBaseUrl({ openapi: "3.0.0", paths: {} }, "https://gw.example.com/a/b/api-docs"),
    "https://gw.example.com"
  );
});

test("base URL: Swagger 2 uses schemes + host + basePath, host defaulting to the spec URL's host", () => {
  assert.equal(resolveBaseUrl(s2, "http://other.test/v2/api-docs"), "https://api.example.com/v2");
  const noHost = { swagger: "2.0", basePath: "/v2", paths: {} } as OpenApiSpec;
  assert.equal(resolveBaseUrl(noHost, "http://gw.test:8080/v2/api-docs"), "http://gw.test:8080/v2");
});

test("generated client uses the resolved base URL (relative servers kept)", () => {
  const spec = {
    openapi: "3.0.0",
    servers: [{ url: "/api/v1" }],
    paths: { "/ping": { get: { operationId: "ping", responses: {} } } },
  } as OpenApiSpec;
  const d = endpointDetail(spec, "/ping", "GET")!;
  assert.match(
    genFetchClient(spec, d, "https://gw.example.com/v3/api-docs"),
    /`https:\/\/gw\.example\.com\/api\/v1\/ping`/
  );
});

// ---------------- OAS 3.1 shape ----------------

test("OAS 3.1 document without paths (components/webhooks only) loads", async () => {
  clearCache();
  const doc = {
    openapi: "3.1.0",
    info: { title: "Hooks", version: "1" },
    webhooks: { newPet: { post: { responses: {} } } },
  };
  const r = await resolveSpec("https://w.example.com/openapi.json", {
    fetcher: fetcherOf({ "https://w.example.com/openapi.json": { body: JSON.stringify(doc) } }),
  });
  assert.equal(listEndpoints(r.spec).length, 0);
});

test("$ref summary/description override the referenced object's (OAS 3.1 Reference Object)", () => {
  const spec = {
    openapi: "3.1.0",
    paths: {
      "/x": {
        get: {
          parameters: [{ $ref: "#/components/parameters/Q", description: "overridden" }],
          responses: { "200": { $ref: "#/components/responses/Ok", description: "custom ok" } },
        },
      },
    },
    components: {
      parameters: { Q: { name: "q", in: "query", description: "original" } },
      responses: { Ok: { description: "plain ok" } },
    },
  } as any;
  const d = endpointDetail(spec, "/x", "GET")!;
  assert.equal(d.parameters[0].description, "overridden");
  assert.equal(d.responses[0].description, "custom ok");
});

test("Swagger UI servers: relative → absolute, {variables} kept for Swagger UI's own picker", async () => {
  const { absoluteServerTemplate } = await import("./servers");
  assert.equal(
    absoluteServerTemplate("/api/v1", "https://gw.example.com/x/api-docs"),
    "https://gw.example.com/api/v1"
  );
  assert.equal(
    absoluteServerTemplate("/{ver}/api", "https://gw.example.com/x"),
    "https://gw.example.com/{ver}/api"
  );
  assert.equal(
    absoluteServerTemplate("https://{env}.example.com", "https://gw.example.com/x"),
    "https://{env}.example.com"
  );
  assert.equal(
    absoluteServerTemplate("v1", "https://gw.example.com/x/api-docs"),
    "https://gw.example.com/x/v1"
  );
});

test("a login-protected URL reports 'Login required' instead of falling back to another spec on the host", async () => {
  clearCache();
  await assert.rejects(
    resolveSpec("https://l.example.com/secured/v3/api-docs", {
      fetcher: fetcherOf({
        "https://l.example.com/secured/v3/api-docs": { status: 401, body: "" },
        "https://l.example.com/v3/api-docs": {
          body: JSON.stringify({ openapi: "3.0.0", info: { title: "Other" }, paths: {} }),
        },
      }),
    }),
    /Login required \(HTTP 401\)/
  );
});

test("Login required message points to the API settings (not a removed command)", async () => {
  clearCache();
  await assert.rejects(
    resolveSpec("https://l2.example.com/v3/api-docs", {
      fetcher: fetcherOf({ "https://l2.example.com/v3/api-docs": { status: 401, body: "" } }),
    }),
    (e: Error) => /API Settings/.test(e.message) && !/Set Username & Password/.test(e.message)
  );
});
