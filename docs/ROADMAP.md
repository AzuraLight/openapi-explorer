<!-- Language: **English** · [한국어](ROADMAP.ko.md) -->

# OpenAPI Explorer Roadmap

As of: 2026-11-10 · Baseline: 1.1.0 (`2bed03b`)

## Principles

1. Fix existing features that behave incorrectly first, security issues above all. New features come after.
2. Among new features, start with spec reading, since every other feature depends on it.
3. For each release, commit a reproduction test first, confirm it fails, then fix.
4. Base behavior on the specifications and established tools, and cite the source.

## Scope: what we do and don't do

- What sets us apart: browsing remote URLs as a tree, and auto-discovering the spec from a UI page URL.
- Out of scope: spec linting and editing. 42Crunch and Redocly already do this well.
  - https://marketplace.visualstudio.com/items?itemName=42Crunch.vscode-openapi
  - https://marketplace.visualstudio.com/items?itemName=Redocly.openapi-vs-code

## Confirmed defects (1.1.0)

How they were reproduced: the real `src/*.ts` was run against a fake `vscode` module and local HTTP servers, and the webview HTML was loaded in Chromium. None of this was checked in a real VS Code instance.

| #       | Defect                                                                                       | Location                                  | Observed                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| R1      | Opening another spec on the same origin does not re-render the view                          | `src/swaggerUi.ts` `base !== currentBase` | Tab title shows B, content still shows A                                                                       |
| R2      | Multipart upload body is turned into a string                                                | `src/swaggerUi.ts` `String(init.body)`    | Server receives `[object FormData]` with no Content-Type                                                       |
| R3      | Binary responses are corrupted                                                               | `src/http.ts` utf8 decoding               | PNG byte `89` becomes `efbfbd`                                                                                 |
| R4      | The Bearer token is global: it is sent to every host and hides per-host Basic auth           | `src/extension.ts` `buildHeaders`         | Host A's token is sent to host B (security)                                                                    |
| R5      | Webview background is hard-coded to `#fff`, so dark themes are not supported                 | `src/swaggerUi.ts`                        | Confirmed in code                                                                                              |
| R6      | Selecting an operation in the tree does not expand it                                        | `src/swaggerUi.ts` `doFocus`              | Spaces in DOM ids become `_`, so the lookup fails. Swagger UI 5.32.6 only opens via `.opblock-summary-control` |
| E1      | YAML specs are not supported                                                                 | `src/specLoader.ts` `tryParse`            | spec not found                                                                                                 |
| E2      | JSON with a BOM fails to parse                                                               | `src/specLoader.ts` `tryParse`            | spec not found                                                                                                 |
| E3      | springdoc groups (`urls` in `swagger-config`) are not discovered                             | `src/specLoader.ts`                       | spec not found                                                                                                 |
| E4      | Path-level `parameters` are ignored                                                          | `src/model.ts` `endpointDetail`           | 0 parameters                                                                                                   |
| E5      | `{user-id}` is not substituted, function named `123GetUser`, relative `servers` path dropped | `src/model.ts`                            | Generated code does not compile                                                                                |
| E6      | Non-identifier keys, 3.1 type arrays, `nullable`, `additionalProperties`, external `$ref`    | `src/model.ts` `tsType`                   | `display-name?:`, `any`                                                                                        |
| E7·E8   | Top-level enum and allOf models become empty interfaces                                      | `src/model.ts` `genTsForModel`            | `interface Status {}`                                                                                          |
| E9      | Header parameters missing; optional query params sent as the string `"undefined"`            | `src/model.ts` `clientParts`              |                                                                                                                |
| E12–E14 | Swagger 2 `in: body` and `responses.schema` are not recognized                               | `src/model.ts`                            | No body, response type `void`                                                                                  |

## Plan by release

### 1.1.1 — Bug fixes

**Status:** released 2026-11-10 — GitHub release `v1.1.1`, Open VSX.

