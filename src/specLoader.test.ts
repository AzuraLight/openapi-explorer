import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateUrls, resolveSpec, clearCache } from "./specLoader";
import type { Fetcher, HttpResponse } from "./types";

test("candidateUrls includes NestJS -json and common spec paths", () => {
  const cands = candidateUrls("https://gw.example.com/api-docs");
  assert.ok(cands.includes("https://gw.example.com/api-docs-json"));
  assert.ok(cands.includes("https://gw.example.com/v3/api-docs"));
  assert.ok(cands.includes("https://gw.example.com/swagger.json"));
});

test("candidateUrls excludes petstore default", () => {
  const cands = candidateUrls("https://petstore.swagger.io/v2/swagger.json");
  assert.equal(cands.length, 0);
});

// UI(HTML) → 후보 경로(-json)에서 실제 스펙을 찾아내는지
test("resolveSpec auto-discovers spec from UI page", async () => {
  clearCache();
  const specJson = JSON.stringify({ openapi: "3.0.0", info: { title: "X" }, paths: {} });
  const fetcher: Fetcher = async (url): Promise<HttpResponse> => {
    if (url.endsWith("/api-docs")) {
      return { ok: true, status: 200, contentType: "text/html", body: "<html>swagger-ui</html>" };
    }
    if (url.endsWith("/api-docs-json")) {
      return { ok: true, status: 200, contentType: "application/json", body: specJson };
    }
    return { ok: false, status: 404, contentType: "application/json", body: "{}" };
  };
  const res = await resolveSpec("https://gw.example.com/api-docs", { fetcher });
  assert.equal(res.specUrl, "https://gw.example.com/api-docs-json");
  assert.equal(res.spec.info?.title, "X");
});

test("resolveSpec uses spec URL directly when JSON returned", async () => {
  clearCache();
  const specJson = JSON.stringify({ openapi: "3.0.0", paths: {} });
  const fetcher: Fetcher = async (): Promise<HttpResponse> => ({
    ok: true,
    status: 200,
    contentType: "application/json",
    body: specJson,
  });
  const res = await resolveSpec("https://gw.example.com/v3/api-docs", { fetcher });
  assert.equal(res.specUrl, "https://gw.example.com/v3/api-docs");
});
