// Real VS Code end-to-end probe: launches the installed VS Code with an isolated profile and this
// extension (--extensionDevelopmentPath), clicks methods in the tree, and reads the Swagger UI
// webview's scroll position. Not part of CI (needs a local VS Code).
//
//   npm run build && node --import tsx test/e2e/vscode-scroll.ts
//
// Env:
//   VSCODE_BIN  VS Code executable (default: macOS /Applications path)
//   EXPAND      tree labels to expand in order, "|"-separated (default: sample gateway path)
//   CLICK       method labels to click in order, "|"-separated
// The profile lives in ~/Library/Caches/oae-e2e: VS Code's IPC socket path must stay under
// 103 characters, which rules out long temp directories.
import { chromium, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startSampleGateway } from "../fixtures/sample-gateway";

const REPO = path.resolve(__dirname, "..", "..");
const BIN = process.env.VSCODE_BIN || "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const ROOT = path.join(os.homedir(), "Library", "Caches", "oae-e2e");
const PORT = 9339;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const gw = await startSampleGateway();
  const ws = path.join(ROOT, "ws");
  fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".vscode", "settings.json"),
    JSON.stringify({ "swaggerViewer.specs": [{ name: "sample", url: `${gw.origin}/swagger-ui/index.html` }] })
  );
  // Launched from inside VS Code, ELECTRON_RUN_AS_NODE would make Code start as plain Node.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE" && !k.startsWith("VSCODE_"))
  );
  const proc = spawn(
    BIN,
    [
      ws,
      `--extensionDevelopmentPath=${REPO}`,
      `--user-data-dir=${path.join(ROOT, "ud")}`,
      `--extensions-dir=${path.join(ROOT, "ext")}`,
      `--remote-debugging-port=${PORT}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
    ],
    { stdio: "ignore", env }
  );
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw new Error("VS Code did not open a debugging port");
  let win: Page | undefined;
  for (let i = 0; i < 60 && !win; i++) {
    win = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => /workbench\.html/.test(p.url()));
    if (!win) await sleep(500);
  }
  if (!win) throw new Error("workbench window not found");
  try {
    await sleep(4000);
    const rows = () => win!.locator(".monaco-list-row");
    const row = (label: string) =>
      rows()
        .filter({ has: win!.locator(".label-name", { hasText: label }) })
        .first();
    // Open the OpenAPI view (clicking an already-open container collapses it, so check).
    const icon = win.locator('.activitybar [aria-label^="OpenAPI"]').first();
    await icon.click();
    await sleep(1200);
    if (!(await row("sample").count())) {
      await icon.click();
      await sleep(1200);
    }
    const expand = (process.env.EXPAND || "sample|learning|학습자 관리|평가 관리").split("|");
    for (const label of expand) {
      await row(label).click();
      await sleep(2500);
    }
    const labels = await win
      .locator(".monaco-list-row .label-name")
      .evaluateAll((els) => els.map((e) => e.textContent?.trim()));
    console.log("tree:", labels.join(" / "));
    const clicks = (
      process.env.CLICK ||
      "GET /api/v1/learning/r0|GET /api/v1/learning/r4/{id}/items|DELETE /api/v1/learning/r4/{id}|POST /api/v1/learning/r0"
    ).split("|");
    for (const [i, label] of clicks.entries()) {
      await row(label).click();
      for (const t of [700, 3000]) {
        await sleep(t === 700 ? 700 : 2300);
        console.log(`${label} +${t}ms`, JSON.stringify(await webviewState(win)));
      }
      await win.screenshot({ path: path.join(ROOT, `shot-${i}.png`) });
    }
  } finally {
    await browser.close().catch(() => {});
    proc.kill();
    await gw.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
