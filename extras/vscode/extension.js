// btmux integration for the VS Code surface (prefix + E). btmux sends
// newline-delimited JSON over a private Unix socket (BTMUX_VSCODE_SOCKET):
//   {"type":"user","settings":{…}|null,"keybindings":[…]|null}
//   {"type":"style","palette":{base00…base0F[, base10…base17]},
//    "font":{"family":"Geist Mono","size":18,"weight":200}}
//   {"type":"open","path":"/abs/file","line":12}
const net = require('net');
const vscode = require('vscode');

const Global = vscode.ConfigurationTarget.Global;
const THEME_KEYS = [
  'workbench.colorTheme',
  'workbench.colorCustomizations',
  'editor.tokenColorCustomizations',
  'editor.semanticTokenColorCustomizations',
];
const FONT_KEYS = [
  'editor.fontFamily',
  'editor.fontSize',
  'editor.fontWeight',
  'terminal.integrated.fontFamily',
  'terminal.integrated.fontSize',
  'terminal.integrated.fontWeight',
];
// The btmux terminal's fallbacks (TerminalPane's FONT_FALLBACK).
const FONT_FALLBACK = "'Symbols Nerd Font Mono', Menlo, Monaco, monospace";
// Code reads better a bit smaller than terminal text: btmux's default 18 becomes 14.
const EDITOR_FONT_SCALE = 0.8;

// Settings btmux wrote, as JSON by key, so turning a sync off clears only those.
const WRITTEN = 'btmux.written';
// In the browser, user settings and keybindings live in VS Code's IndexedDB.
const USER_DIR = vscode.Uri.from({ scheme: 'vscode-userdata', path: '/User' });

let style = null;
let state = null;

function activate(context) {
  state = context.globalState;
  const path = process.env.BTMUX_VSCODE_SOCKET;
  if (!path) return;
  let socket = null;
  let retry = null;
  let disposed = false;
  const connect = () => {
    socket = net.createConnection(path);
    socket.setEncoding('utf8');
    let buffer = '';
    // In order, so the user settings are in place before the style applies.
    let queue = Promise.resolve();
    socket.on('data', (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const message = JSON.parse(line);
        queue = queue.then(() => handle(message)).catch((e) => console.error('btmux:', e));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (!disposed) retry = setTimeout(connect, 2000);
    });
  };
  connect();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('btmux.syncTheme') || e.affectsConfiguration('btmux.syncFont')) {
        applyStyle().catch((err) => console.error('btmux:', err));
      }
    }),
    {
      dispose() {
        disposed = true;
        clearTimeout(retry);
        socket?.destroy();
      },
    },
  );
}

async function handle(message) {
  if (message.type === 'user') {
    await applyUser(message);
  } else if (message.type === 'style') {
    style = message;
    await applyStyle();
  } else if (message.type === 'open') {
    const options = { preview: false };
    if (message.line) {
      const position = new vscode.Position(Math.max(message.line - 1, 0), 0);
      options.selection = new vscode.Range(position, position);
    }
    await vscode.window.showTextDocument(vscode.Uri.file(message.path), options);
  }
}

/**
 * Replace the user settings and keybindings with the shared ones, keeping the
 * theme and font settings btmux wrote so they don't flicker.
 */
async function applyUser({ settings, keybindings }) {
  if (settings) {
    const config = vscode.workspace.getConfiguration();
    const merged = { ...settings };
    for (const key of Object.keys(state.get(WRITTEN, {}))) {
      const value = config.inspect(key)?.globalValue;
      if (value !== undefined) merged[key] = value;
    }
    await writeUserFile('settings.json', merged);
  }
  if (keybindings) await writeUserFile('keybindings.json', keybindings);
}

