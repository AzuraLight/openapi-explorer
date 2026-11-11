// Inline input above the API tree (a small webview view), used instead of the top input box to add an
// API, rename it or edit its URL — closer to typing a name in the Explorer. VS Code tree views cannot
// edit items in place (TreeView has no editing API), so this sits right above the tree.
//
// Protocol
//   extension → view: {type:"open", mode, value, strings} | {type:"busy", text} |
//                     {type:"error", text, detail?, actions} | {type:"close"}
//   view → extension: {type:"ready"} | {type:"submit", value} | {type:"saveAnyway"} |
//                     {type:"login", username, password} | {type:"edit"} | {type:"cancel"}
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";

export type InputMode = "add" | "rename" | "editUrl";

export interface InputRequest {
  mode: InputMode;
  value: string; // initial field value
  target?: string; // URL of the API being renamed / edited
  pendingUrl?: string; // add: URL entered, waiting for Save Anyway / login
}

export const INPUT_VIEW_ID = "swaggerApiInput";
const CTX_OPEN = "swaggerViewer.inputOpen";

export class ApiInputView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  current?: InputRequest;

  constructor(private readonly onMessage: (msg: any) => Promise<void>) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = render(view.webview.cspSource);
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") {
        // Restored by VS Code without a request (e.g. after a reload): default to adding.
        if (!this.current) this.current = { mode: "add", value: "" };
        this.postOpen();
        return;
      }
      await this.onMessage(msg);
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
    if (this.current) this.postOpen();
  }

  post(msg: object): void {
    void this.view?.webview.postMessage(msg);
  }

  async open(req: InputRequest): Promise<void> {
    this.current = req;
    await vscode.commands.executeCommand("setContext", CTX_OPEN, true);
    await vscode.commands.executeCommand(`${INPUT_VIEW_ID}.focus`);
    this.postOpen();
  }

  async close(): Promise<void> {
    this.current = undefined;
    this.post({ type: "close" });
    await vscode.commands.executeCommand("setContext", CTX_OPEN, false);
  }

  private postOpen(): void {
    if (!this.current) return;
    if (this.view) this.view.title = strings(this.current.mode).title;
    this.post({ type: "open", mode: this.current.mode, value: this.current.value, strings: strings(this.current.mode) });
  }
}

function strings(mode: InputMode) {
  const t = vscode.l10n.t;
  return {
    title: mode === "rename" ? t("Rename API") : mode === "editUrl" ? t("Edit API URL") : t("New API"),
    label:
      mode === "rename"
        ? t("New display name")
        : mode === "editUrl"
          ? t("Spec URL")
          : t("Add API — spec URL or Swagger UI page (e.g. .../api-docs)"),
    placeholder: mode === "rename" ? "" : "https://api.example.com/v3/api-docs",
    hint: t("Enter to confirm · Esc to cancel"),
    saveAnyway: t("Save Anyway"),
    edit: t("Edit"),
    login: t("Log In"),
    username: t("Username"),
    password: t("Password"),
  };
}

function render(cspSource: string): string {
  const nonce = randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { padding: 6px 12px 10px; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  label { display: block; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
  input { box-sizing: border-box; width: 100%; padding: 4px 6px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
    font-family: inherit; font-size: inherit; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input.invalid { border-color: var(--vscode-inputValidation-errorBorder); }
  .hint { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .status { margin-top: 6px; white-space: pre-wrap; }
  .status.error { color: var(--vscode-errorForeground); }
  .detail { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: pre-wrap; max-height: 6em; overflow: auto; }
  .row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .login input { margin-top: 6px; }
  button { padding: 3px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font-family: inherit; }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <label id="label" for="value"></label>
  <input id="value" type="text" spellcheck="false" autocomplete="off" aria-describedby="hint status">
  <div id="hint" class="hint"></div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
  <div id="detail" class="detail" hidden></div>
  <div id="login" class="login" hidden>
    <input id="username" type="text" autocomplete="username">
    <input id="password" type="password" autocomplete="current-password">
  </div>
  <div id="actions" class="row"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const value = $("value"), status = $("status"), detail = $("detail"), actions = $("actions"), login = $("login");
  let strings = {}, busy = false;

  function reset() {
    status.textContent = ""; status.className = "status";
    detail.hidden = true; detail.textContent = "";
    actions.replaceChildren(); login.hidden = true;
    value.classList.remove("invalid"); value.removeAttribute("aria-invalid");
    value.disabled = false; busy = false;
  }
  function button(text, onClick, primary) {
    const b = document.createElement("button");
    b.textContent = text; if (primary) b.className = "primary";
    b.addEventListener("click", onClick); actions.appendChild(b); return b;
  }
  function submitLogin() {
    vscode.postMessage({ type: "login", username: $("username").value, password: $("password").value });
  }

  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "open") {
      strings = m.strings || {};
      reset();
      $("label").textContent = strings.label || "";
      $("hint").textContent = strings.hint || "";
      $("username").placeholder = strings.username || ""; $("username").setAttribute("aria-label", strings.username || "");
      $("password").placeholder = strings.password || ""; $("password").setAttribute("aria-label", strings.password || "");
      value.placeholder = strings.placeholder || "";
      value.value = m.value || "";
      value.focus(); value.select();
    } else if (m.type === "busy") {
      reset(); busy = true; value.disabled = true; status.textContent = m.text || "";
    } else if (m.type === "error") {
      reset();
      status.textContent = m.text || ""; status.className = "status error";
      value.classList.add("invalid"); value.setAttribute("aria-invalid", "true");
      if (m.detail) { detail.textContent = m.detail; detail.hidden = false; }
      const acts = m.actions || [];
      if (acts.includes("login")) {
        login.hidden = false;
        button(strings.login, submitLogin, true);
        $("username").focus();
      }
      if (acts.includes("saveAnyway")) button(strings.saveAnyway, () => vscode.postMessage({ type: "saveAnyway" }), true);
      if (acts.includes("edit")) button(strings.edit, () => { reset(); value.focus(); value.select(); });
      if (!acts.includes("login")) value.focus();
    } else if (m.type === "close") {
      reset(); value.value = "";
    }
  });

  value.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !busy) { e.preventDefault(); vscode.postMessage({ type: "submit", value: value.value }); }
    else if (e.key === "Escape") { e.preventDefault(); vscode.postMessage({ type: "cancel" }); }
  });
  for (const id of ["username", "password"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submitLogin(); }
      else if (e.key === "Escape") { e.preventDefault(); vscode.postMessage({ type: "cancel" }); }
    });
  }
  value.addEventListener("input", () => { if (!busy && status.className.includes("error")) reset(); });
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
