// Managing APIs like folders in the Explorer: ＋ / right-click "Add API" puts a "New API" node in the tree
// and opens its settings tab in the editor area, where the URL, name and credentials are entered.
// Registered APIs only expand on click; right-click → "API Settings…" opens their tab.
//
// Settings tab protocol (src/apiSettingsPanel.ts)
//   extension → tab: {type:"init", init, strings} | {type:"status", kind, text, detail?, actions?}
//   tab → extension: {type:"save"|"saveAnyway"|"test", data} | {type:"cancel"}
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  fakeVscode,
  makeContext,
  startServer,
  specJson,
  waitFor,
  REPO_ROOT,
  type TestServer,
} from "../helpers/harness";
import * as ext from "../../src/extension";

const SETTINGS = "openapiExplorer.apiSettings";
const rec = fakeVscode.__rec;
let srv: TestServer;
beforeEach(async () => {
  srv = await startServer({
    "/v3/api-docs": () => ({
      body: specJson("Smoke API", { "/ping": { get: { tags: ["health"], responses: {} } } }),
    }),
    "/secured/v3/api-docs": (req) =>
      req.headers.authorization === "Basic " + Buffer.from("u:p").toString("base64")
        ? { body: specJson("Secured API") }
        : { status: 401, body: "" },
  });
  fakeVscode.__reset();
});
afterEach(() => srv.close());

const specs = () => rec.globalConfig["swaggerViewer.specs"] ?? rec.config["swaggerViewer.specs"];
const activate = () => ext.activate(makeContext().context);
const roots = () => rec.treeProvider.getChildren();
const tabs = () => rec.panels.filter((p: any) => p.viewType === SETTINGS);
const tab = () => tabs().at(-1);
const posts = (type: string) => rec.posts.filter((m: any) => m.panel === SETTINGS && m.type === type);
const lastInit = () => posts("init").at(-1)?.init;
const lastStatus = () => posts("status").at(-1);
const data = (d: object) => ({
  name: "",
  url: "",
  auth: "none",
  token: "",
  username: "",
  password: "",
  ...d,
});
const send = (type: string, d?: object) => tab().send(d ? { type, data: data(d) } : { type });

test("package.json: Explorer-like — no section above the tree; ＋ / welcome Add API; API node menu has API Settings", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.deepEqual(
    pkg.contributes.views.swaggerViewer.map((v: any) => v.id),
    ["swaggerExplorer"]
  );
  const nls = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.nls.json"), "utf8"));
  const welcome = pkg.contributes.viewsWelcome.find((w: any) => w.view === "swaggerExplorer");
  assert.match(nls[welcome.contents.replace(/%/g, "")], /\[Add API\]\(command:swaggerViewer\.addApi\)/);
  assert.ok(pkg.contributes.menus["view/title"].some((m: any) => m.command === "swaggerViewer.addApi"));
  const item = pkg.contributes.menus["view/item/context"];
  const on = (when: RegExp) =>
    item.filter((m: any) => when.test(m.when)).map((m: any) => m.command.split(".")[1]);
  for (const c of ["addApi", "apiSettings", "copyApiUrl", "removeApi"])
    assert.ok(on(/\^spec/).includes(c), c);
  assert.deepEqual(on(/pendingApi/).sort(), ["apiSettings", "removeApi"]);
  for (const gone of ["setToken", "setBasicAuth", "editApiUrl"])
    assert.ok(!on(/\^spec/).includes(gone), `${gone} is part of API Settings now`);
});

test("Add API: a 'New API' node appears and its settings tab opens (URL prefilled from the clipboard)", async () => {
  activate();
  rec.clipboard = `${srv.origin}/v3/api-docs`;
  await rec.commands["swaggerViewer.addApi"]();
  const [pending] = await roots();
  assert.equal(pending.label, "New API");
  assert.equal(pending.contextValue, "pendingApi");
  assert.equal(tabs().length, 1);
  await waitFor(() => lastInit());
  assert.equal(lastInit().isNew, true);
  assert.equal(lastInit().url, `${srv.origin}/v3/api-docs`);
  assert.equal(rec.prompts.length, 0, "no top input box / quick pick");
});

