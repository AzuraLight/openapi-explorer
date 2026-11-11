// Edge cases of the API settings flow (found by probing and by an independent review). Each test states the
// correct behavior.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeVscode, makeContext, startServer, specJson, waitFor, type TestServer } from "../helpers/harness";
import * as ext from "../../src/extension";

const SETTINGS = "openapiExplorer.apiSettings";
const rec = fakeVscode.__rec;
let srv: TestServer;
let slowRelease: (() => void) | undefined;
beforeEach(async () => {
  srv = await startServer({
    "/v3/api-docs": () => ({ body: specJson("Smoke API") }),
    "/other/v3/api-docs": () => ({ body: specJson("Other API") }),
  });
  fakeVscode.__reset();
});
afterEach(async () => {
  slowRelease?.();
  await srv.close();
});

const specs = () => rec.globalConfig["swaggerViewer.specs"] ?? rec.config["swaggerViewer.specs"];
const roots = () => rec.treeProvider.getChildren();
const tabs = () => rec.panels.filter((p: any) => p.viewType === SETTINGS);
const tab = () => tabs().at(-1);
const lastStatus = () => rec.posts.filter((m: any) => m.panel === SETTINGS && m.type === "status").at(-1);
const data = (d: object) => ({
  name: "",
  url: "",
  auth: "none",
  token: "",
  username: "",
  password: "",
  deleteToken: false,
  deletePassword: false,
  ...d,
});

test("E1 double Save (Enter twice quickly) must not register the API twice", async () => {
  ext.activate(makeContext().context);
  await rec.commands["swaggerViewer.addApi"]();
  const t = tab();
  const url = `${srv.origin}/v3/api-docs`;
  await Promise.all([
    t.send({ type: "save", data: data({ url }) }),
    t.send({ type: "save", data: data({ url }) }),
  ]);
  assert.equal(specs()?.length, 1, `registered ${specs()?.length} times`);
});

test("E2 trailing slash: same API with/without '/' is a duplicate", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "x", url: `${srv.origin}/v3/api-docs` }];
  ext.activate(makeContext().context);
  await rec.commands["swaggerViewer.addApi"]();
  await tab().send({ type: "save", data: data({ url: `${srv.origin}/v3/api-docs/` }) });
  assert.equal(specs().length, 1, "added a second entry for the same spec");
});

test("E3 Bearer chosen with no token and nothing saved → error, not a silent save without auth", async () => {
  ext.activate(makeContext().context);
  await rec.commands["swaggerViewer.addApi"]();
  await tab().send({ type: "save", data: data({ url: `${srv.origin}/v3/api-docs`, auth: "bearer" }) });
  assert.equal(lastStatus()?.kind, "error", `status: ${JSON.stringify(lastStatus())}`);
});

