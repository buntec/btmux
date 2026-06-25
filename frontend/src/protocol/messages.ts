import type { SessionState, SessionSummary, ClientConfig } from '../state/types';

export type ClientMessage =
  | { type: 'split'; session_id: string; pane_id: string; direction: 'h' | 'v' }
  | { type: 'kill_pane'; session_id: string; pane_id: string }
  | {
      type: 'navigate';
      session_id: string;
      direction: 'up' | 'down' | 'left' | 'right';
    }
  | { type: 'create_window'; session_id: string }
  | { type: 'switch_window'; session_id: string; index: number }
  | { type: 'rename_window'; session_id: string; name: string }
  | { type: 'close_window'; session_id: string }
  | { type: 'kill_window'; window_id: string }
  | { type: 'zoom_pane'; session_id: string; pane_id: string }
  | { type: 'last_window'; session_id: string }
  | { type: 'last_pane'; session_id: string }
  | { type: 'select_pane'; session_id: string; pane_id: string }
  | { type: 'cycle_pane'; session_id: string; delta: number }
  | { type: 'swap_pane'; session_id: string; delta: number }
  | { type: 'next_layout'; session_id: string }
  | { type: 'create_session'; name: string | null }
  | { type: 'rename_session'; session_id: string; name: string }
  | { type: 'kill_session'; id: string }
  | { type: 'resize_split'; session_id: string; split_id: string; ratio: number }
  | { type: 'capture_pane'; pane_id: string; content: string }
  | { type: 'run_command'; command: string; session_id: string }
  | { type: 'update_config'; update: { colors?: string; font_family?: string; font_weight?: number } };

export interface ServerStateMessage {
  type: 'state';
  sessions: SessionSummary[];
  all_sessions: SessionState[];
}

export interface ServerConfigMessage {
  type: 'config';
  config: ClientConfig;
}

export interface ServerToastMessage {
  type: 'toast';
  message: string;
  level: 'info' | 'error';
}

export type NotificationLevel = 'info' | 'attention' | 'success' | 'error';

export interface ServerPaneNotificationMessage {
  type: 'pane_notification';
  pane_id: string;
  event: string;
  level: NotificationLevel;
  title: string | null;
  body: string | null;
}

export interface ServerPaneNotificationClearMessage {
  type: 'pane_notification_clear';
  pane_id: string;
}

export type ServerMessage =
  | ServerStateMessage
  | ServerConfigMessage
  | ServerToastMessage
  | ServerPaneNotificationMessage
  | ServerPaneNotificationClearMessage;
