# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-11-11

### Added

- **Manage APIs like folders in the Explorer.** With nothing registered the view shows a short message and an
  **Add API** button, like the Explorer with no folder open. ＋ in the view title, or right-click an API →
  **Add API…**, **Rename** (`F2`), **Edit URL…**, **Copy URL**, **Remove API** (`Delete` / `⌘⌫`). Adding,
  renaming and editing happen in a small inline input above the tree instead of the top input box: Enter checks
  the URL right away, errors and the username/password for login-protected specs appear inline, and the new API
  is named from the spec's title. Edits are written back to the settings scope (workspace or user) that holds
  the entry.

- **YAML specs.** Specs are parsed as JSON or YAML regardless of the content type. Discovery also
  tries the YAML paths of springdoc (`/v3/api-docs.yaml`) and NestJS (`/{path}-yaml`). YAML alias
  expansion is capped (`maxAliasCount: 100`), so alias bombs are rejected.
- **springdoc groups.** When a Swagger UI page is backed by `/v3/api-docs/swagger-config` with
  `urls`, each group is shown as its own node under the gateway, and search covers every group.

### Changed

- **Set URL** and **Add Spec** are replaced by **Add API**. An existing `swaggerViewer.url` keeps working and is
  now listed next to `swaggerViewer.specs` (it used to be hidden as soon as `specs` had an entry); it is
  never rewritten automatically — renaming or editing it moves it into `specs`.

### Fixed

- A spec URL that answers `401`/`403` now reports "Login required" instead of silently falling back to
  another spec on the same host.
- Path-level `parameters` now apply to every operation under the path; an operation parameter with
  the same name and location overrides it.
- Swagger 2.0: `in: body` and `in: formData` parameters become the request body (content type from
  `consumes`), and `responses.*.schema` is used for the response type. Previously the body was
  missing and the response type was `void`.
- Base URLs: relative `servers` URLs are resolved against the spec URL, and server variables use
  their defaults in generated code. Previously a server path such as `/api/v1` was dropped. Swagger UI
  receives absolute server URLs and keeps `{variables}` so you can still pick their values.
- `summary`/`description` next to a `$ref` override the referenced ones (OpenAPI 3.1).

## [1.1.1] - 2026-11-10

### Security

- **Bearer tokens are now stored per host.** Previously a single token was sent to every registered
  gateway, and it also hid any per-host Basic credentials. Set or clear a token from a gateway node's
  right-click menu, or from the palette with a host picker. A token saved by 1.1.0 is moved to the
  registered host if there is exactly one; with several hosts you are asked which host(s) it belongs
  to, and it is not sent until you choose.

### Fixed

- Opening a different spec on the same origin (e.g. two services behind one gateway) now re-renders
  Swagger UI. Previously the tab title changed but the old spec stayed on screen.
- Try it out: multipart/form-data uploads are sent as real multipart bodies (they were sent as the text
  `[object FormData]`), and binary responses such as images or files are no longer corrupted.
- Clicking an endpoint in the tree now expands it in Swagger UI, including tags with spaces and
  operationIds with special characters.
- Specs served with a UTF-8 BOM are now parsed.

## [1.1.0] - 2026-07-03

### Added

- **HTTP Basic auth** — for specs whose URL itself requires a login (returns `401`). New commands **OpenAPI: Set Username & Password** / **Clear Username & Password** store credentials in SecretStorage and send them as `Authorization: Basic …` when fetching the spec and for Try-it-out. Credential precedence: custom `Authorization` header > Bearer token > Basic.
- **Per-host credentials, managed from the tree** — Basic credentials are keyed by host, so multiple registered gateways can each have their own login. Right-click a gateway node to **Set/Clear Username & Password** for that host directly, and the node shows a 🔑 marker with the saved username. The palette command still lets you apply one pair to multiple hosts at once (multi-select) for gateways that share a login.
- Clearer error when a spec URL returns `401`/`403`: the tree now hints to set a username & password instead of a generic "spec not found".

## [1.0.0] - 2026-06-26

First public release.

### Added

- **Sidebar tree** — browse tags → endpoints with method-colored icons, plus a `Models` node for DTOs.
- **Embedded Swagger UI** — served from bundled `swagger-ui-dist` assets, so it works offline / behind a firewall. Clicking an endpoint or model opens the UI _beside_ the editor and deep-links to it without stealing focus.
- **Try it out (via the extension)** — requests are sent from the extension host (Node), so they work without CORS and still apply the configured token, proxy, and private CA.
- **Endpoint search palette** — fuzzy search by method / path / summary (`Ctrl+Alt+/`, macOS `Cmd+Alt+/`), across all registered specs.
- **Code generation** — right-click a tree item to copy a TypeScript response type (with dependent models, JSDoc, and envelope unwrapping), a `fetch` / `axios` client function, or a cURL command.
- **Multiple gateways** — register several specs in `swaggerViewer.specs` and switch per service.
- **UI URL auto-discovery** — paste a `.../api-docs` page URL and the real spec (`/api-docs-json`, `/v3/api-docs`, …) is discovered automatically.
- **Corporate networks** — proxy, private CA certificate, `strictSSL` toggle, auth token in SecretStorage, and custom headers.
- **Localization** — English (default) and Korean, following the editor display language.
- **Identity** — a Swagger-style API mark (ring + node) on Swagger green (`#49cc90`) for the marketplace icon, and a matching monochrome activity-bar icon.

### Security

- Credentials (`Authorization` / `Cookie` / `Proxy-Authorization`) are dropped on cross-origin redirects, matching standard browser `fetch` behavior.
- Try-it-out only sends the token/cookies to the spec's own origin, so a malicious `servers` entry cannot exfiltrate a token.
- Response bodies are capped (25 MB) to prevent memory pressure from huge responses.
- Webview CSP narrowed (`img-src` no longer allows arbitrary `https:`).

[1.2.0]: https://github.com/AzuraLight/openapi-explorer/releases/tag/v1.2.0
[1.1.1]: https://github.com/AzuraLight/openapi-explorer/releases/tag/v1.1.1
[1.0.0]: https://github.com/AzuraLight/openapi-explorer/releases/tag/v1.0.0
