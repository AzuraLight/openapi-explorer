// Managing APIs like folders in the Explorer, without the top input box: an inline input section
// (webview view "swaggerApiInput") above the tree is used to add, rename and edit URLs.
//
// Protocol
//   extension → view: {type:"open", mode, value, label} | {type:"busy", text} |
//                     {type:"error", text, detail, actions} | {type:"login"} | {type:"close"}
//   view → extension: {type:"ready"} | {type:"submit", value} | {type:"saveAnyway"} |
//                     {type:"login", username, password} | {type:"cancel"}
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

const VIEW = "swaggerApiInput";
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
const view = () => rec.views[VIEW];
const posts = (type?: string) => rec.viewPosts.filter((m: any) => !type || m.type === type);
const lastPost = (type: string) => posts(type).at(-1);
const send = async (m: object) => {
  await view().send(m);
};
// Open the inline input via a command and wait for it to be shown.
async function open(command: string, arg?: unknown) {
  await rec.commands[command](arg);
  await waitFor(() => view() && lastPost("open"));
}

test("package.json: Explorer-like empty state (message + Add API button); inline input only on demand; ＋ and node menus; F2/Delete", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const views = pkg.contributes.views.swaggerViewer;
  assert.equal(views[0].id, VIEW);
  assert.equal(views[0].type, "webview");
  assert.equal(views[0].when, "swaggerViewer.inputOpen", "the input only appears when asked for");
  assert.equal(views[1].id, "swaggerExplorer");
  // Empty state like the Explorer with no folder: a short message and one button.
  const nls = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.nls.json"), "utf8"));
  const welcome = pkg.contributes.viewsWelcome.find((w: any) => w.view === "swaggerExplorer");
  const text = nls[welcome.contents.replace(/%/g, "")];
  assert.match(text, /\[Add API\]\(command:swaggerViewer\.addApi\)/);
  assert.doesNotMatch(text, /setUrl/);
  const title = pkg.contributes.menus["view/title"];
  assert.ok(title.some((m: any) => m.command === "swaggerViewer.addApi" && /^navigation/.test(m.group)));
  const item = pkg.contributes.menus["view/item/context"].filter((m: any) => /\^spec/.test(m.when));
  for (const c of ["addApi", "renameApi", "editApiUrl", "copyApiUrl", "removeApi"])
    assert.ok(
      item.some((m: any) => m.command === `swaggerViewer.${c}`),
      `${c} on API node menu`
    );
  const keys = pkg.contributes.keybindings;
  assert.ok(keys.some((k: any) => k.command === "swaggerViewer.renameApi" && k.key === "f2"));
  assert.ok(
    keys.some(
      (k: any) => k.command === "swaggerViewer.removeApi" && /focusedView == swaggerExplorer/.test(k.when)
    )
  );
});

test("Add API opens the inline input (no top input box), prefilled from the clipboard URL", async () => {
  activate();
  rec.clipboard = `${srv.origin}/v3/api-docs`;
  await open("swaggerViewer.addApi");
  assert.equal(rec.context["swaggerViewer.inputOpen"], true);
  assert.ok(rec.executed.some((c: any[]) => c[0] === `${VIEW}.focus`));
  assert.deepEqual(
    { mode: lastPost("open").mode, value: lastPost("open").value },
    { mode: "add", value: `${srv.origin}/v3/api-docs` }
  );
  assert.equal(rec.prompts.length, 0, "showInputBox / showQuickPick are not used");
});

test("Add: Enter scans, saves with the spec title as name, closes the input and reveals the node", async () => {
  activate();
  await open("swaggerViewer.addApi");
  await send({ type: "submit", value: `${srv.origin}/v3/api-docs` });
  assert.ok(posts("busy").length > 0, "shows progress inline");
  assert.deepEqual(specs(), [{ name: "Smoke API", url: `${srv.origin}/v3/api-docs` }]);
  assert.ok(lastPost("close"));
  assert.equal(rec.context["swaggerViewer.inputOpen"], false);
  assert.equal(rec.revealed[0]?.el.label, "Smoke API");
});

test("Add: invalid URL → inline error, nothing saved, input stays open", async () => {
  activate();
  await open("swaggerViewer.addApi");
  await send({ type: "submit", value: "not a url" });
  assert.match(lastPost("error").text, /http/);
  assert.equal(specs(), undefined);
  assert.equal(rec.context["swaggerViewer.inputOpen"], true);
});

test("Add: no spec found → inline error with Save Anyway / Edit; Save Anyway keeps it under the host name", async () => {
  const empty = await startServer({});
  try {
    activate();
    await open("swaggerViewer.addApi");
    await send({ type: "submit", value: `${empty.origin}/nothing` });
    assert.deepEqual(lastPost("error").actions, ["saveAnyway", "edit"]);
    assert.equal(specs(), undefined);
    await send({ type: "saveAnyway" });
    assert.deepEqual(specs(), [{ name: new URL(empty.origin).host, url: `${empty.origin}/nothing` }]);
  } finally {
    await empty.close();
  }
});

