// R1: same-origin, different spec must re-render. R3: binary responses survive the Try-it proxy.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeVscode, makeContext, startServer, specJson, waitFor } from "../helpers/harness";
import * as ext from "../../src/extension";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);

test("R1: opening another spec on the same origin re-renders the panel with that spec", async () => {
  const srv = await startServer({
    "/svc-a/v3/api-docs": () => ({ body: specJson("Service A") }),
    "/svc-b/v3/api-docs": () => ({ body: specJson("Service B") }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  const rec = fakeVscode.__rec;
  rec.config["swaggerViewer.specs"] = [
    { name: "a", url: `${srv.origin}/svc-a/v3/api-docs` },
    { name: "b", url: `${srv.origin}/svc-b/v3/api-docs` },
  ];
  ext.activate(makeContext().context);
  const [a, b] = await rec.treeProvider.getChildren();
  await rec.commands["swaggerViewer.openSwaggerUI"](a);
  await rec.commands["swaggerViewer.openSwaggerUI"](b);
  const last = rec.htmlSets[rec.htmlSets.length - 1];
  assert.match(last, /"title":"Service B"/);
  assert.equal(rec.panels[0].title, "Service B");
});

test("R3: binary response bytes reach the webview unchanged", async () => {
  const srv = await startServer({
    "/v3/api-docs": () => ({ body: specJson("Bin") }),
    "/img": () => ({ type: "image/png", body: PNG }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  const rec = fakeVscode.__rec;
  rec.config["swaggerViewer.specs"] = [{ name: "bin", url: `${srv.origin}/v3/api-docs` }];
  ext.activate(makeContext().context);
  const [root] = await rec.treeProvider.getChildren();
  await rec.commands["swaggerViewer.openSwaggerUI"](root);
  rec.panels[0].send({ type: "swaggerFetch", id: 7, url: `${srv.origin}/img`, method: "GET", headers: {} });
  await waitFor(() => rec.posts.some((m: any) => m.id === 7));
  const reply = rec.posts.find((m: any) => m.id === 7);
  assert.equal(reply.status, 200);
  assert.ok(typeof reply.bodyBase64 === "string", "reply carries bodyBase64");
  assert.ok(Buffer.from(reply.bodyBase64, "base64").equals(PNG));
});

test("R2 (extension side): a base64 request body is sent as raw bytes", async () => {
  const srv = await startServer({
    "/v3/api-docs": () => ({ body: specJson("Up") }),
    "/upload": () => ({ body: "{}" }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  const rec = fakeVscode.__rec;
  rec.config["swaggerViewer.specs"] = [{ name: "up", url: `${srv.origin}/v3/api-docs` }];
  ext.activate(makeContext().context);
  const [root] = await rec.treeProvider.getChildren();
  await rec.commands["swaggerViewer.openSwaggerUI"](root);
  rec.panels[0].send({
    type: "swaggerFetch",
    id: 8,
    url: `${srv.origin}/upload`,
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    bodyBase64: PNG.toString("base64"),
  });
  await waitFor(() => rec.posts.some((m: any) => m.id === 8));
  const got = srv.requests.find((r) => r.url === "/upload")!;
  assert.ok(got.body.equals(PNG), `server got ${got.body.toString("hex")}`);
});
