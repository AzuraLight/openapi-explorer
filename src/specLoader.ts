// Swagger/OpenAPI 스펙 로더
// UI 페이지(HTML) URL을 받아도 실제 스펙(JSON)을 자동 탐색한다.
// fetcher를 주입받아 vscode/네트워크와 분리 → 단위 테스트 가능.
import type { Fetcher, OpenApiSpec, Schema } from "./types";

const SPEC_CACHE = new Map<string, { spec: OpenApiSpec; fetchedAt: number }>();
const URL_RESOLVE_CACHE = new Map<string, string>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const isPetstore = (u: string): boolean => /petstore\.swagger\.io/.test(u);

function tryParse(body: string): OpenApiSpec | null {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const obj = JSON.parse(body);
      if (obj && (obj.openapi || obj.swagger || obj.paths)) return obj as OpenApiSpec;
    } catch {
      /* not json */
    }
  }
  return null;
}

export function candidateUrls(inputUrl: string): string[] {
  const cands = [inputUrl];
  let u: URL;
  try {
    u = new URL(inputUrl);
  } catch {
    return cands;
  }
  const path = u.pathname.replace(/\/$/, "");
  const origin = u.origin;
  if (path) {
    cands.push(`${origin}${path}-json`, `${origin}${path}.json`, `${origin}${path}/swagger.json`);
  }
  cands.push(
    `${origin}/v3/api-docs`,
    `${origin}/v2/api-docs`,
    `${origin}/swagger.json`,
    `${origin}/openapi.json`,
    `${origin}/api-docs-json`
  );
  return [...new Set(cands)].filter((c) => !isPetstore(c));
}

function extractSpecUrlFromHtml(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const re = /url\s*:\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!isPetstore(m[1])) urls.push(m[1]);
  }
  return urls
    .map((x) => {
      try {
        return new URL(x, baseUrl).href;
      } catch {
        return null;
      }
    })
    .filter((x): x is string => x !== null);
}

export interface ResolveResult {
  specUrl: string;
  spec: OpenApiSpec;
  cached: boolean;
  tried?: string[];
}

export interface ResolveOptions {
  force?: boolean;
  fetcher: Fetcher;
}

export async function resolveSpec(inputUrl: string, opts: ResolveOptions): Promise<ResolveResult> {
  if (!inputUrl) throw new Error("Swagger URL이 비어 있습니다.");
  const { fetcher, force = false } = opts;

  const resolved = URL_RESOLVE_CACHE.get(inputUrl);
  if (resolved && !force) {
    const c = SPEC_CACHE.get(resolved);
    if (c && Date.now() - c.fetchedAt < CACHE_TTL_MS) {
      return { specUrl: resolved, spec: c.spec, cached: true };
    }
  }

  const tried: string[] = [];
  const first = await fetcher(inputUrl);
  tried.push(`${inputUrl} → ${first.status}`);
  if (first.ok) {
    const parsed = tryParse(first.body);
    if (parsed) return cacheAndReturn(inputUrl, inputUrl, parsed, tried);
    if (/text\/html/.test(first.contentType) || first.body.includes("swagger-ui")) {
      for (const su of extractSpecUrlFromHtml(first.body, inputUrl)) {
        const r = await fetcher(su);
        tried.push(`${su} → ${r.status}`);
        const p = r.ok ? tryParse(r.body) : null;
        if (p) return cacheAndReturn(inputUrl, su, p, tried);
      }
    }
  }
  for (const cand of candidateUrls(inputUrl)) {
    if (cand === inputUrl) continue;
    const r = await fetcher(cand);
    tried.push(`${cand} → ${r.status}`);
    const p = r.ok ? tryParse(r.body) : null;
    if (p) return cacheAndReturn(inputUrl, cand, p, tried);
  }
  throw new Error(`OpenAPI 스펙을 찾지 못했습니다.\n시도: ${tried.join(", ")}`);
}

function cacheAndReturn(
  inputUrl: string,
  specUrl: string,
  spec: OpenApiSpec,
  tried: string[]
): ResolveResult {
  SPEC_CACHE.set(specUrl, { spec, fetchedAt: Date.now() });
  URL_RESOLVE_CACHE.set(inputUrl, specUrl);
  return { specUrl, spec, cached: false, tried };
}

export function clearCache(): void {
  SPEC_CACHE.clear();
  URL_RESOLVE_CACHE.clear();
}

export function resolveRef(spec: OpenApiSpec, ref: string): unknown {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let cur: any = spec;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur ?? null;
}

export function getSchemas(spec: OpenApiSpec): Record<string, Schema> {
  return spec.components?.schemas || spec.definitions || {};
}
