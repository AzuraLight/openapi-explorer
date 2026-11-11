// Real VS Code check of API management like Explorer folders: empty view with Add API, a "New API"
// node + settings tab in the editor area, save, then right-click → API Settings… to add a token.
// Writes screenshots to ~/Library/Caches/oae-e2e/ui-*.png.
//
//   npm run build && node --import tsx test/e2e/vscode-ui.ts
import * as path from "node:path";
import type { Frame, Page } from "@playwright/test";
import { launchVSCode, E2E_ROOT, sleep } from "./vscode";
import { startSampleGateway } from "../fixtures/sample-gateway";

// The settings tab is a webview iframe; find the frame that has its #url field.
async function settingsFrame(win: Page, tries = 30): Promise<Frame | undefined> {
  for (let i = 0; i < tries; i++) {
    for (const f of win.frames())
      if (
        await f
          .locator("#url")
          .count()
          .catch(() => 0)
      )
        return f;
    await sleep(300);
  }
  return undefined;
}
const treeLabels = (win: Page) =>
  win.locator(".monaco-list-row .label-name").evaluateAll((els) => els.map((e) => e.textContent?.trim()));

(async () => {
  const gw = await startSampleGateway();
  const s = await launchVSCode({});
  try {
    await s.showOpenApiView();
    // 1) Nothing registered → message + Add API button.
    const welcome = s.win.locator(".welcome-view-content", { hasText: "Add API" }).first();
    console.log("welcome:", JSON.stringify(await welcome.innerText().catch(() => "(none)")));
    await s.win.screenshot({ path: path.join(E2E_ROOT, "ui-1-empty.png") });

    // 2) Add API → "New API" node + settings tab in the editor area. No top input box.
    await welcome.getByRole("button", { name: "Add API" }).click();
    let f = await settingsFrame(s.win);
    console.log("tree:", await treeLabels(s.win), "| settings tab:", !!f);
    console.log("quick input visible:", await s.win.locator(".quick-input-widget:visible").count());
    await f!.locator("#url").fill(`${gw.origin}/swagger-ui/index.html`);
    await s.win.screenshot({ path: path.join(E2E_ROOT, "ui-2-new-api.png") });

    // 3) Save → tab closes, the API replaces "New API".
    await f!.locator("#save").click();
    await sleep(3000);
    console.log("tree after save:", await treeLabels(s.win));

    // 4) Right-click → API Settings… → Bearer token → Save.
    const first = (await treeLabels(s.win))[0] || "";
    await s.row(first).click({ button: "right" });
    await sleep(800);
    await s.win
      .locator(".monaco-menu .action-label", { hasText: /^API Settings/ })
      .first()
      .click();
    f = await settingsFrame(s.win);
    console.log("prefilled url:", await f?.locator("#url").inputValue());
    await f!.getByLabel("Bearer token").check();
    await f!.locator("#token").fill("secret-token");
    await s.win.screenshot({ path: path.join(E2E_ROOT, "ui-3-settings.png") });
    await f!.locator("#save").click();
    await sleep(3000);
    console.log(
      "root description:",
      await s.win.locator(".monaco-list-row").first().locator(".label-description").textContent()
    );

    // 5) Reopen: saved token row (no value), eye toggle, ● in the tab title while editing.
    await s.row((await treeLabels(s.win))[0] || "").click({ button: "right" });
    await sleep(800);
    await s.win
      .locator(".monaco-menu .action-label", { hasText: /^API Settings/ })
      .first()
      .click();
    f = await settingsFrame(s.win);
    console.log(
      "saved row:",
      await f!.locator("#savedToken").innerText(),
      "| token value:",
      await f!.locator("#token").inputValue()
    );
    await f!.locator("#token").fill("new-token");
    await f!.getByRole("button", { name: "Show token" }).click();
    await f!.locator("#name").fill("Edited name");
    await sleep(600);
    console.log("tab title:", await s.win.locator(".tab.active .label-name").first().textContent());
    await s.win.screenshot({ path: path.join(E2E_ROOT, "ui-4-polish.png") });
  } finally {
    await s.close();
    await gw.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
