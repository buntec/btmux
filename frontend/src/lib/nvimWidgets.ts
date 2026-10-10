// State for Neovim's externalized cmdline (`ext_cmdline`), popupmenu (`ext_popupmenu`)
// and message area (`ext_messages`), plus btmux plugin notifications.

export interface Chunk {
  attr: number;
  text: string;
}

export interface Cmdline {
  content: Chunk[];
  /** Cursor position as a character (not byte) index into the content. */
  pos: number;
  firstc: string;
  prompt: string;
  indent: number;
  special: { c: string; shift: boolean } | null;
}

export interface PopupItem {
  word: string;
  kind: string;
  menu: string;
  /** Documentation, often filled in later via `btmux_complete_info`. */
  info: string;
}

export interface Popupmenu {
  items: PopupItem[];
  selected: number;
  row: number;
  col: number;
  /** -1 when anchored to the external cmdline. */
  grid: number;
}

/** LSP signature help, as sent by the btmux Neovim plugin (`extras/nvim`). */
export interface SignatureHelp {
  label: string;
  /** Active parameter: a substring of `label`, or [start, end) UTF-16 offsets into it. */
  param: string | [number, number] | null;
  param_doc: string;
  doc: string;
  /** 1-based index of the shown signature among `count` overloads. */
  index: number;
  count: number;
  /** Screen cell of the cursor. */
  row: number;
  col: number;
}

export type MessageLevel = 'error' | 'warning' | 'info';

/** A short message, shown as a toast until `expires` (ms since epoch). */
export interface Message {
  key: number;
  id: string | number | null;
  level: MessageLevel;
  content: Chunk[];
  expires: number;
}

/** A progress-message, as forwarded by the btmux plugin (`btmux_progress`). */
export interface Progress {
  id: string;
  text: string;
  title: string;
  source: string;
  status: 'running' | 'success' | 'failed' | 'cancel';
  percent: number | null;
  /** Shortly after finishing, or once stale. */
  expires: number;
}

/** Multi-line output (`:ls`, `:!cmd`, `:messages`, prompts), shown until dismissed. */
export interface OutputPanel {
  title: string;
  lines: { level: MessageLevel; content: Chunk[] }[];
}

/** Completion kind icons from the btmux plugin (mini.icons), keyed by kind name. */
export type KindIcons = Record<string, { icon: string; color: string | null }>;

export interface WidgetState {
  cmdline: Cmdline | null;
  block: Chunk[][];
  popupmenu: Popupmenu | null;
  signature: SignatureHelp | null;
  messages: Message[];
  progress: Progress[];
  panel: OutputPanel | null;
  showmode: Chunk[];
  showcmd: Chunk[];
  kindIcons: KindIcons;
}

const ERROR_KINDS = new Set(['emsg', 'echoerr', 'lua_error', 'rpc_error', 'shell_err']);
/** Kinds whose output belongs in the panel even when it's a single line. */
const PANEL_KINDS = new Set([
  'list_cmd',
  'shell_cmd',
  'shell_out',
  'shell_err',
  'shell_ret',
  'verbose',
  'wildlist',
  'confirm',
]);
/** Kinds btmux shows elsewhere (progress cards, cmdline, popupmenu). */
const SKIPPED_KINDS = new Set(['progress', 'search_cmd', 'completion']);
const PANEL_TITLES: Record<string, string> = { confirm: 'Confirm', history: 'Messages' };
const MESSAGE_MS = { info: 4000, warning: 6000, error: 8000 };
const SEARCH_COUNT_MS = 2000;
const PROGRESS_DONE_MS = 1500;
/** Running progress with no update for this long is dropped as stale. */
const PROGRESS_STALE_MS = 60_000;
const MAX_MESSAGES = 5;

const kindLevel = (kind: string): MessageLevel =>
  ERROR_KINDS.has(kind) ? 'error' : kind === 'wmsg' ? 'warning' : 'info';

const encoder = new TextEncoder();

/** Character index of a UTF-8 byte offset into `text`. */
export function charIndex(text: string, bytes: number): number {
  let used = 0;
  let index = 0;
  for (const ch of text) {
    if (used >= bytes) break;
    used += encoder.encode(ch).length;
    index += ch.length;
  }
  return index;
}

