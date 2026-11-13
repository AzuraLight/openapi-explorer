import { test, expect } from "@playwright/test";
import { startServer, type TestServer } from "../helpers/harness";
import { renderWebview, openInPage } from "./render";

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer({ "/ping": () => ({ body: '{"pong":true}' }) });
});
test.afterAll(() => srv.close());

test("webview renders operations and Try it out goes through the extension proxy", async ({ page }) => {
  const spec = {
    openapi: "3.0.0",
    info: { title: "Smoke", version: "1" },
    paths: {
      "/ping": {
        get: { operationId: "ping", tags: ["health"], responses: { "200": { description: "ok" } } },
      },
    },
  };
  const r = renderWebview(spec, `${srv.origin}/v3/api-docs`);
  await openInPage(page, r);
  await page.locator("#operations-tag-health").click(); // tags start collapsed
  const op = page.locator("#operations-health-ping");
  await op.locator(".opblock-summary-control").click();
  await op.locator("button.try-out__btn").click();
  await op.locator("button.execute").click();
  await expect(op.locator(".live-responses-table tbody .response-col_status").first()).toContainText("200");
  expect(r.sent.some((m) => m.type === "swaggerFetch" && m.url.endsWith("/ping"))).toBe(true);
  expect(srv.requests.some((q) => q.url === "/ping")).toBe(true);
});
