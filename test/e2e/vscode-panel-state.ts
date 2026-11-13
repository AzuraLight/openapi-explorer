// Real VS Code probe: the Swagger UI panel starts collapsed, a tree click opens the operation, and after
// the panel is hidden (another tab in front) and shown again the same operation is open again
// (retainContextWhenHidden off; the page keeps its state with getState/setState).
//
//   npm run build && node --import tsx test/e2e/vscode-panel-state.ts
import type { Page } from "@playwright/test";
import { launchVSCode, sleep } from "./vscode";
import { startSampleGateway } from "../fixtures/sample-gateway";

// The Swagger UI page lives in a nested webview iframe.
async function swaggerState(win: Page) {
  for (const f of win.frames()) {
    const r = await f
      .evaluate(() =>
        document.getElementById("swagger-ui")
          ? {
              tags: document.querySelectorAll(".opblock-tag").length,
              open: [...document.querySelectorAll(".opblock.is-open .opblock-summary-path")].map(
                (e) => e.textContent
              ),
            }
          : null
      )
      .catch(() => null);
    if (r) return r;
  }
  return null;
}

(async () => {
  const gw = await startSampleGateway(0, "127.0.0.1", "en");
  const s = await launchVSCode({
    "swaggerViewer.specs": [{ name: "sample", url: `${gw.origin}/swagger-ui/index.html` }],
  });
  const { win, row } = s;
  try {
    await s.showOpenApiView();
    for (const label of (process.env.EXPAND || "sample|store|Products").split("|")) {
      if (await row(label).count()) {
        await row(label).click();
        await sleep(2000);
      }
    }
    console.log(
      "tree:",
      JSON.stringify(await win.locator(".part.sidebar .monaco-list-row .label-name").allInnerTexts())
    );
    const target = process.env.CLICK || "GET /api/v1/products/{id}";
    await row(target).click();
    await sleep(4000);
    console.log("after tree click:", JSON.stringify(await swaggerState(win)));

    // Hide the panel: a new untitled editor in the same (right) group comes to the front.
    await win.keyboard.press("Meta+N");
    await sleep(2000);
    console.log("while hidden:", JSON.stringify(await swaggerState(win)));

    // Show it again by its tab.
    await win.locator(".tabs-container .tab", { hasText: /API/ }).first().click();
    await sleep(5000);
    console.log("shown again:", JSON.stringify(await swaggerState(win)));
  } finally {
    await s.close();
    await gw.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
