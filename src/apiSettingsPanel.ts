// "API settings" tab in the editor area: where an API's URL, name and credentials are entered — like
// adding a folder in the Explorer and then working on it in the editor. One tab per API.
//
// Protocol
//   extension → tab: {type:"init", init, strings} | {type:"update", init} |
//                    {type:"status", kind:"busy"|"ok"|"error", text, detail?, actions?}
//   tab → extension: {type:"save"|"saveAnyway"|"test", data} | {type:"dirty", dirty, data} |
//                    {type:"useLegacy"} | {type:"cancel"}
//
// Saved secrets are never sent to the tab. They appear as a "Saved token ••••  [Delete]" row; Delete only
// marks them (deleteToken / deletePassword) and Save applies it — the usual delete-row pattern
// (Postman Vault: https://learning.postman.com/docs/use/postman-vault/manage-vault-secrets/).
// Webview tabs cannot veto closing (WebviewPanel has only onDidDispose), so unsaved changes are kept as a
// draft and offered back instead of asking first.
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
  deleteToken: boolean; // remove the saved token on save
  deletePassword: boolean; // remove the saved password on save
}

export interface SettingsInit {
  key: string; // spec URL for a saved API, "new:<n>" for one being added
  isNew: boolean;
  name: string;
  url: string;
  auth: AuthKind;
  username: string;
  hasToken: boolean; // a token is saved for this host
  hasPassword: boolean;
  legacyToken: boolean; // a pre-1.1.1 host-less token is waiting to be assigned
  sharedWith: string[]; // other APIs on the same host (credentials are per host)
  focus?: "name" | "url" | "auth";
  draft?: SettingsData; // unsaved changes kept from a tab that was closed
}

// Set when the tab is closed while an operation runs, so a save in flight is not committed.
export interface CancelSignal {
  cancelled: boolean;
}

export interface SettingsHandlers {
  // Return true when the API was saved (the tab then closes). Must not commit once signal.cancelled.
  save(
    init: SettingsInit,
    data: SettingsData,
    anyway: boolean,
    post: (m: object) => void,
    signal: CancelSignal
  ): Promise<boolean>;
  test(init: SettingsInit, data: SettingsData, post: (m: object) => void): Promise<void>;
  // Assign the legacy token to this API; returns the fields of init that changed.
  useLegacy(init: SettingsInit, post: (m: object) => void): Promise<Partial<SettingsInit> | undefined>;
  // draft: the unsaved form when the tab was closed with changes.
  closed(init: SettingsInit, saved: boolean, draft?: SettingsData): void;
}

export const SETTINGS_VIEW_TYPE = "openapiExplorer.apiSettings";

