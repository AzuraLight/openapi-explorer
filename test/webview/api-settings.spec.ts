// The API settings tab (src/apiSettingsPanel.ts) in Chromium: fields per auth method, keyboard, inline status.
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeVscode } from "../helpers/harness";
import { ApiSettingsPanels, type SettingsInit } from "../../src/apiSettingsPanel";

const base: SettingsInit = {
  key: "new:1",
  isNew: true,
  name: "",
  url: "https://api.example.com/v3/api-docs",
  auth: "none",
  username: "",
  hasToken: false,
  hasPassword: false,
};

async function load(page: Page, init: SettingsInit = base) {
  fakeVscode.__reset();
  const rec = fakeVscode.__rec;
  const fromTab: any[] = [];
  const panels = new ApiSettingsPanels({
    save: async (_i, d, anyway) => {
      fromTab.push({ type: anyway ? "saveAnyway" : "save", data: d });
      return false;
    },
    test: async (_i, d) => void fromTab.push({ type: "test", data: d }),
    closed: () => {},
  });
  panels.show(init);
  const panel = rec.panels.at(-1);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oae-settings-")), "index.html");
  fs.writeFileSync(file, panel.webview.html);
  await page.exposeFunction("__toExtension", async (m: any) => {
    if (m.type === "cancel") fromTab.push(m);
    else if (m.type !== "ready") await panel.send(m);
  });
  await page.addInitScript(() => {
    (window as any).acquireVsCodeApi = () => ({
      postMessage: (m: unknown) => (window as any).__toExtension(m),
    });
  });
  await page.goto("file://" + file);
  const toTab = (m: object) => page.evaluate((msg) => window.postMessage(msg, "*"), m);
  for (const m of rec.posts.splice(0)) await toTab(m);
  return { fromTab, toTab };
}

test("new API: URL focused; auth fields follow the chosen method; Enter saves everything", async ({
  page,
}) => {
  const { fromTab } = await load(page);
  await expect(page.locator("#url")).toBeFocused();
  await expect(page.locator("#bearerFields")).toBeHidden();
  await page.getByLabel("Bearer token").check();
  await expect(page.locator("#token")).toBeVisible();
  await page.getByLabel("Username & password").check();
  await expect(page.locator("#bearerFields")).toBeHidden();
  await page.locator("#username").fill("u");
  await page.locator("#password").fill("p");
  await page.locator("#name").fill("Gateway");
  await page.locator("#name").press("Enter");
  await expect
    .poll(() => fromTab.at(-1))
    .toEqual({
      type: "save",
      data: {
        name: "Gateway",
        url: "https://api.example.com/v3/api-docs",
        auth: "basic",
        token: "",
        username: "u",
        password: "p",
      },
    });
});

test("saved secrets show a 'keep' placeholder, never a value", async ({ page }) => {
  await load(page, { ...base, isNew: false, key: base.url, name: "G", auth: "bearer", hasToken: true });
  await expect(page.locator("#token")).toHaveValue("");
  await expect(page.locator("#token")).toHaveAttribute("placeholder", /leave empty to keep/);
});

test("error status shows Save Anyway; Escape cancels", async ({ page }) => {
  const { fromTab, toTab } = await load(page);
  await toTab({
    type: "status",
    kind: "error",
    text: "No OpenAPI spec found at x.",
    detail: "Tried: x",
    actions: ["saveAnyway"],
  });
  await expect(page.locator("#status")).toHaveText("No OpenAPI spec found at x.");
  await page.getByRole("button", { name: "Save Anyway" }).click();
  await expect.poll(() => fromTab.at(-1)?.type).toBe("saveAnyway");
  await page.keyboard.press("Escape");
  await expect.poll(() => fromTab.at(-1)?.type).toBe("cancel");
});
