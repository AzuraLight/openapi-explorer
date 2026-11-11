// Minimal fake of the vscode API for tests — records what the extension does.
// Injected via NODE_PATH=test/fake-vscode so `import "vscode"` resolves here (see package.json scripts).
const path = require("node:path");

// answers: queue consumed in call order by showInputBox / showQuickPick / show*Message (when action items are given).
//   showQuickPick answer: a label, an array of labels (canPickMany), or undefined (cancel).
const fresh = () => ({
  panels: [],
  htmlSets: [],
  posts: [],
  treeProvider: null,
  commands: {},
  config: {},
  msgs: [],
  answers: [],
  prompts: [],
  // Settings per scope: `config` = workspace, `globalConfig` = user. get() merges workspace over user.
  globalConfig: {},
  clipboard: "",
  selection: [], // TreeView.selection
  revealed: [], // elements passed to TreeView.reveal
  progress: [], // withProgress titles
  context: {}, // setContext keys
  executed: [], // executeCommand calls (id, ...args)
  viewProviders: {}, // registerWebviewViewProvider
  views: {}, // resolved webview views by id
  viewPosts: [], // messages the extension posted to webview views
});
const rec = (global.__rec = fresh());

// Reset recorded state between tests. Open panels are disposed first so module-level singletons
// (e.g. the Swagger UI panel) start fresh. Keeps the same object so holders of `rec` see the change.
function __reset() {
  for (const p of rec.panels) p.dispose();
  Object.assign(rec, fresh());
}

class EventEmitter {
  constructor() {
    this.l = [];
    this.event = (f) => this.l.push(f);
  }
  fire(v) {
    this.l.forEach((f) => f(v));
  }
}
class TreeItem {
  constructor(label, state) {
    this.label = label;
    this.collapsibleState = state;
  }
}
class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
const Uri = {
  joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p) }),
  file: (p) => ({ fsPath: p }),
  parse: (s) => ({ s }),
};

// A message with action items consumes one answer (the chosen item); without items it resolves undefined.
function message(prefix, m, items) {
  rec.msgs.push(prefix + m);
  const actions = items.filter((i) => typeof i === "string" || (i && i.title));
  if (!actions.length) return Promise.resolve(undefined);
  return Promise.resolve(rec.answers.shift());
}

// A resolved WebviewView (sidebar HTML view). `send` delivers a message from the view to the extension.
async function resolveView(id) {
  if (rec.views[id]) return rec.views[id];
  const provider = rec.viewProviders[id];
  if (!provider) return undefined;
  let onMsg = null;
  const disposeListeners = [];
  const view = {
    visible: true,
    webview: {
      options: {},
      cspSource: "file:",
      asWebviewUri: (u) => ({ toString: () => "file://" + u.fsPath }),
      html: "",
      onDidReceiveMessage: (f) => {
        onMsg = f;
        return { dispose() {} };
      },
      postMessage: (m) => {
        rec.viewPosts.push({ view: id, ...m });
        return Promise.resolve(true);
      },
    },
    show: () => {},
    onDidDispose: (f) => (disposeListeners.push(f), { dispose() {} }),
    onDidChangeVisibility: () => ({ dispose() {} }),
    send: async (m) => onMsg && (await onMsg(m)),
  };
  rec.views[id] = view;
  await provider.resolveWebviewView(view, {}, { isCancellationRequested: false });
  return view;
}

function createWebviewPanel(_viewType, title) {
  let onMsg = null;
  const disposeListeners = [];
  const webview = {
    cspSource: "file:",
    asWebviewUri: (u) => ({ toString: () => "file://" + u.fsPath }),
    set html(v) {
      rec.htmlSets.push(v);
      this._html = v;
    },
    get html() {
      return this._html;
    },
    onDidReceiveMessage: (f) => (onMsg = f),
    postMessage: (m) => {
      rec.posts.push(m);
      return Promise.resolve(true);
    },
  };
  const p = {
    title,
    webview,
    reveal() {},
    onDidDispose: (f) => disposeListeners.push(f),
    dispose: () => disposeListeners.splice(0).forEach((f) => f()),
    // Test helper: deliver a message from the webview to the extension.
    send: (m) => onMsg(m),
  };
  rec.panels.push(p);
  return p;
}

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const cfgGet = (section) => ({
  get: (k, d) => {
    const key = `${section}.${k}`;
    const v = rec.config[key] !== undefined ? rec.config[key] : rec.globalConfig[key];
    return v === undefined ? d : v;
  },
  inspect: (k) => {
    const key = `${section}.${k}`;
    return { key, globalValue: rec.globalConfig[key], workspaceValue: rec.config[key] };
  },
  // target: Global → user settings, otherwise workspace. undefined value removes the setting.
  update: async (k, v, target) => {
    const store = target === ConfigurationTarget.Global ? rec.globalConfig : rec.config;
    const key = `${section}.${k}`;
    if (v === undefined) delete store[key];
    else store[key] = v;
  },
});

module.exports = {
  __rec: rec,
  __reset,
  __resolveView: resolveView,
  EventEmitter,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  Uri,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ViewColumn: { Beside: -2 },
  ConfigurationTarget,
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  l10n: { t: (s, ...a) => s.replace(/\{(\d)\}/g, (_, i) => a[i]) },
  window: {
    createWebviewPanel,
    createTreeView: (_id, o) => {
      rec.treeProvider = o.treeDataProvider;
      return {
        get selection() {
          return rec.selection;
        },
        reveal: async (el, opts) => void rec.revealed.push({ el, opts }),
        dispose() {},
      };
    },
    registerWebviewViewProvider: (id, provider) => {
      rec.viewProviders[id] = provider;
      return { dispose() {} };
    },
    withProgress: async (options, task) => {
      rec.progress.push(options.title);
      return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() {} });
    },
    showInformationMessage: (m, ...items) => message("", m, items),
    showErrorMessage: (m, ...items) => message("ERR ", m, items),
    showWarningMessage: (m, ...items) => message("WARN ", m, items),
    showInputBox: async (options) => {
      rec.prompts.push({ kind: "input", options });
      return rec.answers.shift();
    },
    showQuickPick: async (items, options) => {
      rec.prompts.push({ kind: "pick", items, options });
      const a = rec.answers.shift();
      if (a === undefined) return undefined;
      const byLabel = (l) => items.find((i) => i.label === l);
      return Array.isArray(a) ? a.map(byLabel) : byLabel(a);
    },
  },
  commands: {
    registerCommand: (id, f) => {
      rec.commands[id] = f;
      return { dispose() {} };
    },
    // setContext is recorded; "<viewId>.focus" resolves that webview view like VS Code does.
    executeCommand: async (id, ...args) => {
      rec.executed.push([id, ...args]);
      if (id === "setContext") rec.context[args[0]] = args[1];
      const m = /^(.+)\.focus$/.exec(id);
      if (m) await resolveView(m[1]);
      if (rec.commands[id]) return rec.commands[id](...args);
    },
  },
  workspace: {
    getConfiguration: cfgGet,
    onDidChangeConfiguration: () => ({ dispose() {} }),
    workspaceFolders: undefined,
  },
  env: {
    clipboard: {
      readText: async () => rec.clipboard,
      writeText: async (t) => void (rec.clipboard = t),
    },
    openExternal: () => {},
  },
};