const chunks = (raw: unknown): Chunk[] =>
  (raw as [number, string][]).map(([attr, text]) => ({ attr: typeof attr === 'number' ? attr : 0, text }));

export class NvimWidgets {
  private levels = new Map<number, Cmdline>();
  private block: Chunk[][] = [];
  private popupmenu: Popupmenu | null = null;
  private signature: SignatureHelp | null = null;
  private messages: Message[] = [];
  private nextKey = 0;
  private progress = new Map<string, Progress>();
  private panel: OutputPanel | null = null;
  // The next panel message starts a new panel rather than appending (set after each command).
  private panelFresh = true;
  private showmode: Chunk[] = [];
  private showcmd: Chunk[] = [];
  private kindIcons: KindIcons = {};
  // Highlight ids of UI groups (`hl_group_set`), e.g. to spot `vim.notify` warnings.
  private groups = new Map<string, number>();
  changed = false;

  get cmdlineActive(): boolean {
    return this.levels.size > 0;
  }

  /** Apply one UI event; returns whether it was a widget event. */
  apply(name: string, args: unknown[]): boolean {
    switch (name) {
      case 'cmdline_show': {
        const [content, pos, firstc, prompt, indent, level] = args as [unknown, number, string, string, number, number];
        const parsed = chunks(content);
        const text = parsed.map((c) => c.text).join('');
        this.levels.set(level, { content: parsed, pos: charIndex(text, pos), firstc, prompt, indent, special: null });
        break;
      }
      case 'cmdline_pos': {
        const [pos, level] = args as number[];
        const line = this.levels.get(level);
        if (line) {
          const text = line.content.map((c) => c.text).join('');
          this.levels.set(level, { ...line, pos: charIndex(text, pos) });
        }
        break;
      }
      case 'cmdline_special_char': {
        const [c, shift, level] = args as [string, boolean, number];
        const line = this.levels.get(level);
        if (line) this.levels.set(level, { ...line, special: { c, shift } });
        break;
      }
      case 'cmdline_hide': {
        const [level] = args as number[];
        this.levels.delete(level);
        this.panelFresh = true;
        break;
      }
      case 'msg_show': {
        const [kind, content, replaceLast, , append, id] = args as [
          string,
          unknown,
          boolean,
          boolean,
          boolean,
          string | number,
        ];
        this.showMessage(kind, chunks(content), replaceLast, append, id ?? null);
        break;
      }
      case 'hl_group_set': {
        const [name, id] = args as [string, number];
        this.groups.set(name, id);
        return true;
      }
      case 'msg_clear':
        this.messages = [];
        this.panel = null;
        break;
      case 'msg_showmode':
        this.showmode = chunks(args[0]);
        break;
      case 'msg_showcmd':
        this.showcmd = chunks(args[0]);
        break;
      case 'msg_history_show': {
        const [entries] = args as [[string, unknown][]];
        this.panel = {
          title: PANEL_TITLES.history,
          lines: entries.map(([kind, content]) => {
            const parsed = chunks(content);
            return { level: this.levelOf(kind, parsed), content: parsed };
          }),
        };
        this.panelFresh = false;
        break;
      }
      case 'cmdline_block_show':
        this.block = (args[0] as unknown[]).map(chunks);
        break;
      case 'cmdline_block_append':
        this.block = [...this.block, chunks(args[0])];
        break;
      case 'cmdline_block_hide':
        this.block = [];
        break;
      case 'popupmenu_show': {
        const [items, selected, row, col, grid] = args as [string[][], number, number, number, number];
        this.popupmenu = {
          items: items.map(([word, kind, menu, info]) => ({ word, kind, menu, info })),
          selected,
          row,
          col,
          grid,
        };
        break;
      }
      case 'popupmenu_select':
        if (this.popupmenu) this.popupmenu = { ...this.popupmenu, selected: args[0] as number };
        break;
      case 'popupmenu_hide':
        this.popupmenu = null;
        break;
      default:
        return false;
    }
    this.changed = true;
    return true;
  }

  /** Level from the kind, or from the highlight for plain echoes (`vim.notify` warnings and errors). */
  private levelOf(kind: string, content: Chunk[]): MessageLevel {
    const level = kindLevel(kind);
    if (level !== 'info') return level;
    const attr = content[0]?.attr;
    if (attr && attr === this.groups.get('ErrorMsg')) return 'error';
    if (attr && attr === this.groups.get('WarningMsg')) return 'warning';
    return 'info';
  }