test("E4 Cancel while Save is scanning must not register the API afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  slowRelease = release;
  // A server that holds its response until released, so the save is still scanning when Cancel arrives.
  const http = await import("node:http");
  const hold = http.createServer(async (_q, r) => {
    await gate;
    r.setHeader("content-type", "application/json");
    r.end(specJson("Held API"));
  });
  await new Promise<void>((ok) => hold.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(hold.address() as any).port}/v3/api-docs`;
  try {
    ext.activate(makeContext().context);
    await rec.commands["swaggerViewer.addApi"]();
    const t = tab();
    const saving = t.send({ type: "save", data: data({ url }) });
    await new Promise((r) => setTimeout(r, 100));
    await t.send({ type: "cancel" });
    release();
    await saving;
    assert.equal(specs(), undefined, "saved although the user cancelled");
  } finally {
    hold.close();
  }
});

test("E5 changing the URL to another host: the old host's credentials are not left behind silently / new host gets them", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "a", url: `${srv.origin}/v3/api-docs` }];
  const { context, secrets } = makeContext();
  const oldHost = new URL(srv.origin).host;
  secrets["swaggerViewer.bearerTokens"] = JSON.stringify({ [oldHost]: "OLD" });
  ext.activate(context);
  await rec.commands["swaggerViewer.apiSettings"]((await roots())[0]);
  await waitFor(() => tab());
  const other = await startServer({ "/v3/api-docs": () => ({ body: specJson("Moved") }) }, "localhost");
  try {
    // Keep bearer with empty token (= "keep saved"): the saved token belongs to the OLD host.
    await tab().send({
      type: "saveAnyway",
      data: data({ name: "a", url: `${other.origin}/v3/api-docs`, auth: "bearer" }),
    });
    const map = JSON.parse(secrets["swaggerViewer.bearerTokens"] || "{}");
    const newHost = new URL(other.origin).host;
    assert.ok(
      map[newHost] === "OLD" || lastStatus()?.kind === "error",
      `new host token: ${map[newHost]}; map ${JSON.stringify(map)}`
    );
  } finally {
    await other.close();
  }
});

test("E6 entry removed elsewhere (settings.json) while its tab is open → Save reports it, not a silent no-op", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "a", url: `${srv.origin}/v3/api-docs` }];
  ext.activate(makeContext().context);
  await rec.commands["swaggerViewer.apiSettings"]((await roots())[0]);
  await waitFor(() => tab());
  rec.globalConfig["swaggerViewer.specs"] = [];
  await tab().send({ type: "save", data: data({ name: "renamed", url: `${srv.origin}/v3/api-docs` }) });
  const saved = specs().some((s: any) => s.name === "renamed");
  assert.ok(
    saved || lastStatus()?.kind === "error",
    `entry gone, tab disposed=${tab().disposed}, specs=${JSON.stringify(specs())}`
  );
});

test("E7 two New API tabs at once: saving one keeps the other pending", async () => {
  ext.activate(makeContext().context);
  await rec.commands["swaggerViewer.addApi"]();
  const first = tab();
  await rec.commands["swaggerViewer.addApi"]();
  const second = tab();
  assert.notEqual(first, second);
  await second.send({ type: "save", data: data({ url: `${srv.origin}/v3/api-docs` }) });
  const labels = (await roots()).map((n: any) => n.label);
  assert.deepEqual(labels, ["Smoke API", "New API"]);
  assert.equal(first.disposed, false);
});

test("E8 name of only spaces falls back to the spec title", async () => {
  ext.activate(makeContext().context);
  await rec.commands["swaggerViewer.addApi"]();
  await tab().send({ type: "save", data: data({ name: "   ", url: `${srv.origin}/v3/api-docs` }) });
  assert.equal(specs()[0].name, "Smoke API");
});

test("E9 malformed messages from the tab are ignored (no crash, nothing saved)", async () => {
  ext.activate(makeContext().context);
  await rec.commands["swaggerViewer.addApi"]();
  for (const m of [
    null,
    42,
    "x",
    { type: "save" },
    { type: "save", data: { url: 123, auth: "root" } },
    { type: "useLegacy" },
  ])
    await tab().send(m as any);
  assert.equal(specs(), undefined);
});

test("E10 Test Connection while saved credentials exist: they are exactly restored afterwards", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "a", url: `${srv.origin}/v3/api-docs` }];
  const { context, secrets } = makeContext();
  const host = new URL(srv.origin).host;
  secrets["swaggerViewer.basicAuth"] = JSON.stringify({ [host]: { username: "keep", password: "me" } });
  ext.activate(context);
  await rec.commands["swaggerViewer.apiSettings"]((await roots())[0]);
  await waitFor(() => tab());
  await tab().send({
    type: "test",
    data: data({ url: `${srv.origin}/v3/api-docs`, auth: "bearer", token: "T" }),
  });
  assert.deepEqual(JSON.parse(secrets["swaggerViewer.basicAuth"]), {
    [host]: { username: "keep", password: "me" },
  });
  assert.equal(secrets["swaggerViewer.bearerTokens"], undefined);
});

test("E11 draft of an API whose URL is then changed elsewhere does not resurface on a different API", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "a", url: `${srv.origin}/v3/api-docs` }];
  ext.activate(makeContext().context);
  await rec.commands["swaggerViewer.apiSettings"]((await roots())[0]);
  await waitFor(() => tab());
  await tab().send({
    type: "dirty",
    dirty: true,
    data: data({ name: "draft", url: `${srv.origin}/v3/api-docs` }),
  });
  rec.answers.push(undefined);
  tab().dispose();
  // Re-add the same URL as a brand-new API after removing it: the old draft must not appear.
  await rec.commands["swaggerViewer.removeApi"]((await roots())[0]);
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "b", url: `${srv.origin}/v3/api-docs` }];
  await rec.commands["swaggerViewer.apiSettings"]((await roots())[0]);
  const init = rec.posts.filter((m: any) => m.panel === SETTINGS && m.type === "init").at(-1).init;
  assert.equal(init.draft, undefined, "stale draft from a removed API reappeared");
});

// ---- from the independent review ----

test("R1 Test Connection never writes the stored secrets (no window where other requests see trial values)", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "a", url: `${srv.origin}/v3/api-docs` }];
  const { context } = makeContext();
  const writes: string[] = [];
  const store = context.secrets.store;
  context.secrets.store = async (k: string, v: string) => (writes.push(k), store(k, v));
  const del = context.secrets.delete;
  context.secrets.delete = async (k: string) => (writes.push(`-${k}`), del(k));
  ext.activate(context);
  await rec.commands["swaggerViewer.apiSettings"]((await roots())[0]);
  await waitFor(() => tab());
  await tab().send({
    type: "test",
    data: data({ url: `${srv.origin}/v3/api-docs`, auth: "bearer", token: "T" }),
  });
  assert.equal(lastStatus()?.kind, "ok");
  assert.deepEqual(writes, []);
});

test("R5 an API sharing its host with others is told so in its settings (credentials are per host)", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [
    { name: "a", url: `${srv.origin}/v3/api-docs` },
    { name: "b", url: `${srv.origin}/other/v3/api-docs` },
  ];
  ext.activate(makeContext().context);
  await rec.commands["swaggerViewer.apiSettings"]((await roots())[0]);
  await waitFor(() => tab());
  const init = rec.posts.filter((m: any) => m.panel === SETTINGS && m.type === "init").at(-1).init;
  assert.deepEqual(init.sharedWith, ["b"]);
});

test("R7 with a folder open and the list in user settings, a new API is added to the user list (not hiding it)", async () => {
  const vscode = fakeVscode as any; // the fake vscode module (same object the extension imports)
  const before = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/ws" }, name: "ws", index: 0 }];
  try {
    rec.globalConfig["swaggerViewer.specs"] = [{ name: "user api", url: "https://u.example.com/x" }];
    ext.activate(makeContext().context);
    await rec.commands["swaggerViewer.addApi"]();
    await tab().send({ type: "save", data: data({ url: `${srv.origin}/v3/api-docs` }) });
    assert.equal(rec.config["swaggerViewer.specs"], undefined, "nothing written to the workspace");
    assert.deepEqual(
      rec.globalConfig["swaggerViewer.specs"].map((s: any) => s.name),
      ["user api", "Smoke API"]
    );
  } finally {
    vscode.workspace.workspaceFolders = before;
  }
});

test("R-legacy 'Use for this API' in one tab stops the other open tabs from offering it", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [
    { name: "a", url: `${srv.origin}/v3/api-docs` },
    { name: "b", url: "https://b.example.com/x" },
  ];
  const { context, secrets } = makeContext();
  secrets["swaggerViewer.authToken"] = "legacy";
  rec.answers.push(undefined);
  ext.activate(context);
  const [a, b] = await roots();
  await rec.commands["swaggerViewer.apiSettings"](a);
  await waitFor(() => tabs().length === 1);
  const tabA = tab();
  await rec.commands["swaggerViewer.apiSettings"](b);
  await waitFor(() => tabs().length === 2);
  await tab().send({ type: "useLegacy" });
  const updatesForA = rec.posts.filter(
    (m: any) => m.type === "update" && m.init?.key === `${srv.origin}/v3/api-docs`
  );
  assert.ok(
    updatesForA.some((m: any) => m.init.legacyToken === false),
    "tab A still offers the legacy token"
  );
  assert.equal(tabA.disposed, false);
});

test("R-clipboard a URL with credentials in it (user:pass@) is not prefilled", async () => {
  ext.activate(makeContext().context);
  rec.clipboard = "https://user:secret@api.example.com/v3/api-docs";
  await rec.commands["swaggerViewer.addApi"]();
  await waitFor(() => rec.posts.some((m: any) => m.panel === SETTINGS && m.type === "init"));
  const init = rec.posts.filter((m: any) => m.panel === SETTINGS && m.type === "init").at(-1).init;
  assert.equal(init.url, "");
});
