// file:// URLs for the spec loader (local spec files). Same shape as an HTTP response, so the loader
// does not care where a document came from.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Fetcher, HttpResponse } from "./types";

export const isFileUrl = (u: string): boolean => /^file:/i.test(u.trim());

export async function readFileUrl(url: string): Promise<HttpResponse> {
  try {
    const body = await readFile(fileURLToPath(url), "utf8");
    return { ok: true, status: 200, contentType: "", body };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code || "";
    const status = code === "ENOENT" ? 404 : code === "EACCES" || code === "EPERM" ? 403 : 500;
    return { ok: false, status, contentType: "", body: code || String(e) };
  }
}

// file:// goes to disk only when the API is itself a local file (`allowFiles`). For a remote API, a
// file:// URL from a docs page or swagger-config is refused, so a server cannot make the extension
// read local files. Everything else goes to `http`.
export function withFiles(http: Fetcher, allowFiles: boolean): Fetcher {
  return (url) => {
    if (!isFileUrl(url)) return http(url);
    // Status 0 (not 401/403): a refusal is not a login problem.
    if (!allowFiles)
      return Promise.resolve({ ok: false, status: 0, contentType: "", body: "local file refused" });
    return readFileUrl(url);
  };
}
