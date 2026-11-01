type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

/** Runs a desktop app command, or returns null outside the Tauri shell. */
export function invokeDesktop(command: string, args?: Record<string, unknown>): Promise<unknown> | null {
  return (window as TauriWindow).__TAURI_INTERNALS__?.invoke(command, args) ?? null;
}

let version: Promise<string | null> | null = null;

/** The desktop app's version, or null outside the Tauri shell. */
export function getDesktopVersion(): Promise<string | null> {
  version ??= (async () => {
    const tauri = (window as TauriWindow).__TAURI_INTERNALS__;
    if (!tauri) return null;
    try {
      const result = await tauri.invoke('desktop_info');
      return typeof result === 'string' ? result : null;
    } catch {
      return null;
    }
  })();
  return version;
}

export function desktopVersionMismatch(desktop: string | null, server: string | undefined): boolean {
  return desktop !== null && server !== undefined && desktop !== server;
}

/** Whether btmux runs in the desktop app. */
export function isDesktopApp(): boolean {
  return !!(window as TauriWindow).__TAURI_INTERNALS__;
}

/** Returns the desktop app to its server picker. */
export function switchDesktopServer(): void {
  (window as TauriWindow).__TAURI_INTERNALS__?.invoke('switch_server').catch(() => {});
}