test("Save: scans, names it from the spec title, closes the tab, replaces 'New API' with the API", async () => {
  activate();
  await rec.commands["swaggerViewer.addApi"]();
  await send("save", { url: `${srv.origin}/v3/api-docs` });
  assert.deepEqual(specs(), [{ name: "Smoke API", url: `${srv.origin}/v3/api-docs` }]);
  assert.equal(tab().disposed, true);
  assert.deepEqual(
    (await roots()).map((n: any) => n.label),
    ["Smoke API"]
  );
  assert.equal(rec.revealed.at(-1)?.el.label, "Smoke API");
});

test("closing an unsaved 'New API' tab removes the node (like an empty new folder name)", async () => {
  activate();
  await rec.commands["swaggerViewer.addApi"]();
  assert.equal((await roots()).length, 1);
  await send("cancel");
  assert.equal(tab().disposed, true);
  assert.equal((await roots()).length, 0);
  assert.equal(specs(), undefined);
});

test("Save: invalid URL / duplicate → inline error, tab stays open", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "x", url: `${srv.origin}/v3/api-docs` }];
  activate();
  await rec.commands["swaggerViewer.addApi"]();
  await send("save", { url: "not a url" });
  assert.equal(lastStatus().kind, "error");
  assert.match(lastStatus().text, /http/);
  await send("save", { url: `${srv.origin}/v3/api-docs` });
  assert.match(lastStatus().text, /already registered/);
  assert.equal(tab().disposed, false);
  assert.equal(specs().length, 1);
});

test("Save: no spec found → error with Save Anyway; Save Anyway keeps it under the host name", async () => {
  const empty = await startServer({});
  try {
    activate();
    await rec.commands["swaggerViewer.addApi"]();
    await send("save", { url: `${empty.origin}/nothing` });
    assert.deepEqual(lastStatus().actions, ["saveAnyway"]);
    assert.equal(specs(), undefined);
    await send("saveAnyway", { url: `${empty.origin}/nothing` });
    assert.deepEqual(specs(), [{ name: new URL(empty.origin).host, url: `${empty.origin}/nothing` }]);
  } finally {
    await empty.close();
  }
});

test("login-protected spec: username & password entered in the same tab; wrong password is not kept", async () => {
  const { context, secrets } = makeContext();
  ext.activate(context);
  await rec.commands["swaggerViewer.addApi"]();
  const url = `${srv.origin}/secured/v3/api-docs`;
  await send("save", { url });
  assert.match(lastStatus().text, /requires a login/);
  await send("save", { url, auth: "basic", username: "u", password: "wrong" });
  assert.equal(lastStatus().kind, "error");
  assert.equal(secrets["swaggerViewer.basicAuth"], undefined, "failed credentials are not stored");
  await send("save", { url, auth: "basic", username: "u", password: "p" });
  assert.deepEqual(specs(), [{ name: "Secured API", url }]);
  assert.match(secrets["swaggerViewer.basicAuth"], /"username":"u"/);
});

test("Test Connection reports the spec and leaves saved credentials untouched", async () => {
  const { context, secrets } = makeContext();
  ext.activate(context);
  await rec.commands["swaggerViewer.addApi"]();
  await send("test", {
    url: `${srv.origin}/secured/v3/api-docs`,
    auth: "basic",
    username: "u",
    password: "p",
  });
  assert.equal(lastStatus().kind, "ok");
  assert.match(lastStatus().text, /Secured API — 0 endpoints/);
  assert.equal(secrets["swaggerViewer.basicAuth"], undefined);
  assert.equal(specs(), undefined, "testing does not save");
});

