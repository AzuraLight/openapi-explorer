// Adding and managing APIs like folders in the Explorer: ＋ / right-click "Add API…", Rename, Edit URL,
// Copy URL, Remove. URL first (scanned right away), name prefilled from the spec.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  fakeVscode,
  makeContext,
  startServer,
  specJson,
  REPO_ROOT,
  type TestServer,
} from "../helpers/harness";
import * as ext from "../../src/extension";

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

test("package.json: empty view offers Add API; ＋ in the view title; Add/Rename/Edit/Copy/Remove on API nodes", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const nls = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.nls.json"), "utf8"));
  assert.match(
    nls[pkg.contributes.viewsWelcome[0].contents.replace(/%/g, "")],
    /command:swaggerViewer\.addApi/
  );
  const title = pkg.contributes.menus["view/title"];
  assert.ok(title.some((m: any) => m.command === "swaggerViewer.addApi" && /^navigation/.test(m.group)));
  const item = pkg.contributes.menus["view/item/context"].filter((m: any) => /\^spec/.test(m.when));
  for (const c of ["addApi", "renameApi", "editApiUrl", "copyApiUrl", "removeApi"])
    assert.ok(
      item.some((m: any) => m.command === `swaggerViewer.${c}`),
      `${c} on API node menu`
    );
  assert.ok(
    !pkg.contributes.commands.some((c: any) => c.command === "swaggerViewer.setUrl"),
    "Set URL removed"
  );
  const keys = pkg.contributes.keybindings;
  assert.ok(
    keys.some(
      (k: any) =>
        k.command === "swaggerViewer.renameApi" &&
        k.key === "f2" &&
        /focusedView == swaggerExplorer/.test(k.when)
    )
  );
  assert.ok(
    keys.some(
      (k: any) => k.command === "swaggerViewer.removeApi" && /focusedView == swaggerExplorer/.test(k.when)
    )
  );
});

test("Add API: URL prefilled from the clipboard, scanned, name prefilled from info.title, saved and revealed", async () => {
  activate();
  rec.clipboard = `${srv.origin}/v3/api-docs`;
  rec.answers.push(`${srv.origin}/v3/api-docs`, "Smoke API");
  await rec.commands["swaggerViewer.addApi"]();
  const [urlPrompt, namePrompt] = rec.prompts.filter((p: any) => p.kind === "input");
  assert.equal(urlPrompt.options.value, `${srv.origin}/v3/api-docs`);
  assert.equal(urlPrompt.options.ignoreFocusOut, true, "stays open while copying the URL elsewhere");
  assert.equal(namePrompt.options.value, "Smoke API");
  assert.deepEqual(specs(), [{ name: "Smoke API", url: `${srv.origin}/v3/api-docs` }]);
  assert.equal(rec.progress.length, 1, "scan shows progress");
  assert.equal(rec.revealed[0]?.el.label, "Smoke API");
});

test("Add API: clipboard text that is not a URL is not prefilled; invalid URLs are rejected inline", async () => {
  activate();
  rec.clipboard = "hello world";
  rec.answers.push(undefined);
  await rec.commands["swaggerViewer.addApi"]();
  const p = rec.prompts[0];
  assert.equal(p.options.value ?? "", "");
  assert.ok(p.options.validateInput("not a url"));
  assert.equal(p.options.validateInput("https://gw.example.com/api-docs"), undefined);
});

test("Add API: spec not found → Save Anyway keeps it (name defaults to host); cancel saves nothing", async () => {
  const empty = await startServer({}); // no spec anywhere, so auto-discovery finds nothing
  try {
    activate();
    rec.answers.push(`${empty.origin}/nothing-here`, undefined);
    await rec.commands["swaggerViewer.addApi"]();
    assert.equal(specs(), undefined, "dismissing the error saves nothing");
    rec.answers.push(`${empty.origin}/nothing-here`, "Save Anyway", undefined);
    await rec.commands["swaggerViewer.addApi"]();
    // name prompt cancelled → falls back to host
    assert.deepEqual(specs(), [{ name: new URL(empty.origin).host, url: `${empty.origin}/nothing-here` }]);
  } finally {
    await empty.close();
  }
});

