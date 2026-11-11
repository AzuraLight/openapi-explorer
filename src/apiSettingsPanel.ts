// "API settings" tab in the editor area: where an API's URL, name and credentials are entered — like
// adding a folder in the Explorer and then working on it in the editor. One tab per API.
//
// Protocol
//   extension → tab: {type:"init", init, strings} | {type:"status", kind:"busy"|"ok"|"error", text, detail?, actions?}
//   tab → extension: {type:"save", data} | {type:"saveAnyway", data} | {type:"test", data} | {type:"cancel"}
//   data = { name, url, auth: "none"|"bearer"|"basic", token, username, password }
// Saved secrets are never sent to the tab: an empty token/password field means "keep the saved one".
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";

export type AuthKind = "none" | "bearer" | "basic";

export interface SettingsData {
  name: string;
  url: string;
  auth: AuthKind;
  token: string;
  username: string;
  password: string;
}

export interface SettingsInit {
  key: string; // spec URL for a saved API, "new:<n>" for one being added
  isNew: boolean;
  name: string;
  url: string;
  auth: AuthKind;
  username: string;
  hasToken: boolean; // a token is saved for this host (field may stay empty)
  hasPassword: boolean;
  focus?: "name" | "url" | "auth";
}

export interface SettingsHandlers {
  // Return true when the API was saved (the tab then closes).
  save(init: SettingsInit, data: SettingsData, anyway: boolean, post: (m: object) => void): Promise<boolean>;
  test(init: SettingsInit, data: SettingsData, post: (m: object) => void): Promise<void>;
  closed(init: SettingsInit, saved: boolean): void;
}

export const SETTINGS_VIEW_TYPE = "openapiExplorer.apiSettings";

export class ApiSettingsPanels {
  private readonly open = new Map<string, { panel: vscode.WebviewPanel; init: SettingsInit }>();

  constructor(private readonly handlers: SettingsHandlers) {}

  has(key: string): boolean {
    return this.open.has(key);
  }

  show(init: SettingsInit): void {
    const existing = this.open.get(init.key);
    if (existing) {
      existing.panel.reveal(undefined, false);
      return;
    }
    const str = strings();
    const panel = vscode.window.createWebviewPanel(
      SETTINGS_VIEW_TYPE,
      init.isNew ? str.newTitle : vscode.l10n.t("API Settings: {0}", init.name),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
    );
    panel.iconPath = new vscode.ThemeIcon("gear");
    let saved = false;
    const entry = { panel, init };
    this.open.set(init.key, entry);
    const post = (m: object) => void panel.webview.postMessage(m);
    panel.webview.html = render(panel.webview.cspSource);
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") return post({ type: "init", init: entry.init, strings: str });
      if (msg?.type === "cancel") return panel.dispose();
      const data = sanitize(msg?.data);
      if (msg?.type === "test") return this.handlers.test(entry.init, data, post);
      if (msg?.type === "save" || msg?.type === "saveAnyway") {
        if (await this.handlers.save(entry.init, data, msg.type === "saveAnyway", post)) {
          saved = true;
          panel.dispose();
        }
      }
    });
    panel.onDidDispose(() => {
      this.open.delete(init.key);
      this.handlers.closed(init, saved);
    });
    post({ type: "init", init, strings: str });
  }

  close(key: string): void {
    this.open.get(key)?.panel.dispose();
  }
}

function sanitize(d: any): SettingsData {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const auth: AuthKind = d?.auth === "bearer" || d?.auth === "basic" ? d.auth : "none";
  return {
    name: s(d?.name).trim(),
    url: s(d?.url).trim(),
    auth,
    token: s(d?.token).trim(),
    username: s(d?.username).trim(),
    password: s(d?.password),
  };
}

function strings() {
  const t = vscode.l10n.t;
  return {
    newTitle: t("New API"),
    heading: t("API Settings"),
    url: t("Spec URL"),
    urlHint: t(
      "A spec URL or a Swagger UI page address (e.g. .../api-docs). The real spec is found automatically."
    ),
    name: t("Display name"),
    nameHint: t("Leave empty to use the spec's title."),
    auth: t("Authentication"),
    none: t("None"),
    bearer: t("Bearer token"),
    basic: t("Username & password"),
    token: t("Token"),
    username: t("Username"),
    password: t("Password"),
    keep: t("Saved — leave empty to keep"),
    authHint: t("Stored in the OS keychain (VS Code SecretStorage) for this host only."),
    test: t("Test Connection"),
    save: t("Save"),
    cancel: t("Cancel"),
    saveAnyway: t("Save Anyway"),
  };
}