test("API Settings on a registered API: prefilled; rename and change URL; saved secrets never sent to the tab", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "a", url: `${srv.origin}/v3/api-docs` }];
  const { context, secrets } = makeContext();
  secrets["swaggerViewer.bearerTokens"] = JSON.stringify({ [new URL(srv.origin).host]: "SECRET" });
  ext.activate(context);
  const [a] = await roots();
  await rec.commands["swaggerViewer.apiSettings"](a);
  await waitFor(() => lastInit());
  assert.deepEqual(
    { name: lastInit().name, url: lastInit().url, auth: lastInit().auth, hasToken: lastInit().hasToken },
    { name: "a", url: `${srv.origin}/v3/api-docs`, auth: "bearer", hasToken: true }
  );
  assert.ok(!JSON.stringify(posts("init")).includes("SECRET"));
  // Empty token field keeps the saved token.
  await send("save", { name: "Renamed", url: `${srv.origin}/v3/api-docs`, auth: "bearer" });
  assert.deepEqual(specs(), [{ name: "Renamed", url: `${srv.origin}/v3/api-docs` }]);
  assert.match(secrets["swaggerViewer.bearerTokens"], /SECRET/);
});

test("clicking a registered API only expands it (no command); clicking 'New API' opens its settings", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "a", url: `${srv.origin}/v3/api-docs` }];
  activate();
  await rec.commands["swaggerViewer.addApi"]();
  const [a, pending] = await roots();
  assert.equal(a.command, undefined);
  assert.equal(pending.command.command, "swaggerViewer.openApiSettings");
});

test("F2 (rename) opens the selected API's settings focused on the name", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "a", url: "https://a.example.com/x" }];
  activate();
  rec.selection = [(await roots())[0]];
  await rec.commands["swaggerViewer.renameApi"]();
  await waitFor(() => lastInit());
  assert.equal(lastInit().focus, "name");
});

test("Remove and Copy URL act on the clicked node; removing a 'New API' closes its tab", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [
    { name: "a", url: "https://a.example.com/x" },
    { name: "b", url: "https://b.example.com/api-docs" },
  ];
  activate();
  let [, b] = await roots();
  await rec.commands["swaggerViewer.copyApiUrl"](b);
  assert.equal(rec.clipboard, "https://b.example.com/api-docs");
  await rec.commands["swaggerViewer.removeApi"](b);
  assert.deepEqual(
    specs().map((s: any) => s.name),
    ["a"]
  );
  await rec.commands["swaggerViewer.addApi"]();
  const pending = (await roots()).at(-1);
  await rec.commands["swaggerViewer.removeApi"](pending);
  assert.equal(tab().disposed, true);
  assert.equal((await roots()).length, 1);
});

test("edits go to the scope that holds the entry (workspace stays workspace)", async () => {
  rec.config["swaggerViewer.specs"] = [{ name: "ws", url: `${srv.origin}/v3/api-docs` }];
  activate();
  await rec.commands["swaggerViewer.apiSettings"]((await roots())[0]);
  await send("save", { name: "Workspace API", url: `${srv.origin}/v3/api-docs` });
  assert.deepEqual(rec.config["swaggerViewer.specs"], [
    { name: "Workspace API", url: `${srv.origin}/v3/api-docs` },
  ]);
  assert.equal(rec.globalConfig["swaggerViewer.specs"], undefined);
});

test("legacy swaggerViewer.url: listed next to specs; saving its settings moves it into specs", async () => {
  rec.config["swaggerViewer.url"] = `${srv.origin}/v3/api-docs`;
  rec.config["swaggerViewer.specs"] = [{ name: "a", url: "https://a.example.com/x" }];
  activate();
  assert.deepEqual(
    (await roots()).map((n: any) => n.label),
    [new URL(srv.origin).host, "a"]
  );
  await rec.commands["swaggerViewer.apiSettings"]((await roots())[0]);
  await send("save", { name: "Legacy", url: `${srv.origin}/v3/api-docs` });
  assert.equal(rec.config["swaggerViewer.url"], undefined);
  assert.deepEqual(
    rec.config["swaggerViewer.specs"].map((s: any) => s.name),
    ["Legacy", "a"]
  );
});
