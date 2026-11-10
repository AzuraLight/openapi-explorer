// Minimal fake of the vscode API for tests — records what the extension does.
// Injected via NODE_PATH=test/fake-vscode so `import "vscode"` resolves here (see package.json scripts).
const path = require("node:path");
const fresh = () => ({
  panels: [],
  htmlSets: [],
  posts: [],
  treeProvider: null,
  commands: {},
  config: {},
  msgs: [],
});
const rec = (global.__rec = fresh());
// Reset recorded state between tests (keeps the same object so modules holding `rec` see the change).
function __reset() {
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
function createWebviewPanel(viewType, title) {
  let onMsg = null;
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
  const p = { title, webview, reveal() {}, onDidDispose() {}, send: (m) => onMsg(m) };
  rec.panels.push(p);
  return p;
}
const cfgGet = (section) => ({
  get: (k, d) => {
    const v = rec.config[`${section}.${k}`];
    return v === undefined ? d : v;
  },
  update: async (k, v) => {
    rec.config[`${section}.${k}`] = v;
  },
});
module.exports = {
  __rec: rec,
  __reset,
  EventEmitter,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  Uri,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ViewColumn: { Beside: -2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  l10n: { t: (s, ...a) => s.replace(/\{(\d)\}/g, (_, i) => a[i]) },
  window: {
    createWebviewPanel,
    createTreeView: (_id, o) => {
      rec.treeProvider = o.treeDataProvider;
      return { dispose() {} };
    },
    showInformationMessage: (m) => rec.msgs.push(m),
    showErrorMessage: (m) => rec.msgs.push("ERR " + m),
    showWarningMessage: (m) => rec.msgs.push("WARN " + m),
  },
  commands: {
    registerCommand: (id, f) => {
      rec.commands[id] = f;
      return { dispose() {} };
    },
  },
  workspace: {
    getConfiguration: cfgGet,
    onDidChangeConfiguration: () => ({ dispose() {} }),
    workspaceFolders: undefined,
  },
  env: { clipboard: { writeText: async () => {} }, openExternal: () => {} },
};