- R4: limit tokens to their host. The approach is set by the industry research under "Decision log" below.
- R1: re-render the panel when the spec URL changes, not only when the origin changes.
- R2 and R3: pass FormData request bodies and binary responses between the webview and the extension as base64.
- R6: match Swagger UI's id rule and click its open button.
- E2: strip the BOM.

Done when: all of the reproduction tests above pass.

### 1.2.0 — Spec reading

**Status:** released 2026-11-11 — GitHub release `v1.2.0`, Open VSX. Also in 1.2.0: APIs managed like Explorer folders with an API settings tab in the editor, and the edge-case / independent-review fixes.

API management as shipped: ＋ / right-click **Add API…** adds a New API node and opens its settings tab (URL, name, Bearer token or username & password, Test Connection, Save); right-click **API Settings…** (`F2`), **Copy URL**, **Remove API** (`Delete`/`⌘⌫`). Checked in a real VS Code (`test/e2e/vscode-ui.ts`).

- E1: YAML parsing, including springdoc `/v3/api-docs.yaml` and NestJS `-yaml` paths.
- E4: merge path-level parameters. When name and `in` match, the operation's definition wins (Swagger 2.0 `#pathItemParameters`).
- E12–E14: Swagger 2 body, formData, `responses.schema`, consumes, produces.
- Relative `servers` URLs and server variables (OAS 3.1 `#relative-references-in-urls`, `#server-variable-object`).
- E3: springdoc `configUrl` (default `/v3/api-docs/swagger-config`) `urls[]` groups, shown as one node per group.
- Accept 3.1 documents with no `paths` and with webhooks; apply `summary`/`description` overrides on `$ref`.

Done when: E1–E4 and E12–E14 tests pass.

### 1.3.0 — Local spec files and external `$ref`