  private showMessage(
    kind: string,
    content: Chunk[],
    replaceLast: boolean,
    append: boolean,
    id: string | number | null,
  ) {
    if (SKIPPED_KINDS.has(kind)) return;
    if (kind === 'empty') {
      this.messages = [];
      return;
    }
    const level = this.levelOf(kind, content);
    const multiline = content.some((c) => c.text.includes('\n'));
    if (multiline || PANEL_KINDS.has(kind)) {
      const lines = content.length ? [{ level, content }] : [];
      if (this.panel && !this.panelFresh) this.panel = { ...this.panel, lines: [...this.panel.lines, ...lines] };
      else this.panel = { title: PANEL_TITLES[kind] ?? 'Output', lines };
      this.panelFresh = false;
      return;
    }
    this.toast(id, level, content, replaceLast, append, kind === 'search_count' ? SEARCH_COUNT_MS : MESSAGE_MS[level]);
  }

  private toast(
    id: string | number | null,
    level: MessageLevel,
    content: Chunk[],
    replaceLast: boolean,
    append: boolean,
    ms: number,
  ) {
    const expires = Date.now() + ms;
    const last = this.messages[this.messages.length - 1];
    if (append && last) {
      this.messages = [...this.messages.slice(0, -1), { ...last, content: [...last.content, ...content], expires }];
      return;
    }
    const message: Message = { key: this.nextKey++, id, level, content, expires };
    const same = id === null ? -1 : this.messages.findIndex((m) => m.id === id);
    if (same >= 0) this.messages = this.messages.map((m, i) => (i === same ? message : m));
    else if (replaceLast && last) this.messages = [...this.messages.slice(0, -1), message];
    else this.messages = [...this.messages, message].slice(-MAX_MESSAGES);
  }

  /** A progress-message update from the btmux plugin. */
  setProgress(update: Omit<Progress, 'expires'>) {
    this.changed = true;
    // Neovim's own file I/O reports finish instantly, so show only the result ("… written")
    // as a message. 0.12 never finishes the one for reads, which `msg_show` covers anyway.
    if (update.source === 'nvim') {
      if (update.status === 'success') {
        this.toast(update.id, 'info', [{ attr: 0, text: update.text }], false, false, MESSAGE_MS.info);
      }
      return;
    }
    const done = update.status !== 'running';
    const expires = Date.now() + (done ? PROGRESS_DONE_MS : PROGRESS_STALE_MS);
    this.progress.set(update.id, { ...update, expires });
  }

  /** Drop expired toasts and finished progress. */
  prune(now: number) {
    const messages = this.messages.filter((m) => m.expires > now);
    if (messages.length !== this.messages.length) {
      this.messages = messages;
      this.changed = true;
    }
    for (const [id, p] of this.progress) {
      if (p.expires !== null && p.expires <= now) {
        this.progress.delete(id);
        this.changed = true;
      }
    }
  }

  get hasPanel(): boolean {
    return this.panel !== null;
  }

  dismissPanel() {
    this.panel = null;
    this.changed = true;
  }

  /** Documentation resolved after the menu opened (e.g. LSP `completionItem/resolve`). */
  setInfo(index: number, info: string) {
    const menu = this.popupmenu;
    if (!menu || index < 0 || index >= menu.items.length) return;
    const items = menu.items.slice();
    items[index] = { ...items[index], info };
    this.popupmenu = { ...menu, items };
    this.changed = true;
  }

  setKindIcons(icons: KindIcons) {
    this.kindIcons = icons;
    this.changed = true;
  }

  setSignature(signature: SignatureHelp | null) {
    this.signature = signature;
    this.changed = true;
  }

  snapshot(): WidgetState {
    this.changed = false;
    const top = Math.max(0, ...this.levels.keys());
    return {
      cmdline: this.levels.get(top) ?? null,
      block: this.block,
      popupmenu: this.popupmenu,
      signature: this.signature,
      messages: this.messages,
      progress: [...this.progress.values()],
      panel: this.panel,
      showmode: this.showmode,
      showcmd: this.showcmd,
      kindIcons: this.kindIcons,
    };
  }
}
