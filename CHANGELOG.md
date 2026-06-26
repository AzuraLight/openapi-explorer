# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and this project adheres to
[Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/AzuraLight/openapi-explorer/releases/tag/v1.0.0
