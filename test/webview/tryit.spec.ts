// R2: multipart upload from Try it out. R3: binary response decoded in the webview.
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer, type TestServer } from "../helpers/harness";
import { renderWebview, openInPage } from "./render";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);
let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer({
    "/upload": () => ({ body: "{}" }),
    "/img": () => ({ type: "image/png", body: PNG }),
  });
});
test.afterAll(() => srv.close());

const spec = {
  openapi: "3.0.0",
  info: { title: "TryIt", version: "1" },
  paths: {
    "/upload": {
      post: {
        operationId: "upload",
        tags: ["files"],
        requestBody: {
          content: {
            "multipart/form-data": {
              schema: { type: "object", properties: { file: { type: "string", format: "binary" } } },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

test("R2: multipart upload reaches the server as multipart/form-data with the file content", async ({
  page,
}) => {
  const r = renderWebview(spec, `${srv.origin}/v3/api-docs`);
  await openInPage(page, r);
  await page.locator("#operations-tag-files").click(); // tags start collapsed
  const op = page.locator("#operations-files-upload");
  await op.locator(".opblock-summary-control").click();
  await op.locator("button.try-out__btn").click();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oae-up-")), "hello.txt");
  fs.writeFileSync(file, "hello-file-content");
  await op.locator('input[type="file"]').setInputFiles(file);
  await op.locator("button.execute").click();
  await expect(op.locator(".live-responses-table tbody .response-col_status").first()).toContainText("200");
  const got = srv.requests.find((q) => q.url === "/upload")!;
  expect(got.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  expect(got.body.toString("utf8")).toContain("hello-file-content");
});

test("R3: binary response arrives in the webview byte-for-byte", async ({ page }) => {
  const r = renderWebview(spec, `${srv.origin}/v3/api-docs`);
  await openInPage(page, r);
  // window.fetch is the extension-proxied fetch installed by the webview.
  const hex = await page.evaluate(async (url) => {
    const res = await fetch(url);
    const buf = new Uint8Array(await res.arrayBuffer());
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }, `${srv.origin}/img`);
  expect(hex).toBe(PNG.toString("hex"));
});

// VS Code injects `@layer vscode-default { code { color: var(--vscode-textPreformat-foreground) } }` into
// every webview (src/vs/workbench/contrib/webview/browser/pre/index.html). In Light Modern that is #3b3b3b,
// which made Swagger UI's response JSON (light text on its dark <pre>) unreadable.
test("response JSON stays readable under VS Code's light default webview styles", async ({ page }) => {
  await page.addInitScript(() => {
    const style = () => {
      const s = document.createElement("style");
      s.textContent =
        "@layer vscode-default { code { color: var(--vscode-textPreformat-foreground); } pre code { background-color: transparent; } }";
      document.head.prepend(s);
      document.documentElement.style.setProperty("--vscode-textPreformat-foreground", "#3b3b3b");
    };
    if (document.head) style();
    else document.addEventListener("DOMContentLoaded", style);
  });
  const json = await startServer({ "/data": () => ({ body: '{"success":true,"name":"x"}' }) });
  try {
    const getSpec = {
      openapi: "3.0.0",
      info: { title: "Readable", version: "1" },
      paths: {
        "/data": { get: { operationId: "json", tags: ["t"], responses: { "200": { description: "ok" } } } },
      },
    };
    const r = renderWebview(getSpec, `${json.origin}/v3/api-docs`);
    await openInPage(page, r);
    await page.locator("#operations-tag-t").click(); // tags start collapsed
    const op = page.locator("#operations-t-json");
    await op.locator(".opblock-summary-control").click();
    await op.locator("button.try-out__btn").click();
    await op.locator("button.execute").click();
    const pre = op.locator(".live-responses-table pre.microlight").first();
    await expect(pre).toBeVisible();
    const { preColor, codeColor } = await pre.evaluate((el) => ({
      preColor: getComputedStyle(el).color,
      codeColor: getComputedStyle(el.querySelector("code")!).color,
    }));
    expect(codeColor).toBe(preColor);
  } finally {
    await json.close();
  }
});
