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
  },
  workspace: {
    getConfiguration: cfgGet,
    onDidChangeConfiguration: () => ({ dispose() {} }),
    workspaceFolders: undefined,
  },
  env: { clipboard: { writeText: async () => {} }, openExternal: () => {} },
};
