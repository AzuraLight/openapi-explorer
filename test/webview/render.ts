// Render the real Swagger UI webview HTML (src/swaggerUi.ts) to a temp file and bridge its
// vscode.postMessage to the extension's real message handler.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { fakeVscode, makeContext } from "../helpers/harness";
import { openSwaggerUi, type FocusTarget } from "../../src/swaggerUi";
import type { OpenApiSpec } from "../../src/types";

export interface Rendered {
  file: string;
  panel: any;
  sent: any[]; // messages the webview posted to the extension
}

export function renderWebview(
  spec: OpenApiSpec,
  specUrl: string,
  headers: Record<string, string> = {},
  focus?: FocusTarget
): Rendered {
  fakeVscode.__reset();
  const { context } = makeContext();
  openSwaggerUi(context, spec, spec.info?.title || "t", specUrl, { headers }, focus);
  const rec = fakeVscode.__rec;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oae-webview-")), "index.html");
  fs.writeFileSync(file, rec.htmlSets[rec.htmlSets.length - 1]);
  return { file, panel: rec.panels[0], sent: [] };
}

// acquireVsCodeApi() → page binding → real handleMessage → reply posted back into the page.
export async function openInPage(page: Page, r: Rendered): Promise<void> {
  const rec = fakeVscode.__rec;
  await page.exposeFunction("__toExtension", async (msg: any) => {
    r.sent.push(msg);
    const before = rec.posts.length;
    r.panel.send(msg);
    for (let i = 0; i < 100 && rec.posts.length === before; i++) await new Promise((z) => setTimeout(z, 20));
    return rec.posts[rec.posts.length - 1];
  });
  await page.addInitScript(() => {
    (window as any).acquireVsCodeApi = () => ({
      postMessage: (m: unknown) =>
        (window as any).__toExtension(m).then((reply: unknown) => reply && window.postMessage(reply, "*")),
    });
  });
  await page.goto("file://" + r.file);
  await page.waitForSelector(".opblock", { timeout: 15_000 });
}
