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

// List of configured specs (specs first, otherwise the single url)
function getSpecConfigs(): SpecConfig[] {
  const cfg = vscode.workspace.getConfiguration("swaggerViewer");
  const specs = cfg.get<SpecConfig[]>("specs") || [];
  const valid = specs.filter((s) => s && s.url);
  if (valid.length) return valid;
  const url = cfg.get<string>("url") || "";
  return url ? [{ name: hostOf(url), url }] : [];
}

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
  !!v && typeof (v as BasicCredential).username === "string" && typeof (v as BasicCredential).password === "string";
const isToken = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const readBasicAuthMap = (c: vscode.ExtensionContext) => readHostMap(c, SECRET_BASIC_KEY, isBasic);
const writeBasicAuthMap = (c: vscode.ExtensionContext, m: Record<string, BasicCredential>) =>
  writeHostMap(c, SECRET_BASIC_KEY, m);
const readTokenMap = (c: vscode.ExtensionContext) => readHostMap(c, SECRET_TOKEN_KEY, isToken);
const writeTokenMap = (c: vscode.ExtensionContext, m: Record<string, string>) => writeHostMap(c, SECRET_TOKEN_KEY, m);

function registeredHosts(): string[] {
  return [...new Set(getSpecConfigs().map((c) => hostOf(c.url)))];
}

// Hosts a credential command applies to: the clicked spec node's host, the only candidate,
// or a multi-select pick. undefined = cancelled / nothing to do.
async function pickHosts(arg: Node | undefined, candidates: string[], placeHolder: string): Promise<string[] | undefined> {
  if (arg?._specUrl) return [hostOf(arg._specUrl)];
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates;
  const picked = await vscode.window.showQuickPick(
    candidates.map((h) => ({ label: h })),
    { canPickMany: true, placeHolder }
  );
  if (!picked || picked.length === 0) return undefined;
  return picked.map((p) => p.label);
}

// ≤1.1.0 kept one global token and sent it to every host. Never spread it silently:
// with exactly one registered host it moves there; otherwise the user chooses the host(s),
// and until then it is kept but not sent anywhere.
async function migrateLegacyToken(context: vscode.ExtensionContext, onChange: () => void): Promise<void> {
  const legacy = await context.secrets.get(LEGACY_TOKEN_KEY);
  if (!legacy) return;
  const hosts = registeredHosts();
  if (hosts.length === 0) return;
  let targets: string[] | undefined;
  if (hosts.length === 1) {
    targets = hosts;
  } else {
    const choose = vscode.l10n.t("Choose hosts");
    const answer = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Auth tokens are now saved per host. Choose which host(s) your saved token belongs to — until then it is not sent."
      ),
      choose
    );
    if (answer !== choose) return;
    targets = await pickHosts(undefined, hosts, vscode.l10n.t("Select the host(s) to apply the saved token to"));
    if (!targets) return;
  }
  const map = await readTokenMap(context);
  for (const h of targets) if (!map[h]) map[h] = legacy;
  await writeTokenMap(context, map);
  await context.secrets.delete(LEGACY_TOKEN_KEY);
  onChange();
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

async function ensureSpec(context: vscode.ExtensionContext, url: string, force = false): Promise<ResolveResult> {
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
};

class SwaggerTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(item: Node): vscode.TreeItem {
    return item;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    const configs = getSpecConfigs();
    if (!configs.length) return [];

