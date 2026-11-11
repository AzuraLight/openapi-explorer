import * as vscode from "vscode";
import { resolveSpec, getSchemas, clearCache, type ResolveResult } from "./specLoader";
import {
  groupByTag,
  listEndpoints,
  endpointDetail,
  genTsForModel,
  genTsForEndpoint,
  genCurl,
  genFetchClient,
  genAxiosClient,
} from "./model";
import { openSwaggerUi, type FocusTarget } from "./swaggerUi";
import { createHttpFetcher, type HttpOptions } from "./http";
import { ApiSettingsPanels, type AuthKind, type SettingsData, type SettingsInit } from "./apiSettingsPanel";

// Credentials are stored per host (like npm/git/gh) so a credential is only ever sent to its own host.
const SECRET_TOKEN_KEY = "swaggerViewer.bearerTokens"; // { [host]: token }
const SECRET_BASIC_KEY = "swaggerViewer.basicAuth"; // { [host]: { username, password } }
// ≤1.1.0 stored a single global token here; migrated by migrateLegacyToken().
const LEGACY_TOKEN_KEY = "swaggerViewer.authToken";

interface SpecConfig {
  name: string;
  url: string;
}

// Cache of loaded specs (keyed by input URL)
const specCache = new Map<string, ResolveResult>();

// Save to Workspace settings if a workspace is open, otherwise Global (user) settings.
// (Writing Workspace settings fails in a window opened without a folder)
function configTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// A registered API and where it is stored, so edits go back to the same place.
interface SpecEntry extends SpecConfig {
  source: "specs" | "url"; // swaggerViewer.specs[], or the legacy single swaggerViewer.url
  target: vscode.ConfigurationTarget;
}

// Scope that holds a setting: workspace if it is set there, otherwise user settings.
function scopeOf(key: "specs" | "url"): vscode.ConfigurationTarget {
  const i = vscode.workspace.getConfiguration("swaggerViewer").inspect(key);
  return i?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

// Registered APIs: the legacy `url` (kept as is, never rewritten automatically) followed by `specs`.
// Before 1.3.0 `url` was hidden as soon as `specs` had an entry.
function specEntries(): SpecEntry[] {
  const cfg = vscode.workspace.getConfiguration("swaggerViewer");
  const specs = (cfg.get<SpecConfig[]>("specs") || []).filter((s) => s && s.url);
  const out: SpecEntry[] = [];
  const url = (cfg.get<string>("url") || "").trim();
  if (url && !specs.some((s) => s.url === url))
    out.push({ name: hostOf(url), url, source: "url", target: scopeOf("url") });
  const target = scopeOf("specs");
  for (const s of specs) out.push({ name: s.name || hostOf(s.url), url: s.url, source: "specs", target });
  return out;
}

function getSpecConfigs(): SpecConfig[] {
  return specEntries();
}

// Change (or remove, when `change` returns null) the API registered under `url`, in its own scope.
// Renaming/editing the legacy `url` entry moves it into `specs` (first position) and clears `url`.
async function updateEntry(url: string, change: (e: SpecConfig) => SpecConfig | null): Promise<boolean> {
  const entry = specEntries().find((e) => e.url === url);
  if (!entry) return false;
  const cfg = vscode.workspace.getConfiguration("swaggerViewer");
  const next = change({ name: entry.name, url: entry.url });
  const specsIn = (t: vscode.ConfigurationTarget): SpecConfig[] => {
    const i = cfg.inspect<SpecConfig[]>("specs");
    return [...((t === vscode.ConfigurationTarget.Workspace ? i?.workspaceValue : i?.globalValue) || [])];
  };
  if (entry.source === "url") {
    if (next) {
      const specs = specsIn(entry.target);
      specs.unshift(next);
      await cfg.update("specs", specs, entry.target);
    }
    await cfg.update("url", undefined, entry.target);
    return true;
  }
  const specs = specsIn(entry.target);
  const idx = specs.findIndex((s) => s && s.url === url);
  if (idx < 0) return false;
  if (next) specs[idx] = next;
  else specs.splice(idx, 1);
  await cfg.update("specs", specs, entry.target);
  return true;
}

const isHttpUrl = (s: string): boolean => {
  try {
    return /^https?:$/.test(new URL(s).protocol);
  } catch {
    return false;
  }
};

interface BasicCredential {
  username: string;
  password: string;
}

// Configured headers + SecretStorage credentials → request headers.
// Priority: custom Authorization header > Bearer token > Basic (username/password).
// Token and Basic credentials are per-host; targetUrl selects which host's credential applies.
// Without a targetUrl no stored credential is attached.
async function buildHeaders(
  context: vscode.ExtensionContext,
  targetUrl?: string
): Promise<Record<string, string>> {
  const cfg = vscode.workspace.getConfiguration("swaggerViewer");
  const headers: Record<string, string> = { ...(cfg.get<Record<string, string>>("headers") || {}) };
  if (!headers["Authorization"] && targetUrl) {
    const host = hostOf(targetUrl);
    const token = (await readTokenMap(context))[host];
    const basic = (await readBasicAuthMap(context))[host];
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    } else if (basic) {
      const encoded = Buffer.from(`${basic.username}:${basic.password}`).toString("base64");
      headers["Authorization"] = `Basic ${encoded}`;
    }
  }
  return headers;
}