function render(cspSource: string): string {
  const nonce = randomBytes(16)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { max-width: 640px; padding: 20px 28px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 18px; }
  .field { margin-bottom: 16px; }
  .field > label, legend { display: block; font-weight: 600; margin-bottom: 6px; }
  .hint { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  input[type=text], input[type=password] { box-sizing: border-box; width: 100%; padding: 5px 7px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
    font-family: inherit; font-size: inherit; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input.invalid { border-color: var(--vscode-inputValidation-errorBorder); }
  fieldset { border: none; padding: 0; margin: 0 0 16px; }
  .radios { display: flex; gap: 18px; flex-wrap: wrap; }
  .radios label { display: flex; align-items: center; gap: 6px; }
  .sub { margin-top: 10px; display: grid; gap: 8px; }
  .row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  button { padding: 5px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font-family: inherit; font-size: inherit; }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button:disabled { opacity: .6; cursor: default; }
  .status { margin-top: 14px; white-space: pre-wrap; }
  .status.ok { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
  .status.error { color: var(--vscode-errorForeground); }
  .detail { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: pre-wrap; max-height: 8em; overflow: auto; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <h1 id="heading"></h1>
  <div class="field">
    <label for="url" id="urlLabel"></label>
    <input id="url" type="text" spellcheck="false" autocomplete="off" placeholder="https://api.example.com/v3/api-docs" aria-describedby="urlHint">
    <div class="hint" id="urlHint"></div>
  </div>
  <div class="field">
    <label for="name" id="nameLabel"></label>
    <input id="name" type="text" spellcheck="false" autocomplete="off" aria-describedby="nameHint">
    <div class="hint" id="nameHint"></div>
  </div>
  <fieldset>
    <legend id="authLabel"></legend>
    <div class="radios" role="radiogroup">
      <label><input type="radio" name="auth" value="none"><span id="noneLabel"></span></label>
      <label><input type="radio" name="auth" value="bearer"><span id="bearerLabel"></span></label>
      <label><input type="radio" name="auth" value="basic"><span id="basicLabel"></span></label>
    </div>
    <div class="sub" id="bearerFields" hidden>
      <input id="token" type="password" autocomplete="off">
    </div>
    <div class="sub" id="basicFields" hidden>
      <input id="username" type="text" autocomplete="username">
      <input id="password" type="password" autocomplete="current-password">
    </div>
    <div class="hint" id="authHint"></div>
  </fieldset>
  <div class="row">
    <button id="save" class="primary"></button>
    <button id="test"></button>
    <button id="cancel"></button>
  </div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
  <div id="detail" class="detail" hidden></div>
  <div id="statusActions" class="row"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let S = {}, busy = false;

  const auth = () => (document.querySelector("input[name=auth]:checked") || {}).value || "none";
  const data = () => ({ name: $("name").value, url: $("url").value, auth: auth(),
    token: $("token").value, username: $("username").value, password: $("password").value });
  function showAuth() {
    $("bearerFields").hidden = auth() !== "bearer";
    $("basicFields").hidden = auth() !== "basic";
  }
  function setBusy(b) {
    busy = b;
    for (const id of ["save", "test", "url", "name", "token", "username", "password"]) $(id).disabled = b;
  }
  function status(kind, text, detail, actions) {
    $("status").className = "status " + (kind || "");
    $("status").textContent = text || "";
    $("detail").hidden = !detail; $("detail").textContent = detail || "";
    $("url").classList.toggle("invalid", kind === "error");
    const box = $("statusActions"); box.replaceChildren();
    for (const a of actions || []) {
      if (a === "saveAnyway") {
        const b = document.createElement("button"); b.textContent = S.saveAnyway;
        b.addEventListener("click", () => send("saveAnyway")); box.appendChild(b);
      }
    }
  }
  function send(type) { if (!busy) vscode.postMessage({ type, data: data() }); }

  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "init") {
      S = m.strings || {}; const i = m.init || {};
      $("heading").textContent = i.isNew ? S.newTitle : S.heading;
      for (const [id, k] of [["urlLabel","url"],["urlHint","urlHint"],["nameLabel","name"],["nameHint","nameHint"],["authLabel","auth"],
        ["noneLabel","none"],["bearerLabel","bearer"],["basicLabel","basic"],["authHint","authHint"],["save","save"],["test","test"],["cancel","cancel"]])
        $(id).textContent = S[k] || "";
      $("url").value = i.url || ""; $("name").value = i.isNew ? "" : (i.name || "");
      $("token").placeholder = i.hasToken ? S.keep : S.token; $("token").setAttribute("aria-label", S.token);
      $("username").placeholder = S.username; $("username").setAttribute("aria-label", S.username);
      $("username").value = i.username || "";
      $("password").placeholder = i.hasPassword ? S.keep : S.password; $("password").setAttribute("aria-label", S.password);
      for (const r of document.querySelectorAll("input[name=auth]")) r.checked = r.value === (i.auth || "none");
      showAuth(); setBusy(false); status("", "");
      const target = i.focus === "name" ? $("name") : i.focus === "auth" ? (document.querySelector("input[name=auth]:checked")) : $("url");
      target.focus(); if (target.select) target.select();
    } else if (m.type === "status") {
      setBusy(m.kind === "busy");
      status(m.kind === "busy" ? "" : m.kind, m.text, m.detail, m.actions);
    }
  });
  for (const r of document.querySelectorAll("input[name=auth]")) r.addEventListener("change", showAuth);
  $("save").addEventListener("click", () => send("save"));
  $("test").addEventListener("click", () => send("test"));
  $("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") { e.preventDefault(); send("save"); }
    else if (e.key === "Escape") { e.preventDefault(); vscode.postMessage({ type: "cancel" }); }
  });
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
