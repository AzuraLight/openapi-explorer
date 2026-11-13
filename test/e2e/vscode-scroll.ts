// Real VS Code probe: click methods in the tree and read the Swagger UI webview's scroll position.
// Used to check the reported "jumps to the bottom" (not reproduced: every click landed at top 0).
//
//   npm run build && node --import tsx test/e2e/vscode-scroll.ts
//
// Env: EXPAND / CLICK — tree labels to expand / methods to click, "|"-separated.
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { launchVSCode, E2E_ROOT, sleep } from "./vscode";
import { startSampleGateway } from "../fixtures/sample-gateway";

async function webviewState(win: Page) {
  for (const f of win.frames()) {
    const r = await f
      .evaluate(() => {
        if (!document.getElementById("swagger-ui")) return null;
        const open = [...document.querySelectorAll(".opblock.is-open")].map((o) => ({
          id: o.id,
          top: Math.round(o.getBoundingClientRect().top),
        }));
        return {
          y: Math.round(scrollY),
          max: document.documentElement.scrollHeight - innerHeight,
          h: innerHeight,
          open,
        };
      })
      .catch(() => null);
    if (r) return r;
  }
  return null;
}

(async () => {
  const gw = await startSampleGateway(0, "127.0.0.1", "ko"); // Korean tags: names with spaces
  const s = await launchVSCode({
    "swaggerViewer.specs": [{ name: "sample", url: `${gw.origin}/swagger-ui/index.html` }],
  });
  try {
    await s.showOpenApiView();
    for (const label of (process.env.EXPAND || "sample|learning|학습자 관리|평가 관리").split("|")) {
      await s.row(label).click();
      await sleep(2500);
    }
    const clicks = (
      process.env.CLICK ||
      "GET /api/v1/learning/r0|GET /api/v1/learning/r4/{id}/items|DELETE /api/v1/learning/r4/{id}|POST /api/v1/learning/r0"
    ).split("|");
    for (const [i, label] of clicks.entries()) {
      await s.row(label).click();
      await sleep(3000);
      console.log(label, JSON.stringify(await webviewState(s.win)));
      await s.win.screenshot({ path: path.join(E2E_ROOT, `scroll-${i}.png`) });
    }
  } finally {
    await s.close();
    await gw.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
