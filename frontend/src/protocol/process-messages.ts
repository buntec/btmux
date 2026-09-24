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
  run_time: number;
}

export interface ProcessSnapshot {
  type: 'snapshot';
  processes: ProcessInfo[];
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
