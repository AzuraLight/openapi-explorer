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

const SECRET_TOKEN_KEY = "swaggerViewer.authToken";

interface SpecConfig {
  name: string;
  url: string;
}

// 로드된 스펙 캐시 (입력 URL 기준)
const specCache = new Map<string, ResolveResult>();

// 작업 영역이 열려 있으면 Workspace, 아니면 Global(사용자) 설정에 저장한다.
// (폴더 없이 연 창에서 Workspace 설정 쓰기는 실패하기 때문)
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

// 설정된 스펙 목록 (specs 우선, 없으면 단일 url)
function getSpecConfigs(): SpecConfig[] {
  const cfg = vscode.workspace.getConfiguration("swaggerViewer");
  const specs = cfg.get<SpecConfig[]>("specs") || [];
  const valid = specs.filter((s) => s && s.url);
  if (valid.length) return valid;
  const url = cfg.get<string>("url") || "";
  return url ? [{ name: hostOf(url), url }] : [];
}

// 설정 헤더 + SecretStorage 토큰 → 요청 헤더
async function buildHeaders(context: vscode.ExtensionContext): Promise<Record<string, string>> {
  const cfg = vscode.workspace.getConfiguration("swaggerViewer");
  const headers: Record<string, string> = { ...(cfg.get<Record<string, string>>("headers") || {}) };
  const token = await context.secrets.get(SECRET_TOKEN_KEY);
  if (token && !headers["Authorization"]) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function buildHttpOptions(context: vscode.ExtensionContext): Promise<HttpOptions> {
  const cfg = vscode.workspace.getConfiguration("swaggerViewer");
  const vscodeProxy = vscode.workspace.getConfiguration("http").get<string>("proxy") || "";
  return {
    headers: await buildHeaders(context),
    strictSSL: cfg.get<boolean>("strictSSL", true),
    caCertPath: cfg.get<string>("caCertPath") || undefined,
    proxy: cfg.get<string>("proxy") || vscodeProxy || undefined,
  };
}

async function ensureSpec(context: vscode.ExtensionContext, url: string, force = false): Promise<ResolveResult> {
  if (!force && specCache.has(url)) return specCache.get(url)!;
  const fetcher = createHttpFetcher(await buildHttpOptions(context));
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
      if (configs.length > 1) {
        return configs.map((c) => {
          const n: Node = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.Collapsed);
          n.description = hostOf(c.url);
          n.iconPath = new vscode.ThemeIcon("server");
          n.contextValue = "spec";
          n._specNode = true;
          n._specUrl = c.url;
          return n;
        });
      }
      return this.specChildren(configs[0].url);
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

  // 한 스펙의 태그/모델 노드 (태그는 기본 접힘)
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

// ---------------- Swagger UI 점프 ----------------
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
  const httpOptions = await buildHttpOptions(context);
  openSwaggerUi(context, res.spec, res.spec.info?.title || "Swagger UI", res.specUrl, httpOptions, focus);
}

// ---------------- 코드 생성 (트리 우클릭) ----------------
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

// 대상 스펙 선택 (트리 노드 인자 / 단일 / QuickPick)
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
        const httpOptions = await buildHttpOptions(context);
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
        try {
          const res = await ensureSpec(context, c.url);
          for (const e of listEndpoints(res.spec)) {
            const node: Node = new vscode.TreeItem(`${e.method} ${e.path}`);
            node._specUrl = c.url;
            node._kind = "endpoint";
            node._path = e.path;
            node._method = e.method;
            node._tag = e.tag;
            node._operationId = e.operationId;
            items.push({
              label: `${e.method} ${e.path}`,
              description: e.summary,
              detail: multi ? `${c.name} · ${e.tag}` : e.tag,
              node,
            });
          }
        } catch {
          /* 한 스펙 실패해도 나머지 검색 */
        }
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t("Search endpoints (method/path/summary)"),
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (pick) await openOperation(context, pick.node);
    }),

    vscode.commands.registerCommand("swaggerViewer.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Authorization token (Bearer). Stored securely in SecretStorage."),
        password: true,
        placeHolder: "eyJhbGci...",
      });
      if (!token) return;
      await context.secrets.store(SECRET_TOKEN_KEY, token);
      specCache.clear();
      clearCache();
      provider.refresh();
      vscode.window.showInformationMessage(vscode.l10n.t("Authorization token saved."));
    }),

    vscode.commands.registerCommand("swaggerViewer.clearToken", async () => {
      await context.secrets.delete(SECRET_TOKEN_KEY);
      specCache.clear();
      clearCache();
      provider.refresh();
      vscode.window.showInformationMessage(vscode.l10n.t("Authorization token cleared."));
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("swaggerViewer")) {
        specCache.clear();
        clearCache();
        provider.refresh();
      }
    })
  );
}

export function deactivate(): void {
  /* no-op */
}
