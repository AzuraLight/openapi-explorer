// Base URL for API calls (code generation, Swagger UI "servers").
//  - OpenAPI 3: servers[0].url, variables replaced by their defaults, relative URLs resolved
//    against the spec URL — https://spec.openapis.org/oas/v3.1.0.html#relative-references-in-urls
//    and #server-variable-object
//  - Swagger 2: schemes[0]://host + basePath, host defaulting to the host serving the spec —
//    https://swagger.io/specification/v2/ (#swaggerHost, #swaggerBasePath, #swaggerSchemes)
//  - Neither: the spec URL's origin.
import type { OpenApiSpec } from "./types";

interface ServerObject {
  url?: string;
  variables?: Record<string, { default?: string }>;
}

function originOf(specUrl: string): string | null {
  try {
    return new URL(specUrl).origin;
  } catch {
    return null;
  }
}

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, "");

// servers[] entry → absolute URL (or null if it cannot be resolved).
export function absoluteServerUrl(server: ServerObject, specUrl: string): string | null {
  if (!server || typeof server.url !== "string") return null;
  const url = server.url.replace(/\{([^}]+)\}/g, (m, name) => {
    const d = server.variables?.[name]?.default;
    return typeof d === "string" ? d : m;
  });
  try {
    return stripTrailingSlash(new URL(url, specUrl).href);
  } catch {
    return null;
  }
}

export function resolveBaseUrl(spec: OpenApiSpec, specUrl: string): string {
  const fallback = originOf(specUrl) ?? specUrl;
  if (spec.swagger) {
    const s2 = spec as OpenApiSpec & { host?: string; schemes?: string[] };
    let u: URL | null = null;
    try {
      u = new URL(specUrl);
    } catch {
      /* keep null */
    }
    const scheme = (s2.schemes?.[0] || u?.protocol.replace(":", "") || "https").toLowerCase();
    const host = s2.host || u?.host;
    if (!host) return fallback;
    return stripTrailingSlash(`${scheme}://${host}${spec.basePath || ""}`);
  }
  const servers = (spec as { servers?: ServerObject[] }).servers;
  if (Array.isArray(servers) && servers.length) {
    return absoluteServerUrl(servers[0], specUrl) ?? fallback;
  }
  return fallback;
}

// For Swagger UI: make a relative server URL absolute but keep `{variables}` so Swagger UI can
// still offer them. (Swagger UI receives the spec inline, so it has no document URL of its own.)
export function absoluteServerTemplate(url: string, specUrl: string): string | null {
  if (typeof url !== "string") return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url; // already absolute (may contain variables)
  const origin = originOf(specUrl);
  if (!origin) return null;
  if (url.startsWith("/")) return stripTrailingSlash(origin + url) || origin;
  if (/[{}]/.test(url)) return null; // path-relative template: cannot be resolved without mangling braces
  try {
    return stripTrailingSlash(new URL(url, specUrl).href);
  } catch {
    return null;
  }
}
