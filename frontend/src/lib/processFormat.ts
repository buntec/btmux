import type { ProcessInfo } from '../protocol/process-messages';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

export function formatCpu(value: number): string {
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)}%`;
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

export function formatMemoryPercent(memory: number, total: number): string {
  return total > 0 ? `${((memory / total) * 100).toFixed(2)}%` : '—';
}

/** sysinfo reports a zero start time when it can't read the process. */
export function hasStartTime(process: ProcessInfo): boolean {
  return process.start_time > 0;
}

export function formatElapsed(process: ProcessInfo): string {
  return hasStartTime(process) ? formatDuration(process.run_time) : '—';
}

export function formatStarted(process: ProcessInfo): string {
  return hasStartTime(process) ? new Date(process.start_time * 1000).toLocaleString() : '—';
}