// A { [host]: value } map stored as JSON in one SecretStorage entry. Invalid entries are dropped.
async function readHostMap<T>(
  context: vscode.ExtensionContext,
  key: string,
  isValid: (v: unknown) => v is T
): Promise<Record<string, T>> {
  const raw = await context.secrets.get(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(Object.entries(parsed).filter(([, v]) => isValid(v))) as Record<string, T>;
    }
  } catch {
    /* ignore corrupted value */
  }
  return {};
}

async function writeHostMap(context: vscode.ExtensionContext, key: string, map: object): Promise<void> {
  if (Object.keys(map).length === 0) await context.secrets.delete(key);
  else await context.secrets.store(key, JSON.stringify(map));
}

const isBasic = (v: unknown): v is BasicCredential =>
  !!v &&
  typeof (v as BasicCredential).username === "string" &&
  typeof (v as BasicCredential).password === "string";
const isToken = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const readBasicAuthMap = (c: vscode.ExtensionContext) => readHostMap(c, SECRET_BASIC_KEY, isBasic);
const writeBasicAuthMap = (c: vscode.ExtensionContext, m: Record<string, BasicCredential>) =>
  writeHostMap(c, SECRET_BASIC_KEY, m);
const readTokenMap = (c: vscode.ExtensionContext) => readHostMap(c, SECRET_TOKEN_KEY, isToken);
const writeTokenMap = (c: vscode.ExtensionContext, m: Record<string, string>) =>
  writeHostMap(c, SECRET_TOKEN_KEY, m);

function registeredHosts(): string[] {
  return [...new Set(getSpecConfigs().map((c) => hostOf(c.url)))];
}

// ≤1.1.0 kept one global token and sent it to every host. Never spread it silently:
// with exactly one registered host it moves there; otherwise the user chooses the host(s),
// and until then it is kept but not sent anywhere.
// ≤1.1.0 kept one global token and sent it to every host. Never spread it silently:
// with exactly one registered host it moves there; otherwise the user is asked to choose the host(s)
// (inline, see "assignToken"), and until then it is kept but not sent anywhere.
async function migrateLegacyToken(
  context: vscode.ExtensionContext,
  onChange: () => void,
  chooseHosts: (hosts: string[]) => Promise<void>
): Promise<void> {
  const legacy = await context.secrets.get(LEGACY_TOKEN_KEY);
  if (!legacy) return;
  const hosts = registeredHosts();
  if (hosts.length === 0) return;
  if (hosts.length === 1) {
    await assignLegacyToken(context, hosts);
    onChange();
    return;
  }
  const choose = vscode.l10n.t("Choose hosts");
  const answer = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Auth tokens are now saved per host. Choose which host(s) your saved token belongs to — until then it is not sent."
    ),
    choose
  );
  if (answer === choose) await chooseHosts(hosts);
}

async function assignLegacyToken(context: vscode.ExtensionContext, hosts: string[]): Promise<boolean> {
  const legacy = await context.secrets.get(LEGACY_TOKEN_KEY);
  if (!legacy) return false;
  const map = await readTokenMap(context);
  for (const h of hosts) if (!map[h]) map[h] = legacy;
  await writeTokenMap(context, map);
  await context.secrets.delete(LEGACY_TOKEN_KEY);
  return true;
}

