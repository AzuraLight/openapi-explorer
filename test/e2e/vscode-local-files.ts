// Real VS Code probe for 1.3.0 local spec files: Explorer right-click → "Add to OpenAPI Explorer" on a
// JSON spec, open it in Swagger UI, then edit the file and check the open Swagger UI picks it up.
//
//   npm run build && node --import tsx test/e2e/vscode-local-files.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { launchVSCode, E2E_ROOT, sleep } from "./vscode";

const dir = path.join(E2E_ROOT, "ws", "api");
const specFile = path.join(dir, "openapi.json");
const spec = (field: string) =>
  JSON.stringify({
    openapi: "3.0.1",
    info: { title: "Local Pets", version: "1" },
    paths: { "/pets": { get: { tags: ["pets"], responses: { "200": { description: "ok" } } } } },
    components: { schemas: { Pet: { type: "object", properties: { [field]: { type: "string" } } } } },
  });

// The spec embedded in the Swagger UI page script (model fields stay collapsed in the rendered UI).
async function embeddedSpec(win: Page): Promise<string> {
  for (const f of win.frames()) {
    const t = await f
      .evaluate(() =>
        document.getElementById("swagger-ui")
          ? [...document.scripts].map((s) => s.textContent || "").join("\n")
          : null
      )
      .catch(() => null);
    if (t) return t;
  }
  return "";
}

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(specFile, spec("petName"));
  const s = await launchVSCode({ "swaggerViewer.specs": [] });
  const { win, row } = s;
  try {
    await win.keyboard.press("Meta+Shift+E");
    await sleep(1500);
    if ((await row("api").getAttribute("aria-expanded")) !== "true") await row("api").click();
    await sleep(800);
    await row("openapi.json").click({ button: "right" });
    await sleep(1000);
    const menu = await win.locator(".context-view .action-label").allInnerTexts();
    console.log("menu has Add to OpenAPI Explorer:", menu.includes("Add to OpenAPI Explorer"));
    await win.locator(".context-view .action-label", { hasText: "Add to OpenAPI Explorer" }).first().click();
    await sleep(2500);

    await s.showOpenApiView();
    console.log("tree shows 'Local Pets':", (await row("Local Pets").count()) > 0);
    await row("Local Pets").hover();
    await win
      .locator('.monaco-list-row:has-text("Local Pets") .action-label[aria-label*="Swagger UI"]')
      .first()
      .click();
    await sleep(5000);
    console.log("Swagger UI has petName:", /petName/.test(await embeddedSpec(win)));

    fs.writeFileSync(specFile, spec("nickname"));
    await sleep(4000);
    const after = await embeddedSpec(win);
    console.log("after edit has nickname:", /nickname/.test(after), "petName gone:", !/petName/.test(after));
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
