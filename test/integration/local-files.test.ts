// 1.3.0: local spec files (file://, JSON only) — load, watch, Explorer menu, settings tab.
// Rules: a local file is read only when the API itself is that file; a remote docs page or
// swagger-config cannot make the extension read a local file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fakeVscode, makeContext, startServer, waitFor, REPO_ROOT } from "../helpers/harness";
import * as ext from "../../src/extension";

const rec = fakeVscode.__rec;
const root = mkdtempSync(join(tmpdir(), "oae-local-"));
after(() => rmSync(root, { recursive: true, force: true }));
const dir = () => mkdtempSync(join(root, "d-"));

const spec = (title: string, tag: string, field = "petName") =>
  JSON.stringify({
    openapi: "3.0.1",
    info: { title, version: "1" },
    paths: { "/pets": { get: { tags: [tag], responses: { "200": { description: "ok" } } } } },
    components: { schemas: { Pet: { type: "object", properties: { [field]: { type: "string" } } } } },
  });

async function activateWith(url: string, ctx = makeContext()) {
  fakeVscode.__reset();
  rec.config["swaggerViewer.specs"] = [{ name: "local", url }];
  ext.activate(ctx.context);
  const [node] = await rec.treeProvider.getChildren();
  return { node, ctx };
}

test("a file:// JSON spec loads into the tree", async () => {
  const f = join(dir(), "openapi.json");
  writeFileSync(f, spec("Local", "pets"));
  const { node } = await activateWith(pathToFileURL(f).href);
  const tags = await rec.treeProvider.getChildren(node);
  assert.deepEqual(
    tags.map((t: any) => t.label),
    ["pets", "Models"]
  );
});

test("a file:// YAML spec is rejected with the YAML message", async () => {
  const f = join(dir(), "openapi.yaml");
  writeFileSync(f, "openapi: 3.0.1\ninfo: {title: Y, version: '1'}\npaths: {}\n");
  const { node } = await activateWith(pathToFileURL(f).href);
  const [err] = await rec.treeProvider.getChildren(node);
  assert.match(String(err.tooltip), /YAML specs are not supported/);
});

test("a missing file says so", async () => {
  const { node } = await activateWith(pathToFileURL(join(dir(), "missing.json")).href);
  const [err] = await rec.treeProvider.getChildren(node);
  assert.match(String(err.tooltip), /missing\.json.*not found/s);
});

test("a change to the file reloads it and redraws the open Swagger UI; a burst of events redraws once", async () => {
  const f = join(dir(), "openapi.json");
  writeFileSync(f, spec("Local", "pets"));
  const { node } = await activateWith(pathToFileURL(f).href);
  await rec.commands["swaggerViewer.openSwaggerUI"](node);
  assert.deepEqual(
    rec.watchers.map((w: any) => w.pattern.pattern),
    ["openapi.json"]
  );
  writeFileSync(f, spec("Local", "pets", "nickname"));
  const before = rec.htmlSets.length;
  for (let i = 0; i < 10; i++) rec.watchers[0].fire("change");
  await waitFor(() => rec.htmlSets.length > before);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(rec.htmlSets.length, before + 1);
  assert.match(rec.htmlSets.at(-1), /nickname/);
});

test("removing the API releases its file watcher", async () => {
  const f = join(dir(), "openapi.json");
  writeFileSync(f, spec("Local", "pets"));
  const { node } = await activateWith(pathToFileURL(f).href);
  await rec.treeProvider.getChildren(node);
  assert.equal(rec.watchers.filter((w: any) => !w.disposed).length, 1);
  await rec.commands["swaggerViewer.removeApi"](node);
  assert.ok(rec.watchers.every((w: any) => w.disposed));
});

test("a remote docs page or swagger-config cannot make the extension read a local file", async () => {
  const d = dir();
  const f = join(d, "secret.json");
  writeFileSync(f, spec("SECRET-LOCAL", "secret"));
  const local = pathToFileURL(f).href;
  const srv = await startServer({
    "/docs": () => ({
      type: "text/html",
      body: `<div id=swagger-ui></div><script>SwaggerUIBundle({url:"${local}"})</script>`,
    }),
    "/v3/api-docs/swagger-config": () => ({ body: JSON.stringify({ url: local }) }),
  });
  after(() => srv.close());
  const { node } = await activateWith(`${srv.origin}/docs`);
  const children = await rec.treeProvider.getChildren(node);
  const shown = JSON.stringify(children.map((c: any) => [c.label, c.tooltip]));
  assert.doesNotMatch(shown, /SECRET-LOCAL/);
  assert.doesNotMatch(shown, /Login required/);
});

test("a local file API has no host: no credentials, no legacy-token move", async () => {
  const f = join(dir(), "openapi.json");
  writeFileSync(f, spec("Local", "pets"));
  const ctx = makeContext();
  ctx.secrets["swaggerViewer.authToken"] = "legacy";
  await activateWith(pathToFileURL(f).href, ctx);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ctx.secrets["swaggerViewer.authToken"], "legacy");
});

test("Explorer → Add to OpenAPI Explorer registers a JSON spec file by its title, once", async () => {
  const f = join(dir(), "orders-openapi.json");
  writeFileSync(f, spec("Orders", "orders"));
  fakeVscode.__reset();
  ext.activate(makeContext().context);
  await rec.commands["swaggerViewer.addSpecFile"]({ fsPath: f });
  await rec.commands["swaggerViewer.addSpecFile"]({ fsPath: f });
  const specs = rec.config["swaggerViewer.specs"] ?? rec.globalConfig["swaggerViewer.specs"];
  assert.deepEqual(specs, [{ name: "Orders", url: pathToFileURL(f).href }]);
});

test("the Explorer menu entry is offered for JSON files named like specs", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const item = (pkg.contributes.menus["explorer/context"] || []).find(
    (m: any) => m.command === "swaggerViewer.addSpecFile"
  );
  assert.ok(item);
  assert.match(item.when, /resourceExtname == \.json/);
  assert.match(item.when, /resourceFilename =~ \/\(openapi\|swagger\|api-docs\)\/i/);
});

test("the settings tab accepts a file:// URL and saves no credentials for it", async () => {
  const f = join(dir(), "openapi.json");
  writeFileSync(f, spec("Local", "pets"));
  const url = pathToFileURL(f).href;
  fakeVscode.__reset();
  const ctx = makeContext();
  ext.activate(ctx.context);
  await rec.commands["swaggerViewer.addApi"]();
  const tab = rec.panels.filter((p: any) => p.viewType === "openapiExplorer.apiSettings").at(-1);
  await tab.send({
    type: "save",
    data: { name: "", url, auth: "bearer", token: "T", username: "", password: "" },
  });
  const specs = rec.config["swaggerViewer.specs"] ?? rec.globalConfig["swaggerViewer.specs"];
  assert.deepEqual(specs, [{ name: "Local", url }]);
  assert.equal(ctx.secrets["swaggerViewer.bearerTokens"], undefined);
});
