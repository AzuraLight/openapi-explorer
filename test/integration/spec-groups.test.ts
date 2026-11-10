// 1.2.0: springdoc groups appear as tree nodes; relative `servers` reach Swagger UI as absolute URLs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeVscode, makeContext, startServer } from "../helpers/harness";
import * as ext from "../../src/extension";

const spec = (title: string, tag: string, extra: object = {}) =>
  JSON.stringify({
    openapi: "3.0.1",
    info: { title, version: "1" },
    ...extra,
    paths: { "/x": { get: { tags: [tag], responses: {} } } },
  });

test("springdoc groups: spec node lists one node per group; each group loads its own tags and opens its own spec", async () => {
  const srv = await startServer({
    "/swagger-ui/index.html": () => ({ type: "text/html", body: "<html><div id=swagger-ui></div></html>" }),
    "/v3/api-docs/swagger-config": () => ({
      body: JSON.stringify({
        urls: [
          { name: "orders", url: "/v3/api-docs/orders" },
          { name: "payments", url: "/v3/api-docs/payments" },
        ],
      }),
    }),
    "/v3/api-docs/orders": () => ({ body: spec("Orders", "order-tag") }),
    "/v3/api-docs/payments": () => ({ body: spec("Payments", "payment-tag") }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  const rec = fakeVscode.__rec;
  rec.config["swaggerViewer.specs"] = [{ name: "gw", url: `${srv.origin}/swagger-ui/index.html` }];
  ext.activate(makeContext().context);

  const [root] = await rec.treeProvider.getChildren();
  const groups = await rec.treeProvider.getChildren(root);
  assert.deepEqual(
    groups.map((g: any) => g.label),
    ["orders", "payments"]
  );
  const paymentTags = await rec.treeProvider.getChildren(groups[1]);
  assert.deepEqual(
    paymentTags.map((t: any) => t.label),
    ["payment-tag"]
  );

  await rec.commands["swaggerViewer.openSwaggerUI"](groups[1]);
  assert.match(rec.htmlSets[rec.htmlSets.length - 1], /"title":"Payments"/);
});

test("search covers every springdoc group", async () => {
  const srv = await startServer({
    "/swagger-ui/index.html": () => ({ type: "text/html", body: "<html></html>" }),
    "/v3/api-docs/swagger-config": () => ({
      body: JSON.stringify({
        urls: [
          { name: "a", url: "/v3/api-docs/a" },
          { name: "b", url: "/v3/api-docs/b" },
        ],
      }),
    }),
    "/v3/api-docs/a": () => ({ body: spec("A", "ta") }),
    "/v3/api-docs/b": () => ({ body: spec("B", "tb") }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  const rec = fakeVscode.__rec;
  rec.config["swaggerViewer.specs"] = [{ name: "gw", url: `${srv.origin}/swagger-ui/index.html` }];
  ext.activate(makeContext().context);
  rec.answers.push(undefined); // cancel the quick pick
  await rec.commands["swaggerViewer.search"]();
  const pick = rec.prompts.find((p: any) => p.kind === "pick");
  assert.deepEqual(pick.items.map((i: any) => i.detail).sort(), ["gw · a · ta", "gw · b · tb"]);
});

test("relative servers are made absolute (against the spec URL) before reaching Swagger UI", async () => {
  const srv = await startServer({
    "/svc/v3/api-docs": () => ({
      body: spec("Rel", "t", { servers: [{ url: "/api/v1" }, { url: "https://abs.example.com" }] }),
    }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  const rec = fakeVscode.__rec;
  rec.config["swaggerViewer.specs"] = [{ name: "rel", url: `${srv.origin}/svc/v3/api-docs` }];
  ext.activate(makeContext().context);
  const [root] = await rec.treeProvider.getChildren();
  await rec.commands["swaggerViewer.openSwaggerUI"](root);
  const html = rec.htmlSets[rec.htmlSets.length - 1];
  const servers = JSON.parse(html.match(/const spec = (\{.*?\});\n/s)![1]).servers;
  assert.deepEqual(
    servers.map((s: any) => s.url),
    [`${srv.origin}/api/v1`, "https://abs.example.com"]
  );
});
