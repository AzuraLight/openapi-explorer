// Launch the installed VS Code with an isolated profile and this extension, and attach Playwright
// over the Chromium debugging port. Not part of CI (needs a local VS Code).
//
// The profile lives in ~/Library/Caches/oae-e2e: VS Code's IPC socket path must stay under
// 103 characters, which rules out long temp directories.
import { chromium, type Browser, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const REPO = path.resolve(__dirname, "..", "..");
export const E2E_ROOT = path.join(os.homedir(), "Library", "Caches", "oae-e2e");
const BIN = process.env.VSCODE_BIN || "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const PORT = 9339;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface VSCodeSession {
  win: Page;
  close(): Promise<void>;
  // Tree row by its visible label.
  row(label: string): ReturnType<Page["locator"]>;
  // Make sure the OpenAPI view is visible (clicking an open container collapses it).
  showOpenApiView(): Promise<void>;
}

export async function launchVSCode(workspaceSettings: Record<string, unknown>): Promise<VSCodeSession> {
  const ws = path.join(E2E_ROOT, "ws");
  fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".vscode", "settings.json"), JSON.stringify(workspaceSettings));
  // Custom (in-DOM) menus so context menus can be read and screenshotted; macOS uses native ones by default.
  const userDir = path.join(E2E_ROOT, "ud", "User");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ "window.menuStyle": "custom" }));
  // Launched from inside VS Code, ELECTRON_RUN_AS_NODE would make Code start as plain Node.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE" && !k.startsWith("VSCODE_"))
  );
  const proc = spawn(
    BIN,
    [
      ws,
      `--extensionDevelopmentPath=${REPO}`,
      `--user-data-dir=${path.join(E2E_ROOT, "ud")}`,
      `--extensions-dir=${path.join(E2E_ROOT, "ext")}`,
      `--remote-debugging-port=${PORT}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
    ],
    { stdio: "ignore", env }
  );
  let browser: Browser | undefined;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  if (!browser) {
    proc.kill();
    throw new Error("VS Code did not open a debugging port");
  }
  let win: Page | undefined;
  for (let i = 0; i < 60 && !win; i++) {
    win = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => /workbench\.html/.test(p.url()));
    if (!win) await sleep(500);
  }
  if (!win) {
    await browser.close();
    proc.kill();
    throw new Error("workbench window not found");
  }
  await sleep(4000);
  const w = win;
  const row = (label: string) =>
    w
      .locator(".monaco-list-row")
      .filter({ has: w.locator(".label-name", { hasText: label }) })
      .first();
  return {
    win: w,
    row,
    async showOpenApiView() {
      const icon = w.locator('.activitybar [aria-label^="OpenAPI"]').first();
      await icon.click();
      await sleep(1200);
      if (
        !(await w
          .locator(".pane-header", { hasText: /API/ })
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        await icon.click();
        await sleep(1200);
      }
    },
    async close() {
      await browser!.close().catch(() => {});
      proc.kill();
      await sleep(1000);
    },
  };
}
