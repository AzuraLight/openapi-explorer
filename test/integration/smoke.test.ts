// Smoke test of the harness itself: activate the real extension against a local server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeVscode, makeContext, startServer, specJson } from "../helpers/harness";
import * as ext from "../../src/extension";

test("activate → tree lists spec → tags load → Swagger UI renders the spec", async () => {
  const srv = await startServer({
    "/v3/api-docs": () => ({
      body: specJson("Smoke API", { "/ping": { get: { tags: ["health"], responses: {} } } }),
    }),
  });
  after(() => srv.close());
  fakeVscode.__reset();
  const rec = fakeVscode.__rec;
  rec.config["swaggerViewer.specs"] = [{ name: "smoke", url: `${srv.origin}/v3/api-docs` }];
  const { context } = makeContext();
  ext.activate(context);

  const roots = await rec.treeProvider.getChildren();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].label, "smoke");
  const tags = await rec.treeProvider.getChildren(roots[0]);
  assert.deepEqual(
    tags.map((t: any) => t.label),
    ["health"]
  );

  await rec.commands["swaggerViewer.openSwaggerUI"](roots[0]);
  assert.equal(rec.htmlSets.length, 1);
  assert.match(rec.htmlSets[0], /"title":"Smoke API"/);
});
