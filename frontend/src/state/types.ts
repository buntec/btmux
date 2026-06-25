export interface PaneState {
  id: string;
  title: string | null;
  cwd: string | null;
}

export interface LayoutNode {
  type: 'leaf' | 'v_split' | 'h_split';
  id?: string;
  pane_id?: string;
  ratio?: number;
  left?: LayoutNode;
  right?: LayoutNode;
  top?: LayoutNode;
  bottom?: LayoutNode;
}

export interface WindowState {
  id: string;
  name: string;
  panes: PaneState[];
  active_pane: number;
  layout: LayoutNode;
  zoomed_pane: string | null;
}

export interface SessionState {
  id: string;
  name: string;
  windows: WindowState[];
  active_window: number;
}

export interface SessionSummary {
  id: string;
  name: string;
}

export interface Bind {
  key: string;
  action: string;
}

/**
 * A runnable entry in the command palette (prefix + `:`), mirrored from the
 * backend's `config::Command`. `id` is sent back in a `run_command` message;
 * `confirm` is a non-null prompt string for destructive commands (the palette
 * shows a y/n confirm with that text before running) or null otherwise.
 */
export interface Command {
  id: string;
  label: string;
  description: string;
  confirm: string | null;
}

/**
 * ghostty-web terminal options, mirrored from the backend's `TerminalOptions`
 * (itself a subset of ghostty-web's `ITerminalOptions`). A `null` field means
 * "unset" — TerminalPane omits it so ghostty-web's own default applies.
 */
export interface TerminalOptions {
  renderer: 'canvas' | 'webgl' | null;
  cursorBlink: boolean | null;
  cursorStyle: 'block' | 'underline' | 'bar' | null;
  scrollback: number | null;
  fontSize: number | null;
  fontFamily: string | null;
  fontWeight: number | null;
  allowTransparency: boolean | null;
  convertEol: boolean | null;
  disableStdin: boolean | null;
  smoothScrollDuration: number | null;
  scrollSensitivity: number | null;
}

/** Resolved color theme, mirroring ghostty-web's `ITheme` (subset we populate). */
export interface Theme {
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export type SessionSort = 'created' | 'mru' | 'alphabetical';

export interface FontEntry {
  family: string;
  weight_min: number;
  weight_max: number;
}

export interface ClientConfig {
  prefix: string;
  binds: Bind[];
  commands: Command[];
  terminal: TerminalOptions;
  theme: Theme | null;
  vi_mode: boolean;
  animations: boolean;
  wallpaper: string | null;
  wallpaper_opacity: number | null;
  wallpaper_blur: number | null;
  wallpaper_saturate: number | null;
  session_sort: SessionSort;
  /** How many recently-viewed windows the window-grid (prefix + w) shows. */
  window_grid_count: number;
  version: string;
  /** Available color scheme names from ~/.config/btmux/colors/. */
  color_schemes: string[];
  /** Currently active color scheme name, or null. */
  active_color_scheme: string | null;
  /** Bundled font families with weight ranges. */
  fonts: FontEntry[];
}

/**
 * In-browser command prompt / picker, tmux-style.
 * - `prompt`: a text input whose value, on submit, becomes the payload of `action`.
 * - `picker`: a selectable list of sessions (plus a synthetic "new session" entry).
 */
/** A flat row in the choose-tree overlay. */
export type TreeNode =
  | { kind: 'session'; id: string; name: string }
  | {
      kind: 'window';
      id: string;
      sessionId: string;
      sessionName: string;
      name: string;
      index: number;
      active: boolean;
    }
  | {
      kind: 'pane';
      id: string;
      sessionId: string;
      sessionName: string;
      windowId: string;
      index: number;
      active: boolean;
      title: string | null;
      cwd: string | null;
    };

export interface PickerItem {
  id: string;
  label: string;
  active?: boolean;
}

export type Overlay =
  | { mode: 'prompt'; title: string; value: string; action: PromptAction }
  | { mode: 'keys'; title: string; binds: Bind[] }
  | { mode: 'command'; title: string; commands: Command[] }
  | {
      mode: 'confirm';
      title: string;
      onConfirm: () => void;
      returnTo?: Overlay;
    }
  | {
      mode: 'picker';
      title: string;
      items: PickerItem[];
      onSelect: (id: string) => void;
    };

export type PromptAction = 'rename-window' | 'rename-session' | 'new-session';

export interface LayoutRect {
  paneId: string;
  top: number;
  left: number;
  width: number;
  height: number;
}
