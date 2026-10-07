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
}

export interface ProcessSnapshot {
  type: 'snapshot';
  processes: ProcessInfo[];
  ports: PortInfo[] | null;
  ports_error: string | null;
  cpu_count: number;
  mem_used: number;
  mem_total: number;
  load_average: [number, number, number];
}

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

export type ProcessServerMessage = ProcessSnapshot | ProcessKillResult | ProcessErrorMessage;

export type ProcessSignal = 'term' | 'kill';

export interface ProcessKillRequest {
  type: 'kill';
  pid: number;
  start_time: number;
  signal: ProcessSignal;
}

export interface ProcessPortsRequest {
  type: 'set_ports';
  enabled: boolean;
}
