// swagger-ui-dist 에셋을 media/swagger-ui/ 로 복사 (CDN 대신 번들 → 오프라인/방화벽 안전).
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
  console.log(`복사: media/swagger-ui/${a}`);
}
console.log("Swagger UI 에셋 번들 완료");
