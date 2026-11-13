// Swagger/OpenAPI spec loader
// Even given a UI page (HTML) URL, it auto-discovers the actual spec (JSON or YAML),
// including springdoc's grouped specs (swagger-config `urls`).
// Takes an injected fetcher to decouple from vscode/network → unit testable.
import { parse as parseYaml } from "yaml";
import type { Fetcher, OpenApiSpec, Schema } from "./types";

export interface SpecGroup {
  name: string;
  url: string; // absolute
}

const SPEC_CACHE = new Map<string, { spec: OpenApiSpec; fetchedAt: number }>();
const URL_RESOLVE_CACHE = new Map<string, { specUrl: string; groups?: SpecGroup[] }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// yaml's own default; stated explicitly because it is our guard against alias-expansion
// ("billion laughs") attacks — https://eemeli.org/yaml/#parse-options
const YAML_MAX_ALIAS_COUNT = 100;

const isPetstore = (u: string): boolean => /petstore\.swagger\.io/.test(u);
const looksLikeSpec = (obj: any): boolean =>
  !!obj && typeof obj === "object" && !Array.isArray(obj) && !!(obj.openapi || obj.swagger || obj.paths);

// JSON first; otherwise YAML (any content type — servers often send YAML as text/plain).
// HTML is never parsed as YAML. A YAML alias-limit violation is rethrown, not treated as "not a spec".
export function tryParse(body: string): OpenApiSpec | null {
  // trimStart also drops a UTF-8 BOM (U+FEFF), which JSON.parse would otherwise reject.
  const trimmed = body.trimStart();
  if (!trimmed || trimmed.startsWith("<")) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const obj = JSON.parse(trimmed);
      return looksLikeSpec(obj) ? (obj as OpenApiSpec) : null;
    } catch {
      /* not JSON — may still be YAML flow style */
    }
  }
  try {
    const obj = parseYaml(trimmed, { maxAliasCount: YAML_MAX_ALIAS_COUNT });
    return looksLikeSpec(obj) ? (obj as OpenApiSpec) : null;
  } catch (e: any) {
    if (/alias/i.test(e?.message ?? "")) throw new Error(`Spec rejected: ${e.message}`);
    return null;
  }
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
    // NestJS serves /{path}-json and /{path}-yaml — https://docs.nestjs.com/openapi/introduction
    cands.push(
      `${origin}${path}-json`,
      `${origin}${path}.json`,
      `${origin}${path}/swagger.json`,
      `${origin}${path}-yaml`,
      `${origin}${path}.yaml`
    );
  }
  cands.push(
    `${origin}/v3/api-docs`,
    `${origin}/v2/api-docs`,
    `${origin}/swagger.json`,
    `${origin}/openapi.json`,
    `${origin}/api-docs-json`,
    // springdoc also serves YAML at /v3/api-docs.yaml — https://springdoc.org/
    `${origin}/v3/api-docs.yaml`,
    `${origin}/openapi.yaml`,
    `${origin}/swagger.yaml`
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
  // springdoc groups (swagger-config `urls`); `spec` is the primary group's spec.
  groups?: SpecGroup[];
}

export interface ResolveOptions {
  force?: boolean;
  fetcher: Fetcher;
}

// springdoc's Swagger UI reads its groups from springdoc.swagger-ui.configUrl,
// default /v3/api-docs/swagger-config — https://springdoc.org/properties.html
function swaggerConfigUrl(inputUrl: string): string | null {
  try {
    return `${new URL(inputUrl).origin}/v3/api-docs/swagger-config`;
  } catch {
    return null;
  }
}

interface SwaggerConfig {
  groups?: SpecGroup[];
  primary?: string; // absolute URL of the spec to load first
}

// `urls` (groups) wins over `url` (springdoc: "url ... will be ignored if urls is used").
function readSwaggerConfig(body: string, configUrl: string): SwaggerConfig | null {
  let cfg: any;
  try {
    cfg = JSON.parse(body.trimStart());
  } catch {
    return null;
  }
  if (!cfg || typeof cfg !== "object") return null;
  const abs = (u: unknown) => {
    try {
      return typeof u === "string" && u ? new URL(u, configUrl).href : null;
    } catch {
      return null;
    }
  };
  if (Array.isArray(cfg.urls)) {
    const groups = cfg.urls
      .map((g: any) => ({ name: String(g?.name ?? g?.url ?? ""), url: abs(g?.url) }))
      .filter((g: { url: string | null }) => g.url) as SpecGroup[];
    if (groups.length) {
      const primary = groups.find((g) => g.name === cfg.urlsPrimaryName) ?? groups[0];
      return { groups, primary: primary.url };
    }
  }
  const single = abs(cfg.url);
  return single ? { primary: single } : null;
}