async function buildHttpOptions(context: vscode.ExtensionContext, targetUrl?: string): Promise<HttpOptions> {
  const cfg = vscode.workspace.getConfiguration("swaggerViewer");
  const vscodeProxy = vscode.workspace.getConfiguration("http").get<string>("proxy") || "";
  return {
    headers: await buildHeaders(context, targetUrl),
    strictSSL: cfg.get<boolean>("strictSSL", true),
    caCertPath: cfg.get<string>("caCertPath") || undefined,
    proxy: cfg.get<string>("proxy") || vscodeProxy || undefined,
  };
}

async function ensureSpec(
  context: vscode.ExtensionContext,
  url: string,
  force = false
): Promise<ResolveResult> {
  if (!force && specCache.has(url)) return specCache.get(url)!;
  const fetcher = createHttpFetcher(await buildHttpOptions(context, url));
  const res = await resolveSpec(url, { force, fetcher });
  specCache.set(url, res);
  return res;
}

// ---------------- Tree ----------------
type Node = vscode.TreeItem & {
  _specUrl?: string;
  _tag?: string;
  _models?: boolean;
  _specNode?: boolean;
  _kind?: "endpoint" | "model";
  _path?: string;
  _method?: string;
  _operationId?: string;
  _name?: string;
  _apiRoot?: boolean; // top-level node of a registered API
  _pendingKey?: string; // top-level "New API" being added (not saved yet)
};

class SwaggerTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  // Keys of APIs being added; shown as "New API" nodes after the registered ones.
  pending: () => string[] = () => [];

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(item: Node): vscode.TreeItem {
    return item;
  }

  // Only top-level API nodes are revealed (after Add API); they have no parent.
  getParent(): Node | undefined {
    return undefined;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    const configs = getSpecConfigs();
    if (!element) {
      const pending = this.pending().map((key) => {
        const n: Node = new vscode.TreeItem(vscode.l10n.t("New API"), vscode.TreeItemCollapsibleState.None);
        n.id = key;
        n.description = vscode.l10n.t("not saved");
        n.iconPath = new vscode.ThemeIcon("gear");
        n.contextValue = "pendingApi";
        n._pendingKey = key;
        n.command = { command: "swaggerViewer.openApiSettings", title: "open", arguments: [key] };
        return n;
      });
      return [...(await this.apiRoots(configs)), ...pending];
    }
    if (!configs.length) return [];
    return this.childrenOf(element);
  }

  private async apiRoots(configs: SpecConfig[]): Promise<Node[]> {
    // Each registered API (gateway) is a top-level node, like a root folder in the Explorer;
    // its right-click menu opens its settings.
    const basicMap = await readBasicAuthMap(this.context);
    const tokenMap = await readTokenMap(this.context);
    return configs.map((c) => {
      const host = hostOf(c.url);
      const cred = basicMap[host];
      const hasToken = !!tokenMap[host];
      const n: Node = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.Collapsed);
      const parts: string[] = [];
      if (c.name !== host) parts.push(host);
      if (hasToken) parts.push("🔑 Bearer");
      if (cred) parts.push(`🔑 ${cred.username}`);
      n.description = parts.join(" · ") || undefined;
      n.iconPath = new vscode.ThemeIcon("server");
      // "spec" + flags; package.json menus match with `viewItem =~ /^spec/`, `/:token/`, `/:basic/`.
      n.contextValue = `spec${hasToken ? ":token" : ""}${cred ? ":basic" : ""}`;
      const tip = [c.url];
      if (hasToken) tip.push("Bearer token");
      if (cred) tip.push(`Basic auth: ${cred.username}`);
      n.tooltip = tip.join("\n");
      n._specNode = true;
      n._specUrl = c.url;
      n._apiRoot = true;
      n.id = `api:${c.url}`; // stable identity so the node can be revealed after adding
      return n;
    });
  }

  private async childrenOf(element: Node): Promise<Node[]> {
    if (element._specNode && element._specUrl) return this.specChildren(element._specUrl);

    const url = element._specUrl;
    if (!url) return [];
    let res: ResolveResult;
    try {
      res = await ensureSpec(this.context, url);
    } catch (e: any) {
      console.error("[openapi-explorer] failed to load spec", url, e);
      const it: Node = new vscode.TreeItem(
        vscode.l10n.t("Failed to load"),
        vscode.TreeItemCollapsibleState.None
      );
      it.tooltip = e?.message ?? String(e);
      it.iconPath = new vscode.ThemeIcon("error");
      return [it];
    }
    const spec = res.spec;

    if (element._models) {
      return Object.keys(getSchemas(spec)).map((name) => {
        const it: Node = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon("symbol-class");
        it.contextValue = "model";
        it._specUrl = url;
        it._kind = "model";
        it._name = name;
        it.command = {
          command: "swaggerViewer.openOperation",
          title: "open",
          arguments: [it],
        };
        return it;
      });
    }
    if (element._tag) {
      const eps = groupByTag(spec).get(element._tag) || [];
      return eps.map((e) => {
        const it: Node = new vscode.TreeItem(`${e.method} ${e.path}`, vscode.TreeItemCollapsibleState.None);
        it.tooltip = e.summary;
        it.description = e.summary;
        it.iconPath = methodIcon(e.method);
        it.contextValue = "endpoint";
        it._specUrl = url;
        it._kind = "endpoint";
        it._path = e.path;
        it._method = e.method;
        it._tag = e.tag;
        it._operationId = e.operationId;
        it.command = {
          command: "swaggerViewer.openOperation",
          title: "open",
          arguments: [it],
        };
        return it;
      });
    }
    return [];
  }

  // Tag/model nodes for a single spec (tags collapsed by default)
  private async specChildren(url: string): Promise<Node[]> {
    let res: ResolveResult;
    try {
      res = await ensureSpec(this.context, url);
    } catch (e: any) {
      const it: Node = new vscode.TreeItem(
        vscode.l10n.t("Failed to load"),
        vscode.TreeItemCollapsibleState.None
      );
      it.tooltip = e?.message ?? String(e);
      it.iconPath = new vscode.ThemeIcon("error");
      return [it];
    }
    // springdoc groups: one node per group; each group node is itself a spec node for its own URL.
    if (res.groups && res.groups.length > 1) {
      return res.groups.map((g) => {
        const n: Node = new vscode.TreeItem(g.name, vscode.TreeItemCollapsibleState.Collapsed);
        n.iconPath = new vscode.ThemeIcon("folder-library");
        n.contextValue = "group";
        n.tooltip = g.url;
        n._specNode = true;
        n._specUrl = g.url;
        return n;
      });
    }
    const spec = res.spec;
    const nodes: Node[] = [];
    for (const [tag, eps] of groupByTag(spec)) {
      const t: Node = new vscode.TreeItem(tag, vscode.TreeItemCollapsibleState.Collapsed);
      t.contextValue = "tag";
      t.description = `${eps.length}`;
      t.iconPath = new vscode.ThemeIcon("symbol-namespace");
      t._tag = tag;
      t._specUrl = url;
      nodes.push(t);
    }
    const modelCount = Object.keys(getSchemas(spec)).length;
    if (modelCount) {
      const m: Node = new vscode.TreeItem("Models", vscode.TreeItemCollapsibleState.Collapsed);
      m.description = `${modelCount}`;
      m.iconPath = new vscode.ThemeIcon("symbol-structure");
      m._models = true;
      m._specUrl = url;
      nodes.push(m);
    }
    return nodes;
  }
}

function methodIcon(method: string): vscode.ThemeIcon {
  const map: Record<string, vscode.ThemeIcon> = {
    GET: new vscode.ThemeIcon("arrow-down", new vscode.ThemeColor("charts.blue")),
    POST: new vscode.ThemeIcon("add", new vscode.ThemeColor("charts.green")),
    PUT: new vscode.ThemeIcon("arrow-up", new vscode.ThemeColor("charts.orange")),
    PATCH: new vscode.ThemeIcon("edit", new vscode.ThemeColor("charts.yellow")),
    DELETE: new vscode.ThemeIcon("trash", new vscode.ThemeColor("charts.red")),
  };
  return map[method] || new vscode.ThemeIcon("symbol-method");
}

