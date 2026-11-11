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

export interface LaunchOptions {
  userSettings?: Record<string, unknown>; // merged over the defaults below
  windowSize?: [number, number]; // CSS pixels; screenshots are at the display's scale (2x on Retina)
}

export async function launchVSCode(
  workspaceSettings: Record<string, unknown>,
  options: LaunchOptions = {}
): Promise<VSCodeSession> {
  const ws = path.join(E2E_ROOT, "ws");
  fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".vscode", "settings.json"), JSON.stringify(workspaceSettings));
  // Custom (in-DOM) menus so context menus can be read and screenshotted; macOS uses native ones by default.
  const userDir = path.join(E2E_ROOT, "ud", "User");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, "settings.json"),
    JSON.stringify({ "window.menuStyle": "custom", ...options.userSettings })
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
  if (options.windowSize) {
    // Electron's debugging port has no window-bounds commands; emulate the viewport instead
    // (the workbench lays itself out to it, and screenshots are taken at that size).
    const [width, height] = options.windowSize;
    const cdp = await win.context().newCDPSession(win);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await win.evaluate(() => window.dispatchEvent(new Event("resize")));
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
      // The side bar shows our container when its title is "OpenAPI…"; clicking the activity icon of
      // the container already shown would collapse the side bar, so only click when needed.
      const shown = () =>
        w
          .locator(".part.sidebar .composite.title", { hasText: /OpenAPI/ })
          .first()
          .isVisible()
          .catch(() => false);
      for (let i = 0; i < 3 && !(await shown()); i++) {
        await w.locator('.activitybar [aria-label^="OpenAPI"]').first().click();
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
