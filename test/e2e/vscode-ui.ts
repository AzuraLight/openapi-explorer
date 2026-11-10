// Real VS Code check of the "manage APIs like Explorer folders" UI: empty view, view-title ＋,
// right-click menu on an API node. Writes screenshots to ~/Library/Caches/oae-e2e/ui-*.png.
//
//   npm run build && node --import tsx test/e2e/vscode-ui.ts
import * as path from "node:path";
import { launchVSCode, E2E_ROOT, sleep } from "./vscode";
import { startSampleGateway } from "../fixtures/sample-gateway";

(async () => {
  // 1) Nothing registered → welcome view with "Add API".
  let s = await launchVSCode({});
  try {
    await s.showOpenApiView();
    const welcome = await s.win
      .locator(".welcome-view-content")
      .first()
      .innerText()
      .catch(() => "(none)");
    console.log("welcome:", JSON.stringify(welcome));
    await s.win.screenshot({ path: path.join(E2E_ROOT, "ui-1-empty.png") });
  } finally {
    await s.close();
  }

  // 2) Legacy url + one spec → both listed; title actions; right-click menu on an API node.
  const gw = await startSampleGateway();
  s = await launchVSCode({
    "swaggerViewer.url": `${gw.origin}/v3/api-docs`,
    "swaggerViewer.specs": [{ name: "sample", url: `${gw.origin}/swagger-ui/index.html` }],
  });
  try {
    await s.showOpenApiView();
    const labels = await s.win
      .locator(".monaco-list-row .label-name")
      .evaluateAll((els) => els.map((e) => e.textContent?.trim()));
    console.log("tree:", labels);
    const titleActions = await s.win
      .locator(".pane-header .actions .action-label")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    console.log("view title actions:", titleActions);
    await s.row("sample").click({ button: "right" });
    await sleep(800);
    const menu = await s.win
      .locator(".context-view .action-label, .monaco-menu .action-label")
      .evaluateAll((els) => els.map((e) => e.textContent?.trim()).filter(Boolean));
    console.log("context menu:", menu);
    await s.win.screenshot({ path: path.join(E2E_ROOT, "ui-2-context-menu.png") });
  } finally {
    await s.close();
    await gw.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