test("Add API: Edit URL from the error reopens the URL box with the entered value", async () => {
  const empty = await startServer({});
  try {
    activate();
    rec.answers.push(`${empty.origin}/typo`, "Edit URL", `${srv.origin}/v3/api-docs`, "Fixed");
    await rec.commands["swaggerViewer.addApi"]();
    const urlPrompts = rec.prompts.filter((p: any) => p.kind === "input" && /1\/2/.test(p.options.title));
    assert.equal(urlPrompts[1].options.value, `${empty.origin}/typo`);
    assert.deepEqual(specs(), [{ name: "Fixed", url: `${srv.origin}/v3/api-docs` }]);
  } finally {
    await empty.close();
  }
});

test("Add API: login required (401) → Save and Log In asks username/password, then the spec loads", async () => {
  activate();
  rec.answers.push(`${srv.origin}/secured/v3/api-docs`, "Save and Log In", "u", "p");
  await rec.commands["swaggerViewer.addApi"]();
  assert.equal(specs().length, 1);
  const [root] = await roots();
  const children = await rec.treeProvider.getChildren(root);
  assert.notEqual(children[0]?.label, "Failed to load");
});

test("Add API: a URL that is already registered is not added twice", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "x", url: `${srv.origin}/v3/api-docs` }];
  activate();
  rec.answers.push(`${srv.origin}/v3/api-docs`);
  await rec.commands["swaggerViewer.addApi"]();
  assert.equal(specs().length, 1);
  assert.ok(rec.msgs.some((m: string) => /already registered/.test(m)));
});

test("Rename / Edit URL / Copy URL / Remove act on the clicked node", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [
    { name: "a", url: `${srv.origin}/v3/api-docs` },
    { name: "b", url: "https://b.example.com/api-docs" },
  ];
  activate();
  let [, b] = await roots();
  rec.answers.push("Bee");
  await rec.commands["swaggerViewer.renameApi"](b);
  assert.equal(specs()[1].name, "Bee");

  [, b] = await roots();
  rec.answers.push("https://bee.example.com/api-docs");
  await rec.commands["swaggerViewer.editApiUrl"](b);
  assert.equal(specs()[1].url, "https://bee.example.com/api-docs");

  [, b] = await roots();
  await rec.commands["swaggerViewer.copyApiUrl"](b);
  assert.equal(rec.clipboard, "https://bee.example.com/api-docs");

  [, b] = await roots();
  await rec.commands["swaggerViewer.removeApi"](b);
  assert.deepEqual(
    specs().map((s: any) => s.name),
    ["a"]
  );
});

test("keyboard (F2 / Delete): without an argument the selected tree node is used", async () => {
  rec.globalConfig["swaggerViewer.specs"] = [{ name: "a", url: "https://a.example.com/x" }];
  activate();
  rec.selection = [(await roots())[0]];
  rec.answers.push("Renamed");
  await rec.commands["swaggerViewer.renameApi"]();
  assert.equal(specs()[0].name, "Renamed");
});

test("edits go to the scope that holds the entry (workspace stays workspace)", async () => {
  rec.config["swaggerViewer.specs"] = [{ name: "ws", url: "https://ws.example.com/x" }];
  activate();
  rec.answers.push("Workspace API");
  await rec.commands["swaggerViewer.renameApi"]((await roots())[0]);
  assert.deepEqual(rec.config["swaggerViewer.specs"], [
    { name: "Workspace API", url: "https://ws.example.com/x" },
  ]);
  assert.equal(rec.globalConfig["swaggerViewer.specs"], undefined);
});

test("legacy swaggerViewer.url: still listed next to specs; Remove clears it; Rename moves it into specs", async () => {
  rec.config["swaggerViewer.url"] = "https://legacy.example.com/api-docs";
  rec.config["swaggerViewer.specs"] = [{ name: "a", url: "https://a.example.com/x" }];
  activate();
  let labels = (await roots()).map((n: any) => n.label);
  assert.deepEqual(labels, ["legacy.example.com", "a"], "url is no longer hidden once specs is non-empty");

  rec.answers.push("Legacy");
  await rec.commands["swaggerViewer.renameApi"]((await roots())[0]);
  assert.equal(rec.config["swaggerViewer.url"], undefined);
  assert.deepEqual(
    rec.config["swaggerViewer.specs"].map((s: any) => s.name),
    ["Legacy", "a"],
    "renamed legacy entry keeps its position"
  );

  rec.config["swaggerViewer.url"] = "https://legacy2.example.com/api-docs";
  await rec.commands["swaggerViewer.removeApi"]((await roots())[0]);
  assert.equal(rec.config["swaggerViewer.url"], undefined);
  labels = (await roots()).map((n: any) => n.label);
  assert.deepEqual(labels, ["Legacy", "a"]);
});
