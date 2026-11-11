// Real VS Code check of API management without the top input box: inline input above the tree,
// add by typing a URL + Enter, right-click → Rename reopens the inline input.
// Writes screenshots to ~/Library/Caches/oae-e2e/ui-*.png.
//
//   npm run build && node --import tsx test/e2e/vscode-ui.ts
import * as path from "node:path";
import type { Frame, Page } from "@playwright/test";
import { launchVSCode, E2E_ROOT, sleep } from "./vscode";
import { startSampleGateway } from "../fixtures/sample-gateway";

// The inline input lives in a webview iframe; find the frame that has our #value field.
async function inputFrame(win: Page, tries = 20): Promise<Frame | undefined> {
  for (let i = 0; i < tries; i++) {
    for (const f of win.frames()) {
      if (
        await f
          .locator("#value")
          .count()
          .catch(() => 0)
      )
        return f;
    }
    await sleep(300);
  }
  return undefined;
}

(async () => {
  const gw = await startSampleGateway();
  const s = await launchVSCode({});
  try {
    await s.showOpenApiView();
    // 1) Nothing registered → Explorer-like message + Add API button; no input until it is pressed.
    const welcome = s.win.locator(".welcome-view-content", { hasText: "Add API" }).first();
    console.log("welcome text:", JSON.stringify(await welcome.innerText().catch(() => "(none)")));
    console.log("input before button:", !!(await inputFrame(s.win, 3)));
    await s.win.screenshot({ path: path.join(E2E_ROOT, "ui-1-empty.png") });
    await welcome.getByRole("button", { name: "Add API" }).click();
    await sleep(1500);
    let f = await inputFrame(s.win);
    console.log(
      "input after button:",
      !!f,
      "quick input visible:",
      await s.win.locator(".quick-input-widget:visible").count()
    );
    await s.win.screenshot({ path: path.join(E2E_ROOT, "ui-1b-input.png") });

    // 2) Type a URL + Enter → added to the tree under the spec title.
    await f!.locator("#value").fill(`${gw.origin}/swagger-ui/index.html`);
    await f!.locator("#value").press("Enter");
    await sleep(3000);
    const labels = await s.win
      .locator(".monaco-list-row .label-name")
      .evaluateAll((els) => els.map((e) => e.textContent?.trim()));
    console.log("tree after add:", labels);
    await s.win.screenshot({ path: path.join(E2E_ROOT, "ui-2-added.png") });

    // 3) Right-click → Rename → inline input reopens with the current name.
    const first = labels[0] || "";
    await s.row(first).click({ button: "right" });
    await sleep(800);
    await s.win
      .locator(".monaco-menu .action-label", { hasText: /^Rename$/ })
      .first()
      .click();
    await sleep(1500);
    f = await inputFrame(s.win);
    console.log("rename value:", await f?.locator("#value").inputValue());
    await s.win.screenshot({ path: path.join(E2E_ROOT, "ui-3-rename.png") });
    await f!.locator("#value").fill("Renamed API");
    await f!.locator("#value").press("Enter");
    await sleep(1500);
    console.log(
      "tree after rename:",
      await s.win
        .locator(".monaco-list-row .label-name")
        .evaluateAll((els) => els.map((e) => e.textContent?.trim()))
    );
  } finally {
    await s.close();
    await gw.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