// ---------------- Swagger UI jump ----------------
async function openOperation(context: vscode.ExtensionContext, node: Node): Promise<void> {
  if (!node?._specUrl) return;
  let res: ResolveResult;
  try {
    res = await ensureSpec(context, node._specUrl);
  } catch (e: any) {
    vscode.window.showErrorMessage(vscode.l10n.t("Failed to load spec: {0}", e?.message ?? String(e)));
    return;
  }
  const focus: FocusTarget | undefined =
    node._kind === "model" && node._name
      ? { kind: "model", name: node._name }
      : node._kind === "endpoint" && node._tag && node._path && node._method
        ? {
            kind: "operation",
            tag: node._tag,
            operationId: node._operationId,
            method: node._method,
            path: node._path,
          }
        : undefined;
  const httpOptions = await buildHttpOptions(context, res.specUrl);
  openSwaggerUi(context, res.spec, res.spec.info?.title || "Swagger UI", res.specUrl, httpOptions, focus);
}

// ---------------- Code generation (tree right-click) ----------------
async function copyForNode(
  context: vscode.ExtensionContext,
  node: Node,
  kind: "ts" | "fetch" | "axios" | "curl"
): Promise<void> {
  if (!node?._specUrl) return;
  let res: ResolveResult;
  try {
    res = await ensureSpec(context, node._specUrl);
  } catch (e: any) {
    vscode.window.showErrorMessage(vscode.l10n.t("Failed to load spec: {0}", e?.message ?? String(e)));
    return;
  }
  const spec = res.spec;
  let text = "";
  let label = "";

  if (node._kind === "model" && node._name) {
    text = genTsForModel(spec, node._name);
    label = "TypeScript";
  } else if (node._kind === "endpoint" && node._path && node._method) {
    const detail = endpointDetail(spec, node._path, node._method);
    if (!detail) return;
    if (kind === "ts") {
      text = genTsForEndpoint(spec, detail);
      label = "TypeScript";
    } else if (kind === "fetch") {
      text = genFetchClient(spec, detail, res.specUrl);
      label = "fetch";
    } else if (kind === "axios") {
      text = genAxiosClient(spec, detail, res.specUrl);
      label = "axios";
    } else {
      text = genCurl(spec, detail, res.specUrl);
      label = "cURL";
    }
  } else {
    return;
  }
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage(vscode.l10n.t("Copied {0} to clipboard.", label));
}

// Select the target spec (tree node argument / single / QuickPick)
async function pickSpecUrl(arg?: Node): Promise<string | undefined> {
  if (arg?._specUrl) return arg._specUrl;
  const configs = getSpecConfigs();
  if (configs.length === 0) {
    vscode.window.showWarningMessage(vscode.l10n.t("No Swagger spec registered."));
    return undefined;
  }
  if (configs.length === 1) return configs[0].url;
  const pick = await vscode.window.showQuickPick(
    configs.map((c) => ({ label: c.name, description: hostOf(c.url), url: c.url })),
    { placeHolder: vscode.l10n.t("Select a spec (gateway)") }
  );
  return pick?.url;
}

