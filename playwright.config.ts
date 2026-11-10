import { defineConfig } from "@playwright/test";

// Webview tests: the real Swagger UI HTML from src/swaggerUi.ts in Chromium.
// Run with NODE_PATH=test/fake-vscode (see `npm run test:webview`).
export default defineConfig({
  testDir: "test/webview",
  testMatch: "*.spec.ts",
  timeout: 30_000,
  reporter: process.env.CI ? "github" : "list",
  use: { browserName: "chromium" },
});