test("Add: login required (401) → inline username/password; logging in saves it named from the spec", async () => {
  activate();
  await open("swaggerViewer.addApi");
  await send({ type: "submit", value: `${srv.origin}/secured/v3/api-docs` });
  assert.deepEqual(lastPost("error").actions, ["login", "edit"]);
  await send({ type: "login", username: "u", password: "p" });
  assert.deepEqual(specs(), [{ name: "Secured API", url: `${srv.origin}/secured/v3/api-docs` }]);
  assert.equal(rec.prompts.length, 0, "credentials were entered inline, not in the top input box");
});

test("Add: wrong password → stays on the login error, nothing saved", async () => {
  activate();
  await open("swaggerViewer.addApi");
  await send({ type: "submit", value: `${srv.origin}/secured/v3/api-docs` });
  await send({ type: "login", username: "u", password: "wrong" });
  assert.deepEqual(lastPost("error").actions, ["login", "edit"]);
  assert.equal(specs(), undefined);
});

test("Add: a URL that is already registered is rejected inline", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "x", url: `${srv.origin}/v3/api-docs` }];
  activate();
  await open("swaggerViewer.addApi");
  await send({ type: "submit", value: `${srv.origin}/v3/api-docs` });
  assert.match(lastPost("error").text, /already registered/);
  assert.equal(specs().length, 1);
});

test("Escape (cancel) closes the input without saving", async () => {
  activate();
  await open("swaggerViewer.addApi");
  await send({ type: "cancel" });
  assert.equal(rec.context["swaggerViewer.inputOpen"], false);
  assert.equal(specs(), undefined);
});

test("Rename (F2) and Edit URL use the same inline input, prefilled with the current value", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [
    { name: "a", url: `${srv.origin}/v3/api-docs` },
    { name: "b", url: "https://b.example.com/api-docs" },
  ];
  activate();
  const [, b] = await roots();
  await open("swaggerViewer.renameApi", b);
  assert.deepEqual(
    { mode: lastPost("open").mode, value: lastPost("open").value },
    { mode: "rename", value: "b" }
  );
  await send({ type: "submit", value: "Bee" });
  assert.equal(specs()[1].name, "Bee");

  rec.selection = [(await roots())[1]]; // keyboard path: no argument → selected node
  await open("swaggerViewer.editApiUrl");
  assert.equal(lastPost("open").mode, "editUrl");
  assert.equal(lastPost("open").value, "https://b.example.com/api-docs");
  await send({ type: "submit", value: "https://bee.example.com/api-docs" });
  assert.equal(specs()[1].url, "https://bee.example.com/api-docs");
});

test("Copy URL and Remove act on the clicked node; Remove asks nothing (like Remove Folder from Workspace)", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [
    { name: "a", url: "https://a.example.com/x" },
    { name: "b", url: "https://b.example.com/api-docs" },
  ];
  activate();
  let [, b] = await roots();
  await rec.commands["swaggerViewer.copyApiUrl"](b);
  assert.equal(rec.clipboard, "https://b.example.com/api-docs");
  [, b] = await roots();
  await rec.commands["swaggerViewer.removeApi"](b);
  assert.deepEqual(
    specs().map((s: any) => s.name),
    ["a"]
  );
});

test("edits go to the scope that holds the entry (workspace stays workspace)", async () => {
  rec.config["swaggerViewer.specs"] = [{ name: "ws", url: "https://ws.example.com/x" }];
  activate();
  await open("swaggerViewer.renameApi", (await roots())[0]);
  await send({ type: "submit", value: "Workspace API" });
  assert.deepEqual(rec.config["swaggerViewer.specs"], [
    { name: "Workspace API", url: "https://ws.example.com/x" },
  ]);
  assert.equal(rec.globalConfig["swaggerViewer.specs"], undefined);
});

test("legacy swaggerViewer.url: listed next to specs; Rename moves it into specs; Remove clears it", async () => {
  rec.config["swaggerViewer.url"] = "https://legacy.example.com/api-docs";
  rec.config["swaggerViewer.specs"] = [{ name: "a", url: "https://a.example.com/x" }];
  activate();
  assert.deepEqual(
    (await roots()).map((n: any) => n.label),
    ["legacy.example.com", "a"]
  );
  await open("swaggerViewer.renameApi", (await roots())[0]);
  await send({ type: "submit", value: "Legacy" });
  assert.equal(rec.config["swaggerViewer.url"], undefined);
  assert.deepEqual(
    rec.config["swaggerViewer.specs"].map((s: any) => s.name),
    ["Legacy", "a"]
  );
  rec.config["swaggerViewer.url"] = "https://legacy2.example.com/api-docs";
  await rec.commands["swaggerViewer.removeApi"]((await roots())[0]);
  assert.equal(rec.config["swaggerViewer.url"], undefined);
});
