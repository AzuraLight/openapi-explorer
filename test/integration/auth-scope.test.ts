// R4: credentials are scoped per host (npm/git/gh/curl convention) — a token for host A is never sent to host B.
// Credentials are entered in the API settings tab (editor area), never in the top input box.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  fakeVscode,
  makeContext,
  startServer,
  specJson,
  waitFor,
  hostOf,
  type TestServer,
} from "../helpers/harness";
import * as ext from "../../src/extension";

const LEGACY_KEY = "swaggerViewer.authToken";
let A: TestServer, B: TestServer;
const rec = fakeVscode.__rec;

beforeEach(async () => {
  A = await startServer({ "/v3/api-docs": () => ({ body: specJson("A") }) }, "127.0.0.1");
  B = await startServer({ "/v3/api-docs": () => ({ body: specJson("B") }) }, "localhost");
  fakeVscode.__reset();
});
afterEach(async () => {
  await A.close();
  await B.close();
});

const authOf = (s: TestServer) => s.requests.map((r) => r.headers.authorization);

async function loadAllSpecs() {
  // Refresh drops caches so every spec is fetched again with the current credentials.
  await rec.commands["swaggerViewer.refresh"]();
  for (const root of await rec.treeProvider.getChildren()) await rec.treeProvider.getChildren(root);
}

function register(...servers: TestServer[]) {
  rec.config["swaggerViewer.specs"] = servers.map((s, i) => ({
    name: `s${i}`,
    url: `${s.origin}/v3/api-docs`,
  }));
}

const SETTINGS = "openapiExplorer.apiSettings";
const lastInit = () => rec.posts.filter((m: any) => m.panel === SETTINGS && m.type === "init").at(-1)?.init;
// Open a node's settings tab through `command`, then save it with `fields` (URL/name taken from the tab).
async function saveSettings(command: string, node: any, fields: object) {
  await rec.commands[command](node);
  await waitFor(() => lastInit()?.key === node._specUrl);
  const init = lastInit();
  const tab = rec.panels.filter((p: any) => p.viewType === SETTINGS).at(-1);
  await tab.send({
    type: "saveAnyway",
    data: { name: init.name, url: init.url, auth: "none", token: "", username: "", password: "", ...fields },
  });
}

test("token saved in host A's settings is sent to A only; host B keeps its own Basic auth", async () => {
  register(A, B);
  const { context, secrets } = makeContext();
  secrets["swaggerViewer.basicAuth"] = JSON.stringify({
    [hostOf(B.origin)]: { username: "u", password: "p" },
  });
  ext.activate(context);
  const [nodeA] = await rec.treeProvider.getChildren();
  await saveSettings("swaggerViewer.apiSettings", nodeA, { auth: "bearer", token: "token-for-A" });
  await loadAllSpecs();
  assert.ok(authOf(A).length > 0);
  assert.ok(
    authOf(A).every((h) => h === "Bearer token-for-A"),
    `A got ${authOf(A)}`
  );
  const basic = "Basic " + Buffer.from("u:p").toString("base64");
  assert.ok(
    authOf(B).every((h) => h === basic),
    `B got ${authOf(B)}`
  );
  assert.equal(rec.prompts.length, 0, "no top input box / quick pick");
});

test("Set Auth Token / Set Username & Password open the settings tab on the auth section", async () => {
  register(A);
  const { context } = makeContext();
  ext.activate(context);
  const [nodeA] = await rec.treeProvider.getChildren();
  await rec.commands["swaggerViewer.setToken"](nodeA);
  await waitFor(() => lastInit());
  assert.deepEqual({ auth: lastInit().auth, focus: lastInit().focus }, { auth: "bearer", focus: "auth" });
  await saveSettings("swaggerViewer.setBasicAuth", nodeA, { auth: "basic", username: "u", password: "p" });
  await loadAllSpecs();
  const basic = "Basic " + Buffer.from("u:p").toString("base64");
  assert.ok(authOf(A).length > 0 && authOf(A).every((h) => h === basic), `A got ${authOf(A)}`);
});

test("choosing 'None' in settings removes the host's credentials", async () => {
  register(A);
  const { context } = makeContext();
  ext.activate(context);
  const [nodeA] = await rec.treeProvider.getChildren();
  await saveSettings("swaggerViewer.apiSettings", nodeA, { auth: "bearer", token: "t" });
  await saveSettings("swaggerViewer.apiSettings", (await rec.treeProvider.getChildren())[0], {
    auth: "none",
  });
  A.requests.length = 0;
  await loadAllSpecs();
  assert.ok(
    authOf(A).every((h) => h === undefined),
    `A got ${authOf(A)}`
  );
});

test("clearToken on host A's node removes only A's token, without asking", async () => {
  register(A, B);
  const { context } = makeContext();
  ext.activate(context);
  const [nodeA, nodeB] = await rec.treeProvider.getChildren();
  await saveSettings("swaggerViewer.apiSettings", nodeA, { auth: "bearer", token: "tA" });
  await saveSettings("swaggerViewer.apiSettings", nodeB, { auth: "bearer", token: "tB" });
  await rec.commands["swaggerViewer.clearToken"]((await rec.treeProvider.getChildren())[0]);
  A.requests.length = 0;
  B.requests.length = 0;
  await loadAllSpecs();
  assert.ok(
    authOf(A).every((h) => h === undefined),
    `A got ${authOf(A)}`
  );
  assert.ok(
    authOf(B).every((h) => h === "Bearer tB"),
    `B got ${authOf(B)}`
  );
});

test("legacy global token with one registered host migrates to that host", async () => {
  register(A);
  const { context, secrets } = makeContext();
  secrets[LEGACY_KEY] = "legacy";
  ext.activate(context);
  await waitFor(() => secrets[LEGACY_KEY] === undefined);
  await loadAllSpecs();
  assert.ok(authOf(A).length > 0 && authOf(A).every((h) => h === "Bearer legacy"), `A got ${authOf(A)}`);
});

test("legacy global token with several hosts is not sent anywhere until the user picks hosts", async () => {
  register(A, B);
  const { context, secrets } = makeContext();
  secrets[LEGACY_KEY] = "legacy";
  rec.answers.push(undefined); // dismiss the notification
  ext.activate(context);
  await waitFor(() => rec.msgs.length > 0);
  await loadAllSpecs();
  assert.ok(
    authOf(A).every((h) => h === undefined),
    `A got ${authOf(A)}`
  );
  assert.ok(
    authOf(B).every((h) => h === undefined),
    `B got ${authOf(B)}`
  );
  assert.equal(secrets[LEGACY_KEY], "legacy", "legacy value is kept until the user decides");
});

test("legacy global token: picking host A from the notification assigns it to A only", async () => {
  register(A, B);
  const { context, secrets } = makeContext();
  secrets[LEGACY_KEY] = "legacy";
  rec.answers.push("Choose hosts", [hostOf(A.origin)]);
  ext.activate(context);
  await waitFor(() => secrets[LEGACY_KEY] === undefined);
  await loadAllSpecs();
  assert.ok(authOf(A).length > 0 && authOf(A).every((h) => h === "Bearer legacy"), `A got ${authOf(A)}`);
  assert.ok(
    authOf(B).every((h) => h === undefined),
    `B got ${authOf(B)}`
  );
});
