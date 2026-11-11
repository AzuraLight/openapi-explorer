// The inline API input (src/apiInputView.ts) in Chromium: keyboard flow and inline errors/login.
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeVscode } from "../helpers/harness";
import { ApiInputView, INPUT_VIEW_ID } from "../../src/apiInputView";

async function load(page: Page) {
  fakeVscode.__reset();
  const rec = fakeVscode.__rec;
  const fromView: any[] = [];
  const view = new ApiInputView(async (m) => void fromView.push(m));
  (rec.viewProviders as any)[INPUT_VIEW_ID] = view;
  const resolved = await fakeVscode.__resolveView(INPUT_VIEW_ID);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oae-input-")), "index.html");
  fs.writeFileSync(file, resolved.webview.html);
  await page.exposeFunction("__toExtension", async (m: any) => {
    if (m.type === "ready") return; // handled below by open()
    fromView.push(m);
  });
  await page.addInitScript(() => {
    (window as any).acquireVsCodeApi = () => ({
      postMessage: (m: unknown) => (window as any).__toExtension(m),
    });
  });
  await page.goto("file://" + file);
  const toView = (m: object) => page.evaluate((msg) => window.postMessage(msg, "*"), m);
  // Deliver what the extension posts (open/busy/error/close) into the page.
  const flush = async () => {
    for (const m of rec.viewPosts.splice(0)) await toView(m);
  };
  return { view, fromView, toView, flush };
}

test("opens with the value selected; Enter submits; Escape cancels", async ({ page }) => {
  const { view, fromView, flush } = await load(page);
  await view.open({ mode: "add", value: "https://api.example.com/v3/api-docs" });
  await flush();
  const input = page.locator("#value");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("https://api.example.com/v3/api-docs");
  await expect(page.locator("#label")).toContainText("Add API");
  await page.keyboard.type("https://gw.example.com/api-docs"); // replaces the selected value
  await page.keyboard.press("Enter");
  await expect
    .poll(() => fromView.at(-1))
    .toEqual({ type: "submit", value: "https://gw.example.com/api-docs" });
  await page.keyboard.press("Escape");
  await expect.poll(() => fromView.at(-1)).toEqual({ type: "cancel" });
});

test("error with Save Anyway / Edit; Edit clears the error and refocuses the field", async ({ page }) => {
  const { view, fromView, toView, flush } = await load(page);
  await view.open({ mode: "add", value: "" });
  await flush();
  await toView({
    type: "error",
    text: "No OpenAPI spec found at x.",
    detail: "Tried: x → 404",
    actions: ["saveAnyway", "edit"],
  });
  await expect(page.locator("#status")).toHaveText("No OpenAPI spec found at x.");
  await expect(page.locator("#value")).toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Save Anyway" }).click();
  await expect.poll(() => fromView.at(-1)).toEqual({ type: "saveAnyway" });
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#status")).toHaveText("");
  await expect(page.locator("#value")).toBeFocused();
});

test("login required: username/password appear inline; Enter in the password field logs in", async ({
  page,
}) => {
  const { view, fromView, toView, flush } = await load(page);
  await view.open({ mode: "add", value: "" });
  await flush();
  await toView({ type: "error", text: "x requires a login.", actions: ["login", "edit"] });
  await expect(page.locator("#username")).toBeVisible();
  await expect(page.locator("#username")).toBeFocused();
  await page.keyboard.type("u");
  await page.locator("#password").fill("p");
  await page.locator("#password").press("Enter");
  await expect.poll(() => fromView.at(-1)).toEqual({ type: "login", username: "u", password: "p" });
});

test("busy disables the field and ignores Enter", async ({ page }) => {
  const { view, fromView, toView, flush } = await load(page);
  await view.open({ mode: "add", value: "https://a.example.com" });
  await flush();
  await toView({ type: "busy", text: "Looking…" });
  await expect(page.locator("#value")).toBeDisabled();
  await expect(page.locator("#status")).toHaveText("Looking…");
  const before = fromView.length;
  await page.locator("body").press("Enter");
  expect(fromView.length).toBe(before);
});