- Read `file://` specs (JSON / YAML) and reload when the file changes.
- Explorer right-click on a spec file → **Add to OpenAPI Explorer** (`explorer/context`, filtered with `resourceFilename =~ /(openapi|swagger|api-docs)/` — https://code.visualstudio.com/api/references/when-clause-contexts).
- External `$ref` (specs split across files or URLs), for local and remote specs. The approach (own bundler vs a library) is decided from research before work starts.

Done when: a split multi-file spec opens from the Explorer and from a URL, and edits to any of its files show up.

### 1.4.0 — Code generation

The reference is the actual output of openapi-typescript 7.13.0.

- Quote non-identifier keys (`"display-name"?:`).
- 3.0 `nullable` and 3.1 type arrays become `| null`.
- `unknown` instead of `any`; `additionalProperties` becomes `Record<string, T>`.
- Top-level enum, allOf, and array models become `type` aliases.
- Substitute path variables, generate valid identifier names, add header arguments, skip `undefined` optional query values.

Done when: E5–E11 tests pass and the generated code passes `tsc --noEmit`.

### 1.5.0 — UX

- R5: dark theme for Swagger UI, based on the `vscode-dark` body class (https://code.visualstudio.com/api/extension-guides/webview).
- Loading indicator via `withProgress({ viewId })`.
- Retry action on nodes that failed to load.

### Any time — Release automation

- Tag push → build, test, GitHub release and Open VSX publish (as Gitline does).
- Update `actions/setup-node` (Node 20 deprecation warning on the runners).
- Check whether a newer Playwright removes the need for the `ubuntu-24.04` runner pin.
- README images are recorded against an English sample gateway.

### On hold

apiKey / OAuth2 / mutualTLS auth UI; springdoc custom `configUrl` (set in `swagger-initializer.js`); VS Code Marketplace publishing.

## Testing

- Unit tests: `node --test`, as before.
- Integration tests: run `extension.ts` against a fake `vscode` module and local HTTP servers.
- Webview tests: check the rendered webview HTML in Playwright Chromium.
- All of these live in the repository and run in GitHub Actions (`.github/workflows/ci.yml`).

## Decision log

| Date       | Decision                                                                                                                                                      | Rationale                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-10 | Use openapi-typescript as the reference for TS generation                                                                                                     | Its actual output. Docs: https://openapi-ts.dev/advanced                                                                                                                                                                                                                                               |
| 2026-11-10 | Commit the test harness to the repository and run it in CI                                                                                                    | Maintainer decision                                                                                                                                                                                                                                                                                    |
| 2026-11-10 | Split the roadmap into English `ROADMAP.md` and Korean `ROADMAP.ko.md`                                                                                        | Maintainer decision; same convention as the README                                                                                                                                                                                                                                                     |
| 2026-11-10 | Store R4 tokens per host. Migrate an existing global token to the single registered host; with two or more hosts, stop sending it and let the user pick hosts | npm, git, gh, and curl all scope credentials per host (https://docs.npmjs.com/cli/v10/configuring-npm/npmrc, https://git-scm.com/docs/gitcredentials)                                                                                                                                                  |
| 2026-11-10 | Add the `yaml` 2.9.1 parser (1.2.0)                                                                                                                           | Reproduced defect E1; springdoc and NestJS serve YAML; no dependencies, ISC license                                                                                                                                                                                                                    |
| 2026-11-10 | Pin the CI runner to `ubuntu-24.04`                                                                                                                           | `ubuntu-latest` moved to 26.04, where Playwright 1.60 cannot install Chromium (v1.1.1 CI failure)                                                                                                                                                                                                      |
| 2026-11-10 | Publish to Open VSX from GitHub Actions (`publish-ovsx.yml`), uploading the VSIX attached to the GitHub release                                               | The token lives in the `OVSX_PAT` Actions secret; Open VSX gets the same file as the release                                                                                                                                                                                                           |
| 2026-11-10 | springdoc groups become tree nodes; swagger-config is checked before the plain candidate paths                                                                | Groups would be missed when a default `/v3/api-docs` also exists (https://springdoc.org/properties.html)                                                                                                                                                                                               |
| 2026-11-11 | Manage APIs like Explorer root folders: view-title ＋, node right-click Add/Rename/Edit URL/Copy URL/Remove, F2/Delete                                        | Explorer adds and removes workspace folders from the root folder's context menu (https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces). Extensions cannot add a menu to a tree's empty area: only `view/title` and `view/item/context` exist (VS Code `menusExtensionPoint.ts`) |
| 2026-11-11 | Keep `swaggerViewer.url` as is (listed next to `specs`) instead of migrating it                                                                               | Migrating would rewrite each project's `.vscode/settings.json`, which may be shared with a team                                                                                                                                                                                                        |
| 2026-11-11 | "Opening a method jumps to the bottom" closed as not reproducible                                                                                             | Not reproduced with Petstore 3 or the sample gateway in a real VS Code (`test/e2e/vscode-scroll.ts`); maintainer confirmed it looks fine                                                                                                                                                               |
| 2026-11-13 | Order after 1.2.0: local files + external `$ref` (1.3.0) → code generation (1.4.0) → UX (1.5.0)                                                               | Maintainer decision                                                                                                                                                                                                                                                                                    |
| 2026-11-13 | External `$ref` is in scope for 1.3.0                                                                                                                         | Maintainer decision; split specs are common once local files are supported                                                                                                                                                                                                                             |
| 2026-11-13 | VS Code Marketplace publishing later; Open VSX only for now                                                                                                   | Maintainer decision                                                                                                                                                                                                                                                                                    |
| 2026-11-13 | README images recorded against an English sample gateway                                                                                                      | Maintainer decision; the README is read in English first                                                                                                                                                                                                                                               |

## Sources

- Swagger 2.0: https://swagger.io/specification/v2/
- OAS 3.1.0: https://spec.openapis.org/oas/v3.1.0.html
- Migrating 3.0 → 3.1: https://www.openapis.org/blog/2021/02/16/migrating-from-openapi-3-0-to-3-1-0
- springdoc: https://springdoc.org/properties.html, https://springdoc.org/
- NestJS: https://docs.nestjs.com/openapi/introduction
- FastAPI: https://fastapi.tiangolo.com/tutorial/metadata/
- openapi-typescript: https://openapi-ts.dev/advanced