    if (!element) {
      // Always show each spec (gateway) as a top-level node so its address is visible
      // and credentials can be managed from its right-click menu.
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
        return n;
      });
    }

    if (element._specNode && element._specUrl) return this.specChildren(element._specUrl);

    const url = element._specUrl;
    if (!url) return [];
    let res: ResolveResult;
    try {
      res = await ensureSpec(this.context, url);
    } catch (e: any) {
      console.error("[openapi-explorer] failed to load spec", url, e);
      const it: Node = new vscode.TreeItem(vscode.l10n.t("Failed to load"), vscode.TreeItemCollapsibleState.None);
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
      const it: Node = new vscode.TreeItem(vscode.l10n.t("Failed to load"), vscode.TreeItemCollapsibleState.None);
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
        ? { kind: "operation", tag: node._tag, operationId: node._operationId, method: node._method, path: node._path }
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
  context.subscriptions.push(
    vscode.window.createTreeView("swaggerExplorer", { treeDataProvider: provider }),

    vscode.commands.registerCommand("swaggerViewer.openOperation", (node: Node) => openOperation(context, node)),
    vscode.commands.registerCommand("swaggerViewer.copyTs", (node: Node) => copyForNode(context, node, "ts")),
    vscode.commands.registerCommand("swaggerViewer.copyFetch", (node: Node) => copyForNode(context, node, "fetch")),
    vscode.commands.registerCommand("swaggerViewer.copyAxios", (node: Node) => copyForNode(context, node, "axios")),
    vscode.commands.registerCommand("swaggerViewer.copyCurl", (node: Node) => copyForNode(context, node, "curl")),

    vscode.commands.registerCommand("swaggerViewer.refresh", async () => {
      clearCache();
      specCache.clear();
      provider.refresh();
      vscode.window.showInformationMessage(vscode.l10n.t("Swagger refreshed."));
    }),

    vscode.commands.registerCommand("swaggerViewer.setUrl", async () => {
      const cfg = vscode.workspace.getConfiguration("swaggerViewer");
      const url = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Default Swagger URL (a UI page address works too)"),
        value: cfg.get<string>("url") || "",
        placeHolder: "https://api.example.com/api-docs",
      });
      if (url === undefined) return;
      await cfg.update("url", url, configTarget());
      specCache.clear();
      clearCache();
      provider.refresh();
    }),

    vscode.commands.registerCommand("swaggerViewer.addSpec", async () => {
      const name = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Spec display name"),
        placeHolder: vscode.l10n.t("e.g. Payment Gateway"),
      });
      if (!name) return;
      const url = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Swagger URL (a UI page address works too)"),
        placeHolder: "https://pay.example.com/api-docs",
      });
      if (!url) return;
      const cfg = vscode.workspace.getConfiguration("swaggerViewer");
      const specs = [...(cfg.get<SpecConfig[]>("specs") || [])];
      specs.push({ name, url });
      await cfg.update("specs", specs, configTarget());
      provider.refresh();
      vscode.window.showInformationMessage(vscode.l10n.t("Spec added: {0}", name));
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
        vscode.window.showErrorMessage(vscode.l10n.t("Failed to open Swagger UI: {0}", e?.message ?? String(e)));
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
          if (res.groups && res.groups.length > 1) sources = res.groups.map((g) => ({ url: g.url, group: g.name }));
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
              items.push({ label: `${e.method} ${e.path}`, description: e.summary, detail: where.join(" · "), node });
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

    // Bearer token, stored per host. From a spec node → that host; from the palette → pick host(s).
    vscode.commands.registerCommand("swaggerViewer.setToken", async (arg?: Node) => {
      const hosts = registeredHosts();
      if (!arg?._specUrl && hosts.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t("No Swagger spec registered."));
        return;
      }
      const targets = await pickHosts(arg, hosts, vscode.l10n.t("Select the host(s) to apply this token to"));
      if (!targets) return;
      const token = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Authorization token (Bearer) for {0}. Stored securely in SecretStorage.", targets.join(", ")),
        password: true,
        ignoreFocusOut: true,
        placeHolder: "eyJhbGci...",
      });
      if (!token) return;
      const map = await readTokenMap(context);
      for (const host of targets) map[host] = token;
      await writeTokenMap(context, map);
      specCache.clear();
      clearCache();
      provider.refresh();
      vscode.window.showInformationMessage(vscode.l10n.t("Authorization token saved for: {0}", targets.join(", ")));
    }),

    vscode.commands.registerCommand("swaggerViewer.clearToken", async (arg?: Node) => {
      const map = await readTokenMap(context);
      const targets = await pickHosts(
        arg,
        Object.keys(map),
        vscode.l10n.t("Select the host(s) to clear the token for")
      );
      if (!targets) {
        if (!arg?._specUrl && Object.keys(map).length === 0)
          vscode.window.showInformationMessage(vscode.l10n.t("No saved token to clear."));
        return;
      }
      for (const host of targets) delete map[host];
      await writeTokenMap(context, map);
      specCache.clear();
      clearCache();
      provider.refresh();
      vscode.window.showInformationMessage(vscode.l10n.t("Authorization token cleared for: {0}", targets.join(", ")));
    }),

    // Username/password for cases where accessing the URL itself requires a login (HTTP Basic auth, 401).
    // Credentials are stored per host; the same pair can be applied to multiple hosts at once.
    vscode.commands.registerCommand("swaggerViewer.setBasicAuth", async (arg?: Node) => {
      const hosts = registeredHosts();
      if (!arg?._specUrl && hosts.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t("No Swagger spec registered."));
        return;
      }
      const targets = await pickHosts(
        arg,
        hosts,
        vscode.l10n.t("Select the host(s) to apply these credentials to")
      );
      if (!targets) return;
      const username = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Username for HTTP Basic auth (used when the spec URL requires a login)."),
        ignoreFocusOut: true,
      });
      if (!username) return;
      const password = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Password for HTTP Basic auth."),
        password: true,
        ignoreFocusOut: true,
      });
      if (password === undefined) return;
      const map = await readBasicAuthMap(context);
      for (const host of targets) map[host] = { username, password };
      await writeBasicAuthMap(context, map);
      specCache.clear();
      clearCache();
      provider.refresh();
      vscode.window.showInformationMessage(
        vscode.l10n.t("Username & password saved for: {0}", targets.join(", "))
      );
    }),

    vscode.commands.registerCommand("swaggerViewer.clearBasicAuth", async (arg?: Node) => {
      const map = await readBasicAuthMap(context);
      const hosts = Object.keys(map);
      if (hosts.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t("No saved username & password to clear."));
        return;
      }
      let targets: string[];
      if (arg?._specUrl) {
        // Invoked from a spec node's context menu → clear that host directly.
        targets = [hostOf(arg._specUrl)];
      } else if (hosts.length === 1) {
        targets = hosts;
      } else {
        const picked = await vscode.window.showQuickPick(
          hosts.map((h) => ({ label: h })),
          {
            canPickMany: true,
            placeHolder: vscode.l10n.t("Select the host(s) to clear credentials for"),
          }
        );
        if (!picked || picked.length === 0) return;
        targets = picked.map((p) => p.label);
      }
      for (const host of targets) delete map[host];
      await writeBasicAuthMap(context, map);
      specCache.clear();
      clearCache();
      provider.refresh();
      vscode.window.showInformationMessage(
        vscode.l10n.t("Username & password cleared for: {0}", targets.join(", "))
      );
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("swaggerViewer")) {
        specCache.clear();
        clearCache();
        provider.refresh();
      }
    })
  );

  // Fire-and-forget: may wait on the user's choice, must not block activation.
  migrateLegacyToken(context, () => {
    specCache.clear();
    clearCache();
    provider.refresh();
  }).catch((e) => console.error("[openapi-explorer] legacy token migration failed", e));
}

export function deactivate(): void {
  /* no-op */
}