// ---------------- Activation ----------------
export function activate(context: vscode.ExtensionContext): void {
  const provider = new SwaggerTreeProvider(context);
  const treeView = vscode.window.createTreeView("swaggerExplorer", { treeDataProvider: provider });
  const resetCaches = () => {
    specCache.clear();
    clearCache();
    provider.refresh();
  };

  async function scan(url: string): Promise<{ res?: ResolveResult; error?: Error }> {
    try {
      return { res: await ensureSpec(context, url, true) };
    } catch (e: any) {
      return { error: e instanceof Error ? e : new Error(String(e)) };
    }
  }

  // ---- credentials of a host ----
  type Creds = { token?: string; basic?: BasicCredential };
  async function credsOf(host: string): Promise<Creds> {
    return { token: (await readTokenMap(context))[host], basic: (await readBasicAuthMap(context))[host] };
  }
  async function writeCreds(host: string, c: Creds): Promise<void> {
    const tokens = await readTokenMap(context);
    const basics = await readBasicAuthMap(context);
    if (c.token) tokens[host] = c.token;
    else delete tokens[host];
    if (c.basic) basics[host] = c.basic;
    else delete basics[host];
    await writeTokenMap(context, tokens);
    await writeBasicAuthMap(context, basics);
  }
  // What the settings form asks for, merged with what is saved (empty secret field = keep saved).
  function wantedCreds(data: SettingsData, saved: Creds): Creds {
    if (data.auth === "bearer") return { token: data.token || saved.token };
    if (data.auth === "basic") {
      return { basic: { username: data.username, password: data.password || saved.basic?.password || "" } };
    }
    return {};
  }

  // ---- the "API settings" tab (editor area) ----
  const pendingApis = new Map<string, number>(); // "new:<n>" → n, APIs being added (not saved yet)
  let pendingSeq = 0;
  provider.pending = () => [...pendingApis.keys()];

  function settingsError(url: string, error: Error) {
    const login = /Login required/.test(error.message);
    return {
      type: "status",
      kind: "error",
      text: login
        ? vscode.l10n.t("{0} requires a login. Choose Bearer token or Username & password.", url)
        : vscode.l10n.t("No OpenAPI spec found at {0}.", url),
      detail: error.message,
      actions: ["saveAnyway"],
    };
  }

  const settings = new ApiSettingsPanels({
    async test(_init, data, post) {
      if (!isHttpUrl(data.url))
        return post({ type: "status", kind: "error", text: vscode.l10n.t("Enter an http(s) URL") });
      const host = hostOf(data.url);
      const saved = await credsOf(host);
      post({
        type: "status",
        kind: "busy",
        text: vscode.l10n.t("Looking for an OpenAPI spec at {0}…", data.url),
      });
      // Try with the credentials as entered, then put the saved ones back.
      await writeCreds(host, wantedCreds(data, saved));
      const { res, error } = await scan(data.url);
      await writeCreds(host, saved);
      specCache.delete(data.url);
      clearCache();
      if (error) return post(settingsError(data.url, error));
      const count = listEndpoints(res!.spec).length;
      post({
        type: "status",
        kind: "ok",
        text: vscode.l10n.t(
          "Connected: {0} — {1} endpoints",
          res!.spec.info?.title || hostOf(data.url),
          String(count)
        ),
      });
    },

    async save(init, data, anyway, post) {
      if (!isHttpUrl(data.url)) {
        post({ type: "status", kind: "error", text: vscode.l10n.t("Enter an http(s) URL") });
        return false;
      }
      const original = init.isNew ? undefined : init.key;
      if (data.url !== original && specEntries().some((e) => e.url === data.url)) {
        post({
          type: "status",
          kind: "error",
          text: vscode.l10n.t("This API is already registered: {0}", data.url),
        });
        return false;
      }
      if (data.auth === "basic" && !data.username) {
        post({ type: "status", kind: "error", text: vscode.l10n.t("Enter a username") });
        return false;
      }
      const host = hostOf(data.url);
      const saved = await credsOf(host);
      await writeCreds(host, wantedCreds(data, saved));
      let res: ResolveResult | undefined;
      if (!anyway) {
        post({
          type: "status",
          kind: "busy",
          text: vscode.l10n.t("Looking for an OpenAPI spec at {0}…", data.url),
        });
        const r = await scan(data.url);
        if (r.error) {
          await writeCreds(host, saved);
          post(settingsError(data.url, r.error));
          return false;
        }
        res = r.res;
      }
      const name = data.name || res?.spec.info?.title || (init.isNew ? hostOf(data.url) : init.name);
      if (original) {
        await updateEntry(original, () => ({ name, url: data.url }));
      } else {
        const cfg = vscode.workspace.getConfiguration("swaggerViewer");
        const i = cfg.inspect<SpecConfig[]>("specs");
        const target =
          i?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : configTarget();
        const current =
          (target === vscode.ConfigurationTarget.Workspace ? i?.workspaceValue : i?.globalValue) || [];
        await cfg.update("specs", [...current, { name, url: data.url }], target);
        pendingApis.delete(init.key);
      }
      resetCaches();
      const node = (await provider.getChildren()).find((n) => n._specUrl === data.url && n._apiRoot);
      if (node) await treeView.reveal(node, { select: true, focus: false, expand: true });
      return true;
    },

    closed(init, saved) {
      // Like an empty new folder name in the Explorer: closing an unsaved "New API" removes it.
      if (init.isNew && !saved && pendingApis.delete(init.key)) provider.refresh();
    },
  });

  async function openSettings(key: string, focus?: SettingsInit["focus"], preset?: AuthKind): Promise<void> {
    if (pendingApis.has(key)) {
      const clip = ((await vscode.env.clipboard.readText()) || "").trim();
      return settings.show({
        key,
        isNew: true,
        name: "",
        url: isHttpUrl(clip) && !specEntries().some((e) => e.url === clip) ? clip : "",
        auth: preset ?? "none",
        username: "",
        hasToken: false,
        hasPassword: false,
        focus,
      });
    }
    const entry = specEntries().find((e) => e.url === key);
    if (!entry) return;
    const saved = await credsOf(hostOf(entry.url));
    settings.show({
      key,
      isNew: false,
      name: entry.name,
      url: entry.url,
      auth: preset ?? (saved.token ? "bearer" : saved.basic ? "basic" : "none"),
      username: saved.basic?.username ?? "",
      hasToken: !!saved.token,
      hasPassword: !!saved.basic?.password,
      focus,
    });
  }

  // Add API (like a new folder in the Explorer): a "New API" node appears and its settings tab opens.
  async function addApi(): Promise<void> {
    const key = `new:${++pendingSeq}`;
    pendingApis.set(key, pendingSeq);
    provider.refresh();
    await openSettings(key);
    const node = (await provider.getChildren()).find((n) => n._pendingKey === key);
    if (node) await treeView.reveal(node, { select: true, focus: false });
  }

  // API Settings / Remove / Copy URL target: the clicked node, or (keyboard) the selected one.
  const apiNodeOf = (arg?: Node): Node | undefined => {
    const n = arg ?? (treeView.selection[0] as Node | undefined);
    return (n?._apiRoot && n._specUrl) || n?._pendingKey ? n : undefined;
  };

  async function apiSettings(arg?: Node, focus?: SettingsInit["focus"], preset?: AuthKind): Promise<void> {
    const n = apiNodeOf(arg);
    if (n) return openSettings(n._pendingKey ?? n._specUrl!, focus, preset);
    // From the palette without a selection: pick the API.
    const url = await pickSpecUrl();
    if (url) await openSettings(url, focus, preset);
  }

  async function removeApi(arg?: Node): Promise<void> {
    const n = apiNodeOf(arg);
    if (!n) return;
    if (n._pendingKey) {
      settings.close(n._pendingKey);
      pendingApis.delete(n._pendingKey);
      return provider.refresh();
    }
    settings.close(n._specUrl!);
    await updateEntry(n._specUrl!, () => null);
    resetCaches();
  }

  // Palette "Clear token / username & password": the selected API's host, or pick the host(s).
  async function clearCredential(kind: "token" | "basic", arg?: Node): Promise<void> {
    const saved = Object.keys(
      kind === "token" ? await readTokenMap(context) : await readBasicAuthMap(context)
    );
    let hosts = arg?._specUrl ? [hostOf(arg._specUrl)] : saved;
    if (hosts.length === 0) {
      vscode.window.showInformationMessage(
        kind === "token"
          ? vscode.l10n.t("No saved token to clear.")
          : vscode.l10n.t("No saved username & password to clear.")
      );
      return;
    }
    if (hosts.length > 1) {
      const picked = await vscode.window.showQuickPick(
        hosts.map((h) => ({ label: h })),
        { canPickMany: true, placeHolder: vscode.l10n.t("Select the host(s) to clear") }
      );
      if (!picked?.length) return;
      hosts = picked.map((p) => p.label);
    }
    for (const h of hosts) {
      const c = await credsOf(h);
      await writeCreds(h, kind === "token" ? { basic: c.basic } : { token: c.token });
    }
    resetCaches();
    vscode.window.showInformationMessage(vscode.l10n.t("Cleared for: {0}", hosts.join(", ")));
  }

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand("swaggerViewer.addApi", () => addApi()),
    vscode.commands.registerCommand("swaggerViewer.apiSettings", (arg?: Node) => apiSettings(arg)),
    vscode.commands.registerCommand("swaggerViewer.renameApi", (arg?: Node) => apiSettings(arg, "name")),
    vscode.commands.registerCommand("swaggerViewer.removeApi", (arg?: Node) => removeApi(arg)),
    vscode.commands.registerCommand("swaggerViewer.copyApiUrl", async (arg?: Node) => {
      const n = apiNodeOf(arg);
      if (n?._specUrl) await vscode.env.clipboard.writeText(n._specUrl);
    }),
    vscode.commands.registerCommand("swaggerViewer.openApiSettings", (key: string) => openSettings(key)),

    vscode.commands.registerCommand("swaggerViewer.openOperation", (node: Node) =>
      openOperation(context, node)
    ),
    vscode.commands.registerCommand("swaggerViewer.copyTs", (node: Node) => copyForNode(context, node, "ts")),
    vscode.commands.registerCommand("swaggerViewer.copyFetch", (node: Node) =>
      copyForNode(context, node, "fetch")
    ),
    vscode.commands.registerCommand("swaggerViewer.copyAxios", (node: Node) =>
      copyForNode(context, node, "axios")
    ),
    vscode.commands.registerCommand("swaggerViewer.copyCurl", (node: Node) =>
      copyForNode(context, node, "curl")
    ),

    vscode.commands.registerCommand("swaggerViewer.refresh", async () => {
      resetCaches();
      vscode.window.showInformationMessage(vscode.l10n.t("Swagger refreshed."));
    }),

    vscode.commands.registerCommand("swaggerViewer.openInBrowser", async (arg?: Node) => {
      const url = await pickSpecUrl(arg);
      if (url) vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand("swaggerViewer.openSwaggerUI", async (arg?: Node) => {
      const url = await pickSpecUrl(arg);
      if (!url) return;
      try {
        const res = await ensureSpec(context, url);
        const httpOptions = await buildHttpOptions(context, res.specUrl);
        openSwaggerUi(context, res.spec, res.spec.info?.title || "Swagger UI", res.specUrl, httpOptions);
      } catch (e: any) {
        vscode.window.showErrorMessage(
          vscode.l10n.t("Failed to open Swagger UI: {0}", e?.message ?? String(e))
        );
      }
    }),

    vscode.commands.registerCommand("swaggerViewer.search", async () => {
      const configs = getSpecConfigs();
      if (!configs.length) {
        vscode.window.showWarningMessage(vscode.l10n.t("No Swagger spec registered."));
        return;
      }
      const multi = configs.length > 1;
      const items: (vscode.QuickPickItem & { node: Node })[] = [];
      for (const c of configs) {
        // A spec with springdoc groups is searched group by group.
        let sources: { url: string; group?: string }[] = [{ url: c.url }];
        try {
          const res = await ensureSpec(context, c.url);
          if (res.groups && res.groups.length > 1)
            sources = res.groups.map((g) => ({ url: g.url, group: g.name }));
        } catch {
          continue; /* if one spec fails, keep searching the rest */
        }
        for (const src of sources) {
          try {
            const res = await ensureSpec(context, src.url);
            for (const e of listEndpoints(res.spec)) {
              const node: Node = new vscode.TreeItem(`${e.method} ${e.path}`);
              node._specUrl = src.url;
              node._kind = "endpoint";
              node._path = e.path;
              node._method = e.method;
              node._tag = e.tag;
              node._operationId = e.operationId;
              const where = [multi || src.group ? c.name : "", src.group || "", e.tag].filter(Boolean);
              items.push({
                label: `${e.method} ${e.path}`,
                description: e.summary,
                detail: where.join(" · "),
                node,
              });
            }
          } catch {
            /* if one group fails, keep searching the rest */
          }
        }
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t("Search endpoints (method/path/summary)"),
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (pick) await openOperation(context, pick.node);
    }),

    // Credentials live in the API settings tab; these open it on the auth section.
    vscode.commands.registerCommand("swaggerViewer.setToken", (arg?: Node) =>
      apiSettings(arg, "auth", "bearer")
    ),
    vscode.commands.registerCommand("swaggerViewer.setBasicAuth", (arg?: Node) =>
      apiSettings(arg, "auth", "basic")
    ),
    vscode.commands.registerCommand("swaggerViewer.clearToken", (arg?: Node) =>
      clearCredential("token", arg)
    ),
    vscode.commands.registerCommand("swaggerViewer.clearBasicAuth", (arg?: Node) =>
      clearCredential("basic", arg)
    ),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("swaggerViewer")) resetCaches();
    })
  );

  // Fire-and-forget: may wait on the user's choice, must not block activation.
  migrateLegacyToken(context, resetCaches, async (hosts) => {
    const picked = await vscode.window.showQuickPick(
      hosts.map((h) => ({ label: h })),
      { canPickMany: true, placeHolder: vscode.l10n.t("Select the host(s) to apply the saved token to") }
    );
    if (
      picked?.length &&
      (await assignLegacyToken(
        context,
        picked.map((p) => p.label)
      ))
    )
      resetCaches();
  }).catch((e) => console.error("[openapi-explorer] legacy token migration failed", e));
}

export function deactivate(): void {
  /* no-op */
}