export class ApiSettingsPanels {
  private readonly open = new Map<
    string,
    { panel: vscode.WebviewPanel; init: SettingsInit; discard: boolean; post: (m: object) => void }
  >();

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
    const baseTitle = init.isNew ? str.newTitle : vscode.l10n.t("API Settings: {0}", init.name);
    const panel = vscode.window.createWebviewPanel(
      SETTINGS_VIEW_TYPE,
      baseTitle,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
    );
    panel.iconPath = new vscode.ThemeIcon("gear");
    let saved = false;
    let busy = false; // one save / test / useLegacy at a time (Enter pressed twice, double click)
    const signal: CancelSignal = { cancelled: false };
    let draft: SettingsData | undefined = init.draft;
    const post = (m: object) => void panel.webview.postMessage(m);
    const entry = { panel, init, discard: false, post };
    this.open.set(init.key, entry);
    const setDirty = (dirty: boolean) => (panel.title = dirty ? `● ${baseTitle}` : baseTitle);
    if (init.draft) setDirty(true);
    panel.webview.html = render(panel.webview.cspSource);
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") return post({ type: "init", init: entry.init, strings: str });
      if (msg?.type === "cancel") return panel.dispose();
      if (msg?.type === "dirty") {
        draft = msg.dirty ? sanitize(msg.data) : undefined;
        return setDirty(!!msg.dirty);
      }
      if (!["useLegacy", "test", "save", "saveAnyway"].includes(msg?.type) || busy) return;
      busy = true;
      try {
        if (msg.type === "useLegacy") {
          const changed = await this.handlers.useLegacy(entry.init, post);
          if (changed) {
            entry.init = { ...entry.init, ...changed, draft: undefined };
            post({ type: "update", init: entry.init });
          }
          return;
        }
        const data = sanitize(msg.data);
        if (msg.type === "test") return await this.handlers.test(entry.init, data, post);
        if (await this.handlers.save(entry.init, data, msg.type === "saveAnyway", post, signal)) {
          saved = true;
          panel.dispose();
        }
      } finally {
        busy = false;
      }
    });
    panel.onDidDispose(() => {
      signal.cancelled = true;
      this.open.delete(init.key);
      this.handlers.closed(entry.init, saved, saved || entry.discard ? undefined : draft);
    });
    post({ type: "init", init, strings: str });
  }

  // discard: the API itself is going away (Remove API), so unsaved changes are not kept.
  close(key: string, discard = false): void {
    const e = this.open.get(key);
    if (!e) return;
    e.discard = discard;
    e.panel.dispose();
  }

  // Apply changes to every open tab (e.g. the legacy token was assigned elsewhere).
  updateAll(change: (init: SettingsInit) => Partial<SettingsInit> | undefined): void {
    for (const e of this.open.values()) {
      const c = change(e.init);
      if (!c) continue;
      e.init = { ...e.init, ...c, draft: undefined };
      e.post({ type: "update", init: e.init });
    }
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
    deleteToken: d?.deleteToken === true,
    deletePassword: d?.deletePassword === true,
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
    newToken: t("New token (replaces the saved one)"),
    username: t("Username"),
    password: t("Password"),
    newPassword: t("New password (replaces the saved one)"),
    savedToken: t("Saved token"),
    savedPassword: t("Saved password"),
    willDelete: t("Will be deleted when you save"),
    delete: t("Delete"),
    undo: t("Undo"),
    showToken: t("Show token"),
    hideToken: t("Hide token"),
    showPassword: t("Show password"),
    hidePassword: t("Hide password"),
    legacy: t("A token saved before 1.1.1 is not tied to any API yet."),
    useLegacy: t("Use for this API"),
    authHint: t("Stored in the OS keychain (VS Code SecretStorage) for this host only."),
    test: t("Test Connection"),
    save: t("Save"),
    cancel: t("Cancel"),
    saveAnyway: t("Save Anyway"),
    restored: t("Unsaved changes restored."),
    shared: t("These credentials are saved per host and also apply to:"),
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
  .secret { position: relative; }
  .secret input { padding-right: 32px; }
  .eye { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); width: 26px; height: 24px; padding: 0;
    border: none; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; border-radius: 3px; }
  .eye:hover { background: var(--vscode-toolbar-hoverBackground); }
  .eye svg { width: 16px; height: 16px; vertical-align: middle; }
  .saved { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 3px;
    background: var(--vscode-editorWidget-background, transparent); border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent)); }
  .saved .what { flex: 1; }
  .saved.deleting .what { color: var(--vscode-errorForeground); }
  .linkbtn { padding: 2px 6px; border: none; background: transparent; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; }
  .linkbtn:hover { text-decoration: underline; }
  .row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  button.btn { padding: 5px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font-family: inherit; font-size: inherit; }
  button.btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
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
      <div class="saved" id="legacy" hidden><span class="what" id="legacyText"></span><button class="linkbtn" id="useLegacy"></button></div>
      <div class="saved" id="savedToken" hidden><span class="what"></span><button class="linkbtn"></button></div>
      <div class="secret"><input id="token" type="password" autocomplete="off"><button class="eye" id="eyeToken" type="button" aria-pressed="false"></button></div>
    </div>
    <div class="sub" id="basicFields" hidden>
      <input id="username" type="text" autocomplete="username">
      <div class="saved" id="savedPassword" hidden><span class="what"></span><button class="linkbtn"></button></div>
      <div class="secret"><input id="password" type="password" autocomplete="current-password"><button class="eye" id="eyePassword" type="button" aria-pressed="false"></button></div>
    </div>
    <div class="hint" id="authHint"></div>
    <div class="hint" id="sharedHint" hidden></div>
  </fieldset>
  <div class="row">
    <button id="save" class="btn primary"></button>
    <button id="test" class="btn"></button>
    <button id="cancel" class="btn"></button>
  </div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
  <div id="detail" class="detail" hidden></div>
  <div id="statusActions" class="row"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const EYE = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3C4.5 3 1.8 5.3 1 8c.8 2.7 3.5 5 7 5s6.2-2.3 7-5c-.8-2.7-3.5-5-7-5zm0 8.5A3.5 3.5 0 1 1 8 4.5a3.5 3.5 0 0 1 0 7zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2.3 1.6 1.6 2.3l2.2 2.2C2.5 5.4 1.5 6.6 1 8c.8 2.7 3.5 5 7 5 1.3 0 2.5-.3 3.5-.9l2.2 2.2.7-.7-12.1-12zM8 11.5A3.5 3.5 0 0 1 4.6 7.3l1 1A2 2 0 0 0 7.7 10.4l1 1c-.2.1-.5.1-.7.1zm7-3.5c-.4 1.3-1.3 2.5-2.5 3.4l-1.1-1.1A3.5 3.5 0 0 0 6.8 4.7L5.7 3.6C6.4 3.2 7.2 3 8 3c3.5 0 6.2 2.3 7 5z"/></svg>';
  let S = {}, I = {}, busy = false, initial = "", del = { token: false, password: false };

  const auth = () => (document.querySelector("input[name=auth]:checked") || {}).value || "none";
  const data = () => ({ name: $("name").value, url: $("url").value, auth: auth(),
    token: $("token").value, username: $("username").value, password: $("password").value,
    deleteToken: del.token, deletePassword: del.password });
  const snapshot = () => JSON.stringify(data());

  function reportDirty() { vscode.postMessage({ type: "dirty", dirty: snapshot() !== initial, data: data() }); }
  function showAuth() {
    $("bearerFields").hidden = auth() !== "bearer";
    $("basicFields").hidden = auth() !== "basic";
  }
  function eye(btn, input, showLabel, hideLabel) {
    const paint = () => {
      const shown = input.type === "text";
      btn.innerHTML = shown ? EYE_OFF : EYE;
      btn.setAttribute("aria-label", shown ? hideLabel : showLabel);
      btn.setAttribute("aria-pressed", String(shown));
      btn.title = shown ? hideLabel : showLabel;
    };
    btn.onclick = () => { input.type = input.type === "password" ? "text" : "password"; paint(); input.focus(); };
    input.type = "password"; paint();
  }
  // "Saved token ••••  [Delete]" ⇄ "Will be deleted when you save  [Undo]"
  function savedRow(id, which, has, label, newPlaceholder, plainPlaceholder) {
    const row = $(id), what = row.querySelector(".what"), btn = row.querySelector("button");
    const input = $(which);
    row.hidden = !has;
    const paint = () => {
      row.classList.toggle("deleting", del[which]);
      what.textContent = del[which] ? S.willDelete : label + "  ••••••••";
      btn.textContent = del[which] ? S.undo : S.delete;
      input.placeholder = has && !del[which] ? newPlaceholder : plainPlaceholder;
    };
    btn.onclick = () => { del[which] = !del[which]; paint(); reportDirty(); };
    paint();
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
        const b = document.createElement("button"); b.className = "btn"; b.textContent = S.saveAnyway;
        b.addEventListener("click", () => send("saveAnyway")); box.appendChild(b);
      }
    }
  }
  function send(type) { if (!busy) vscode.postMessage({ type, data: data() }); }

  function apply(i, keepValues) {
    I = i;
    if (!keepValues) {
      const d = i.draft;
      $("url").value = d ? d.url : (i.url || "");
      $("name").value = d ? d.name : (i.isNew ? "" : (i.name || ""));
      $("username").value = d ? d.username : (i.username || "");
      $("token").value = d ? d.token : ""; $("password").value = d ? d.password : "";
      del = { token: !!(d && d.deleteToken), password: !!(d && d.deletePassword) };
      const a = d ? d.auth : (i.auth || "none");
      for (const r of document.querySelectorAll("input[name=auth]")) r.checked = r.value === a;
    } else {
      for (const r of document.querySelectorAll("input[name=auth]")) r.checked = r.value === (i.auth || auth());
    }
    savedRow("savedToken", "token", !!i.hasToken, S.savedToken, S.newToken, S.token);
    savedRow("savedPassword", "password", !!i.hasPassword, S.savedPassword, S.newPassword, S.password);
    $("legacy").hidden = !i.legacyToken || i.isNew;
    const shared = i.sharedWith || [];
    $("sharedHint").hidden = shared.length === 0;
    $("sharedHint").textContent = shared.length ? S.shared + " " + shared.join(", ") : "";
    showAuth();
  }

  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "init") {
      S = m.strings || {}; const i = m.init || {};
      $("heading").textContent = i.isNew ? S.newTitle : S.heading;
      for (const [id, k] of [["urlLabel","url"],["urlHint","urlHint"],["nameLabel","name"],["nameHint","nameHint"],["authLabel","auth"],
        ["noneLabel","none"],["bearerLabel","bearer"],["basicLabel","basic"],["authHint","authHint"],["save","save"],["test","test"],
        ["cancel","cancel"],["legacyText","legacy"],["useLegacy","useLegacy"]])
        $(id).textContent = S[k] || "";
      $("token").setAttribute("aria-label", S.token);
      $("username").placeholder = S.username; $("username").setAttribute("aria-label", S.username);
      $("password").setAttribute("aria-label", S.password);
      eye($("eyeToken"), $("token"), S.showToken, S.hideToken);
      eye($("eyePassword"), $("password"), S.showPassword, S.hidePassword);
      // The baseline for "dirty" is the saved state, so a restored draft still counts as unsaved.
      apply({ ...i, draft: undefined });
      initial = snapshot();
      if (i.draft) apply(i);
      setBusy(false);
      status(i.draft ? "ok" : "", i.draft ? S.restored : "");
      if (i.draft) reportDirty();
      const target = i.focus === "name" ? $("name") : i.focus === "auth" ? (document.querySelector("input[name=auth]:checked")) : $("url");
      target.focus(); if (target.select) target.select();
    } else if (m.type === "update") {
      apply(m.init, true);
      initial = snapshot(); reportDirty();
    } else if (m.type === "status") {
      setBusy(m.kind === "busy");
      status(m.kind === "busy" ? "" : m.kind, m.text, m.detail, m.actions);
    }
  });
  for (const r of document.querySelectorAll("input[name=auth]")) r.addEventListener("change", () => { showAuth(); reportDirty(); });
  for (const id of ["url", "name", "token", "username", "password"]) $(id).addEventListener("input", reportDirty);
  $("useLegacy").addEventListener("click", () => vscode.postMessage({ type: "useLegacy" }));
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
