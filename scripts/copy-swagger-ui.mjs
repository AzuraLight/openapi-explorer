// Copy swagger-ui-dist assets to media/swagger-ui/ (bundle instead of CDN → offline/firewall safe).
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "swagger-ui-dist");
const dest = join(root, "media", "swagger-ui");
mkdirSync(dest, { recursive: true });

const assets = ["swagger-ui.css", "swagger-ui-bundle.js", "swagger-ui-standalone-preset.js"];
for (const a of assets) {
  copyFileSync(join(src, a), join(dest, a));
  console.log(`Copied: media/swagger-ui/${a}`);
}
console.log("Swagger UI assets bundled");
