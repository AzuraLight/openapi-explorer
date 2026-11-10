// R6: selecting an endpoint/model in the tree scrolls to it and expands it in Swagger UI.
import { test, expect } from "@playwright/test";
import { renderWebview, openInPage } from "./render";

const spec = {
  openapi: "3.0.0",
  info: { title: "Focus", version: "1" },
  paths: {
    "/users/{id}": {
      get: {
        operationId: "get user.by id",
        tags: ["User Management"],
        responses: { "200": { description: "ok" } },
      },
    },
    "/health": { get: { tags: ["ops"], responses: { "200": { description: "ok" } } } },
  },
  components: { schemas: { UserDto: { type: "object", properties: { id: { type: "integer" } } } } },
};

async function focus(page: import("@playwright/test").Page, f: unknown) {
  await page.evaluate((m) => window.postMessage({ type: "focus", focus: m }, "*"), f);
}

test("operation whose tag contains a space and whose operationId has special characters expands", async ({
  page,
}) => {
  await openInPage(page, renderWebview(spec, "http://127.0.0.1:1/v3/api-docs"));
  await focus(page, {
    kind: "operation",
    tag: "User Management",
    operationId: "get user.by id",
    method: "GET",
    path: "/users/{id}",
  });
  await expect(page.locator(".opblock.is-open")).toHaveCount(1);
  await expect(page.locator(".opblock.is-open .opblock-summary-path")).toContainText("/users/{id}");
});

test("operation without operationId expands", async ({ page }) => {
  await openInPage(page, renderWebview(spec, "http://127.0.0.1:1/v3/api-docs"));
  await focus(page, { kind: "operation", tag: "ops", method: "GET", path: "/health" });
  await expect(page.locator(".opblock.is-open .opblock-summary-path")).toContainText("/health");
});

test("initial focus passed when the panel is created also expands the operation", async ({ page }) => {
  const r = renderWebview(
    spec,
    "http://127.0.0.1:1/v3/api-docs",
    {},
    {
      kind: "operation",
      tag: "ops",
      method: "GET",
      path: "/health",
    }
  );
  await openInPage(page, r);
  await expect(page.locator(".opblock.is-open .opblock-summary-path")).toContainText("/health");
});

test("model focus scrolls the model into view", async ({ page }) => {
  await openInPage(page, renderWebview(spec, "http://127.0.0.1:1/v3/api-docs"));
  await focus(page, { kind: "model", name: "UserDto" });
  await expect(page.locator("#model-UserDto")).toBeInViewport();
});
