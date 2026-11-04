export type { PortInfo } from '../generated/protocol';
import type { PortInfo } from '../generated/protocol';

export interface ProcessInfo {
  pid: number;
  parent_pid: number | null;
  name: string;
  command: string;
  cpu: number;
  memory: number;
  virtual_memory: number;
  status: string;
  user: string | null;
  start_time: number;
  run_time: number;
  /** Bytes per second. */
  disk_read: number;
  disk_write: number;
  pane_id: string | null;
}

export interface ProcessSnapshot {
  type: 'snapshot';
  processes: ProcessInfo[];
  ports: PortInfo[] | null;
  ports_error: string | null;
  /** Panes whose programs can't be attributed to them. */
  uncounted_panes: string[];
  cpu_count: number;
  mem_used: number;
  mem_total: number;
  load_average: [number, number, number];
}

/** Sockets are sampled every few snapshots; the others omit them. */
export type ProcessSnapshotMessage = Omit<ProcessSnapshot, 'ports' | 'ports_error'> &
  Partial<Pick<ProcessSnapshot, 'ports' | 'ports_error'>>;

export interface ProcessKillResult {
  type: 'kill_result';
  pid: number;
  success: boolean;
  message: string;
}

export interface ProcessErrorMessage {
  type: 'error';
  message: string;
}

export type ProcessServerMessage = ProcessSnapshotMessage | ProcessKillResult | ProcessErrorMessage;

export type ProcessSignal = 'term' | 'kill';

export interface ProcessKillRequest {
  type: 'kill';
  pid: number;
  start_time: number;
  signal: ProcessSignal;
}
