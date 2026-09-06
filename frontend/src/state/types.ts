// Shared wire types are generated from Rust by `just protocol`.
import type { Bind, Command } from '../generated/protocol';
export type {
  PaneSnapshot as PaneState,
  Layout as LayoutNode,
  WindowSnapshot as WindowState,
  SessionSnapshot as SessionState,
  SessionSummary,
  Bind,
  Command,
  TerminalOptions,
  Theme,
  SessionSort,
  WindowSort,
  FontEntry,
  ClientConfig,
} from '../generated/protocol';

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
      /** Backend index (position in `session.windows`) — the `switch_window` index. */
      index: number;
      /** Position in the sorted display order — the number shown and the hotkey. */
      displayIndex: number;
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
