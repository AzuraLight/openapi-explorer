// Defects found in the 2026-11-13 review (functional + performance), reproduced against the real extension.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeVscode, makeContext, startServer, specJson, hostOf, waitFor } from "../helpers/harness";
import * as ext from "../../src/extension";

const TOKENS = "swaggerViewer.bearerTokens";
const rec = fakeVscode.__rec;
const swaggerPanel = () => rec.panels.filter((p: any) => p.viewType === "swaggerUi").at(-1);

test("Swagger UI: Try it out uses the current token after it changes; tokens are not written into the page", async () => {
  const seen: (string | undefined)[] = [];
  const srv = await startServer({
    "/v3/api-docs": () => ({ body: specJson("T", { "/x": { get: { tags: ["t"], responses: {} } } }) }),
    "/x": (req) => (seen.push(req.headers.authorization), { body: "{}" }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  rec.config["swaggerViewer.specs"] = [{ name: "t", url: `${srv.origin}/v3/api-docs` }];
  const ctx = makeContext();
  ctx.secrets[TOKENS] = JSON.stringify({ [hostOf(srv.origin)]: "OLD" });
  ext.activate(ctx.context);
  const [root] = await rec.treeProvider.getChildren();
  await rec.commands["swaggerViewer.openSwaggerUI"](root);
  assert.doesNotMatch(rec.htmlSets.at(-1), /OLD/);

  ctx.secrets[TOKENS] = JSON.stringify({ [hostOf(srv.origin)]: "NEW" });
  await rec.commands["swaggerViewer.refresh"]();
  const [root2] = await rec.treeProvider.getChildren();
  await rec.commands["swaggerViewer.openSwaggerUI"](root2);
  await swaggerPanel().send({
    type: "swaggerFetch",
    id: 1,
    url: `${srv.origin}/x`,
    method: "GET",
    headers: {},
  });
  await waitFor(() => seen.length > 0);
  assert.equal(seen[0], "Bearer NEW");
});

test("discovery: a docs page that names a spec on another host does not get this host's token", async () => {
  const other = await startServer(
    { "/spec.json": () => ({ body: specJson("Other", { "/o": { get: { tags: ["o"], responses: {} } } }) }) },
    "localhost"
  );
  after(() => other.close());
  const own = await startServer({
    "/docs": () => ({
      type: "text/html",
      body: `<div id=swagger-ui></div><script>SwaggerUIBundle({url:"${other.origin}/spec.json"})</script>`,
    }),
  });
  after(() => own.close());
  fakeVscode.__reset();
  rec.config["swaggerViewer.specs"] = [{ name: "a", url: `${own.origin}/docs` }];
  const ctx = makeContext();
  ctx.secrets[TOKENS] = JSON.stringify({ [hostOf(own.origin)]: "TOKEN-FOR-A" });
  ext.activate(ctx.context);
  const [root] = await rec.treeProvider.getChildren();
  const tags = await rec.treeProvider.getChildren(root);
  assert.deepEqual(
    tags.map((t: any) => t.label),
    ["o"]
  );
  assert.equal(own.requests[0].headers.authorization, "Bearer TOKEN-FOR-A");
  for (const r of other.requests) assert.equal(r.headers.authorization, undefined);
});

test("an operation without tags focuses Swagger UI's 'default' section", async () => {
  const srv = await startServer({
    "/v3/api-docs": () => ({
      body: specJson("U", { "/u": { get: { operationId: "getU", responses: {} } } }),
    }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  rec.config["swaggerViewer.specs"] = [{ name: "u", url: `${srv.origin}/v3/api-docs` }];
  ext.activate(makeContext().context);
  const [root] = await rec.treeProvider.getChildren();
  const [tag] = await rec.treeProvider.getChildren(root);
  const [op] = await rec.treeProvider.getChildren(tag);
  await rec.commands["swaggerViewer.openOperation"](op);
  assert.match(rec.htmlSets.at(-1), /"tag":"default"/);
});

test("springdoc: expanding the primary group does not fetch its spec a second time", async () => {
  const srv = await startServer({
    "/swagger-ui/index.html": () => ({ type: "text/html", body: "<html><div id=swagger-ui></div></html>" }),
    "/v3/api-docs/swagger-config": () => ({
      body: JSON.stringify({
        urls: [
          { name: "a", url: "/v3/api-docs/a" },
          { name: "b", url: "/v3/api-docs/b" },
        ],
      }),
    }),
    "/v3/api-docs/a": () => ({ body: specJson("A", { "/a": { get: { tags: ["ta"], responses: {} } } }) }),
    "/v3/api-docs/b": () => ({ body: specJson("B", { "/b": { get: { tags: ["tb"], responses: {} } } }) }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  rec.config["swaggerViewer.specs"] = [{ name: "gw", url: `${srv.origin}/swagger-ui/index.html` }];
  ext.activate(makeContext().context);
  const [root] = await rec.treeProvider.getChildren();
  const groups = await rec.treeProvider.getChildren(root);
  await rec.treeProvider.getChildren(groups[0]);
  assert.equal(srv.requests.filter((r) => r.url === "/v3/api-docs/a").length, 1);
});

test("saving one API's settings does not re-download the other APIs", async () => {
  const a = await startServer({
    "/v3/api-docs": () => ({ body: specJson("A", { "/a": { get: { tags: ["ta"], responses: {} } } }) }),
  });
  const b = await startServer(
    { "/v3/api-docs": () => ({ body: specJson("B", { "/b": { get: { tags: ["tb"], responses: {} } } }) }) },
    "localhost"
  );
  after(() => a.close());
  after(() => b.close());
  fakeVscode.__reset();
  rec.config["swaggerViewer.specs"] = [
    { name: "A", url: `${a.origin}/v3/api-docs` },
    { name: "B", url: `${b.origin}/v3/api-docs` },
  ];
  ext.activate(makeContext().context);
  const roots = await rec.treeProvider.getChildren();
  await rec.treeProvider.getChildren(roots[0]);
  await rec.treeProvider.getChildren(roots[1]);
  const aBefore = a.requests.length;
  // Rename B in its settings tab.
  await rec.commands["swaggerViewer.apiSettings"](roots[1]);
  const tab = rec.panels.filter((p: any) => p.viewType === "openapiExplorer.apiSettings").at(-1);
  await tab.send({
    type: "save",
    data: { name: "B2", url: `${b.origin}/v3/api-docs`, auth: "none", token: "", username: "", password: "" },
  });
  const roots2 = await rec.treeProvider.getChildren();
  await rec.treeProvider.getChildren(roots2[0]);
  await rec.treeProvider.getChildren(roots2[1]);
  assert.equal(a.requests.length, aBefore, "API A was not re-downloaded");
});

test("expanding every tag of a large spec stays fast (tags are grouped once per spec)", async () => {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < 20000; i++) paths[`/r${i}`] = { get: { tags: [`tag${i % 1000}`], responses: {} } };
  const srv = await startServer({ "/v3/api-docs": () => ({ body: specJson("Big", paths) }) });
  after(() => srv.close());
  fakeVscode.__reset();
  rec.config["swaggerViewer.specs"] = [{ name: "big", url: `${srv.origin}/v3/api-docs` }];
  ext.activate(makeContext().context);
  const [root] = await rec.treeProvider.getChildren();
  const tags = await rec.treeProvider.getChildren(root);
  const t0 = Date.now();
  for (const t of tags) await rec.treeProvider.getChildren(t);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `expanding ${tags.length} tags took ${ms} ms`);
});

test("the Swagger UI panel does not keep its page alive while hidden (state is saved instead)", async () => {
  const srv = await startServer({
    "/v3/api-docs": () => ({ body: specJson("H", { "/h": { get: { tags: ["h"], responses: {} } } }) }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  rec.config["swaggerViewer.specs"] = [{ name: "h", url: `${srv.origin}/v3/api-docs` }];
  ext.activate(makeContext().context);
  const [root] = await rec.treeProvider.getChildren();
  await rec.commands["swaggerViewer.openSwaggerUI"](root);
  assert.equal(swaggerPanel().options.retainContextWhenHidden, false);
});