export async function resolveSpec(inputUrl: string, opts: ResolveOptions): Promise<ResolveResult> {
  if (!inputUrl) throw new Error("Swagger URL is empty.");
  const { fetcher, force = false } = opts;

  const resolved = URL_RESOLVE_CACHE.get(inputUrl);
  if (resolved && !force) {
    const c = SPEC_CACHE.get(resolved.specUrl);
    if (c && Date.now() - c.fetchedAt < CACHE_TTL_MS) {
      return { specUrl: resolved.specUrl, spec: c.spec, cached: true, groups: resolved.groups };
    }
  }

  const tried: string[] = [];
  let authStatus = 0; // detect 401/403 → signals login required
  const noteAuth = (s: number) => {
    if ((s === 401 || s === 403) && !authStatus) authStatus = s;
  };

  // 1) The URL itself is a spec → use it as is (no group discovery).
  const first = await fetcher(inputUrl);
  tried.push(`${inputUrl} → ${first.status}`);
  noteAuth(first.status);
  // The URL itself needs a login: say so rather than falling back to some other spec on the host.
  if (first.status === 401 || first.status === 403) {
    throw new Error(
      `Login required (HTTP ${first.status}). Add a Bearer token or username & password in the API's settings (right-click the API → API Settings).\nTried: ${tried.join(", ")}`
    );
  }
  if (first.ok) {
    const parsed = tryParse(first.body);
    if (parsed) return cacheAndReturn(inputUrl, inputUrl, parsed, tried);
    // 2) A Swagger UI page that names its spec URL inline.
    if (/text\/html/.test(first.contentType) || first.body.includes("swagger-ui")) {
      for (const su of extractSpecUrlFromHtml(first.body, inputUrl)) {
        const r = await fetcher(su);
        tried.push(`${su} → ${r.status}`);
        const p = r.ok ? tryParse(r.body) : null;
        if (p) return cacheAndReturn(inputUrl, su, p, tried);
      }
    }
  }

  // 3) springdoc swagger-config — checked before the plain candidates so groups are found
  //    even when a default /v3/api-docs also exists.
  const cfgUrl = swaggerConfigUrl(inputUrl);
  if (cfgUrl && cfgUrl !== inputUrl) {
    const r = await fetcher(cfgUrl);
    tried.push(`${cfgUrl} → ${r.status}`);
    noteAuth(r.status);
    const cfg = r.ok ? readSwaggerConfig(r.body, cfgUrl) : null;
    if (cfg?.primary) {
      const s = await fetcher(cfg.primary);
      tried.push(`${cfg.primary} → ${s.status}`);
      noteAuth(s.status);
      const p = s.ok ? tryParse(s.body) : null;
      if (p) return cacheAndReturn(inputUrl, cfg.primary, p, tried, cfg.groups);
    }
  }

  // 4) Well-known spec paths.
  for (const cand of candidateUrls(inputUrl)) {
    if (cand === inputUrl) continue;
    const r = await fetcher(cand);
    tried.push(`${cand} → ${r.status}`);
    noteAuth(r.status);
    const p = r.ok ? tryParse(r.body) : null;
    if (p) return cacheAndReturn(inputUrl, cand, p, tried);
  }
  if (authStatus) {
    throw new Error(
      `Login required (HTTP ${authStatus}). Add a Bearer token or username & password in the API's settings (right-click the API → API Settings).\nTried: ${tried.join(", ")}`
    );
  }
  throw new Error(`OpenAPI spec not found.\nTried: ${tried.join(", ")}`);
}

function cacheAndReturn(
  inputUrl: string,
  specUrl: string,
  spec: OpenApiSpec,
  tried: string[],
  groups?: SpecGroup[]
): ResolveResult {
  SPEC_CACHE.set(specUrl, { spec, fetchedAt: Date.now() });
  URL_RESOLVE_CACHE.set(inputUrl, { specUrl, groups });
  return { specUrl, spec, cached: false, tried, groups };
}

// Without a URL: everything. With one: that input URL and the spec it resolved to.
export function clearCache(url?: string): void {
  if (url === undefined) {
    SPEC_CACHE.clear();
    URL_RESOLVE_CACHE.clear();
    return;
  }
  const r = URL_RESOLVE_CACHE.get(url);
  URL_RESOLVE_CACHE.delete(url);
  SPEC_CACHE.delete(url);
  if (r) SPEC_CACHE.delete(r.specUrl);
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