/** Write a user file as JSON, unless it already has that content. */
async function writeUserFile(name, value) {
  const uri = vscode.Uri.joinPath(USER_DIR, name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const current = await vscode.workspace.fs.readFile(uri).then(
    (data) => new TextDecoder().decode(data),
    () => null,
  );
  if (current !== text) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

/**
 * Write the theme and font settings, skipping unchanged ones. When a sync is
 * off, clear the settings btmux wrote, unless they have been changed since.
 */
async function applyStyle() {
  if (!style) return;
  const config = vscode.workspace.getConfiguration();
  const groups = [
    [THEME_KEYS, config.get('btmux.syncTheme', true) && themeSettings(style.palette)],
    [FONT_KEYS, config.get('btmux.syncFont', true) && fontSettings(style.font)],
  ];
  const written = state.get(WRITTEN, {});
  for (const [keys, values] of groups) {
    for (const key of keys) {
      const current = JSON.stringify(config.inspect(key)?.globalValue);
      if (values) {
        const value = JSON.stringify(values[key]);
        if (current !== value) await config.update(key, values[key], Global);
        written[key] = value;
      } else if (key in written) {
        if (current === written[key]) await config.update(key, undefined, Global);
        delete written[key];
      }
    }
  }
  await state.update(WRITTEN, written);
}

function fontSettings({ family, size, weight }) {
  const fontFamily = `${family}, ${FONT_FALLBACK}`;
  return {
    'editor.fontFamily': fontFamily,
    'editor.fontSize': Math.max(6, Math.round(size * EDITOR_FONT_SCALE)),
    'editor.fontWeight': String(weight),
    'terminal.integrated.fontFamily': fontFamily,
    'terminal.integrated.fontSize': size,
    'terminal.integrated.fontWeight': String(weight),
  };
}

const hex = (color) => (color.startsWith('#') ? color : `#${color}`).toLowerCase();

function luminance(color) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex(color).slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Settings for a base16/24 palette, following the base16 styling guidelines. */
function themeSettings(p) {
  const c = {};
  for (const [key, value] of Object.entries(p)) if (value) c[key.toLowerCase()] = hex(value);
  const light = luminance(c.base00) > 0.5;
  const alpha = (color, a) => color + a;

  const ansi = {
    Black: c.base00,
    Red: c.base08,
    Green: c.base0b,
    Yellow: c.base0a,
    Blue: c.base0d,
    Magenta: c.base0e,
    Cyan: c.base0c,
    White: c.base05,
    BrightBlack: c.base03,
    BrightRed: c.base12 ?? c.base08,
    BrightGreen: c.base14 ?? c.base0b,
    BrightYellow: c.base13 ?? c.base0a,
    BrightBlue: c.base16 ?? c.base0d,
    BrightMagenta: c.base17 ?? c.base0e,
    BrightCyan: c.base15 ?? c.base0c,
    BrightWhite: c.base07,
  };
  const colors = {
    foreground: c.base05,
    descriptionForeground: c.base04,
    errorForeground: c.base08,
    focusBorder: alpha(c.base0d, '80'),
    'widget.border': c.base02,
    'selection.background': c.base02,
    'textLink.foreground': c.base0d,
    'textLink.activeForeground': c.base0d,
    'button.background': c.base0d,
    'button.foreground': c.base00,
    'button.hoverBackground': c.base0d,
    'button.secondaryBackground': c.base02,
    'button.secondaryForeground': c.base05,
    'badge.background': c.base0d,
    'badge.foreground': c.base00,
    'input.background': c.base00,
    'input.foreground': c.base05,
    'input.border': c.base02,
    'input.placeholderForeground': c.base03,
    'inputOption.activeBorder': c.base0d,
    'dropdown.background': c.base01,
    'dropdown.foreground': c.base05,
    'dropdown.border': c.base02,
    'checkbox.background': c.base01,
    'checkbox.border': c.base02,
    'scrollbarSlider.background': alpha(c.base03, '55'),
    'scrollbarSlider.hoverBackground': alpha(c.base03, '88'),
    'scrollbarSlider.activeBackground': alpha(c.base04, '88'),
    'progressBar.background': c.base0d,
    'list.activeSelectionBackground': c.base02,
    'list.activeSelectionForeground': c.base06,
    'list.inactiveSelectionBackground': c.base02,
    'list.hoverBackground': alpha(c.base02, '80'),
    'list.focusOutline': alpha(c.base0d, '80'),
    'list.highlightForeground': c.base0d,
    'list.errorForeground': c.base08,
    'list.warningForeground': c.base0a,
    'activityBar.background': c.base01,
    'activityBar.foreground': c.base05,
    'activityBar.inactiveForeground': c.base03,
    'activityBar.border': c.base01,
    'activityBar.activeBorder': c.base0d,
    'activityBarBadge.background': c.base0d,
    'activityBarBadge.foreground': c.base00,
    'sideBar.background': c.base01,
    'sideBar.foreground': c.base05,
    'sideBar.border': c.base01,
    'sideBarTitle.foreground': c.base05,
    'sideBarSectionHeader.background': c.base01,
    'sideBarSectionHeader.foreground': c.base05,
    'sideBarSectionHeader.border': c.base02,
    'titleBar.activeBackground': c.base01,
    'titleBar.activeForeground': c.base05,
    'titleBar.inactiveBackground': c.base01,
    'titleBar.inactiveForeground': c.base03,
    'titleBar.border': c.base01,
    'commandCenter.background': c.base00,
    'commandCenter.foreground': c.base04,
    'commandCenter.border': c.base02,
    'menu.background': c.base01,
    'menu.foreground': c.base05,
    'menu.selectionBackground': c.base02,
    'menu.separatorBackground': c.base02,
    'editorGroup.border': c.base02,
    'editorGroupHeader.tabsBackground': c.base01,
    'editorGroupHeader.noTabsBackground': c.base01,
    'tab.activeBackground': c.base00,
    'tab.activeForeground': c.base05,
    'tab.inactiveBackground': c.base01,
    'tab.inactiveForeground': c.base04,
    'tab.border': c.base01,
    'tab.activeBorderTop': c.base0d,
    'breadcrumb.background': c.base00,
    'breadcrumb.foreground': c.base04,
    'breadcrumb.focusForeground': c.base05,
    'editor.background': c.base00,
    'editor.foreground': c.base05,
    'editorCursor.foreground': c.base05,
    'editorLineNumber.foreground': c.base03,
    'editorLineNumber.activeForeground': c.base04,
    'editor.lineHighlightBackground': c.base01,
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': c.base02,
    'editor.inactiveSelectionBackground': alpha(c.base02, '80'),
    'editor.wordHighlightBackground': alpha(c.base02, '80'),
    'editor.findMatchBackground': alpha(c.base0a, '66'),
    'editor.findMatchHighlightBackground': alpha(c.base0a, '33'),
    'editorBracketMatch.background': c.base02,
    'editorBracketMatch.border': '#00000000',
    'editorWhitespace.foreground': c.base02,
    'editorIndentGuide.background1': c.base01,
    'editorIndentGuide.activeBackground1': c.base02,
    'editorRuler.foreground': c.base01,
    'editorError.foreground': c.base08,
    'editorWarning.foreground': c.base0a,
    'editorInfo.foreground': c.base0d,
    'editorHint.foreground': c.base0c,
    'editorGutter.addedBackground': c.base0b,
    'editorGutter.modifiedBackground': c.base0e,
    'editorGutter.deletedBackground': c.base08,
    'editorWidget.background': c.base01,
    'editorWidget.border': c.base02,
    'editorSuggestWidget.background': c.base01,
    'editorSuggestWidget.border': c.base02,
    'editorSuggestWidget.selectedBackground': c.base02,
    'editorSuggestWidget.highlightForeground': c.base0d,
    'editorHoverWidget.background': c.base01,
    'editorHoverWidget.border': c.base02,
    'quickInput.background': c.base01,
    'quickInputList.focusBackground': c.base02,
    'peekView.border': c.base0d,
    'peekViewEditor.background': c.base01,
    'peekViewResult.background': c.base01,
    'peekViewTitle.background': c.base01,
    'minimap.background': c.base00,
    'panel.background': c.base00,
    'panel.border': c.base02,
    'panelTitle.activeForeground': c.base05,
    'panelTitle.inactiveForeground': c.base03,
    'panelTitle.activeBorder': c.base0d,
    'statusBar.background': c.base01,
    'statusBar.foreground': c.base04,
    'statusBar.border': c.base01,
    'statusBar.noFolderBackground': c.base01,
    'statusBar.debuggingBackground': c.base09,
    'statusBar.debuggingForeground': c.base00,
    'statusBarItem.remoteBackground': c.base0d,
    'statusBarItem.remoteForeground': c.base00,
    'notifications.background': c.base01,
    'notifications.foreground': c.base05,
    'notificationCenterHeader.background': c.base01,
    'gitDecoration.addedResourceForeground': c.base0b,
    'gitDecoration.modifiedResourceForeground': c.base0a,
    'gitDecoration.deletedResourceForeground': c.base08,
    'gitDecoration.untrackedResourceForeground': c.base0b,
    'gitDecoration.ignoredResourceForeground': c.base03,
    'gitDecoration.conflictingResourceForeground': c.base0e,
    'terminal.background': c.base00,
    'terminal.foreground': c.base05,
    'terminalCursor.foreground': c.base05,
    'terminal.selectionBackground': c.base02,
    'welcomePage.background': c.base00,
    'walkThrough.embeddedEditorBackground': c.base01,
  };
  for (const [name, color] of Object.entries(ansi)) colors[`terminal.ansi${name}`] = color;

  const rule = (scope, foreground, fontStyle) => ({ scope, settings: { foreground, ...(fontStyle && { fontStyle }) } });
  const textMateRules = [
    rule(['comment', 'punctuation.definition.comment'], c.base03, 'italic'),
    rule(['string', 'punctuation.definition.string'], c.base0b),
    rule(['string.regexp', 'constant.character.escape'], c.base0c),
    rule(['constant.numeric', 'constant.language', 'constant.other', 'support.constant'], c.base09),
    rule(['keyword', 'storage', 'storage.type', 'storage.modifier'], c.base0e),
    rule(['keyword.operator', 'punctuation', 'meta.brace'], c.base05),
    rule(['variable', 'variable.other', 'entity.name.tag', 'support.variable'], c.base08),
    rule(['variable.parameter', 'variable.other.property', 'variable.other.object.property'], c.base05),
    rule(['entity.name.function', 'support.function', 'meta.function-call'], c.base0d),
    rule(
      ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'support.type', 'support.class'],
      c.base0a,
    ),
    rule(['entity.other.inherited-class'], c.base0b),
    rule(['entity.other.attribute-name'], c.base09),
    rule(['meta.embedded', 'source.groovy.embedded', 'punctuation.section.embedded'], c.base0f),
    rule(['markup.heading', 'entity.name.section'], c.base0d, 'bold'),
    rule(['markup.bold'], c.base0a, 'bold'),
    rule(['markup.italic'], c.base0e, 'italic'),
    rule(['markup.inline.raw', 'markup.fenced_code'], c.base0b),
    rule(['markup.underline.link', 'string.other.link'], c.base0c),
    rule(['markup.quote'], c.base0c),
    rule(['markup.inserted'], c.base0b),
    rule(['markup.deleted'], c.base08),
    rule(['markup.changed'], c.base0e),
    rule(['invalid'], c.base08),
    rule(['invalid.deprecated'], c.base0f),
  ];
  const semanticRules = {
    comment: { foreground: c.base03, italic: true },
    string: c.base0b,
    number: c.base09,
    regexp: c.base0c,
    keyword: c.base0e,
    operator: c.base05,
    namespace: c.base0a,
    type: c.base0a,
    class: c.base0a,
    struct: c.base0a,
    enum: c.base0a,
    interface: c.base0a,
    typeParameter: c.base0a,
    enumMember: c.base09,
    function: c.base0d,
    method: c.base0d,
    macro: c.base0c,
    variable: c.base08,
    'variable.readonly': c.base09,
    parameter: c.base05,
    property: c.base05,
    label: c.base0f,
  };

  return {
    'workbench.colorTheme': light ? 'Default Light Modern' : 'Default Dark Modern',
    'workbench.colorCustomizations': colors,
    'editor.tokenColorCustomizations': { textMateRules },
    'editor.semanticTokenColorCustomizations': { enabled: true, rules: semanticRules },
  };
}

module.exports = { activate, deactivate() {} };
