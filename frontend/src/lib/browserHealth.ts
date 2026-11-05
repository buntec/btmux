// What this browser supports, for the Health tab.
import type { HealthCheck, HealthStatus } from '../generated/protocol';

function check(
  name: string,
  purpose: string,
  status: HealthStatus,
  value: string,
  note: string | null = null,
): HealthCheck {
  return { name, status, value, path: null, purpose, note };
}

async function webGpu(): Promise<HealthCheck> {
  const purpose = 'Shader wallpapers.';
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const adapter = await gpu?.requestAdapter().catch(() => null);
  if (adapter) return check('WebGPU', purpose, 'ok', 'Available');
  return check('WebGPU', purpose, 'missing', 'Not available', 'Wallpapers show without shaders.');
}

/** Whether this site may read the clipboard, if the browser can say; asking reads nothing. */
async function clipboardReadPermission(nav: Pick<Navigator, 'permissions'>): Promise<PermissionState | null> {
  try {
    const status = await nav.permissions?.query({ name: 'clipboard-read' as PermissionName });
    return status?.state ?? null;
  } catch {
    // Firefox and Safari reject this permission name.
    return null;
  }
}

export async function clipboard(nav: Pick<Navigator, 'clipboard' | 'permissions'> = navigator): Promise<HealthCheck> {
  const purpose = 'The paste shortcut and copying from the browser surface.';
  if (!nav.clipboard?.readText) {
    return check('Clipboard', purpose, 'warning', 'Blocked', 'The browser blocks clipboard access on this page.');
  }
  if ((await clipboardReadPermission(nav)) === 'denied') {
    return check('Clipboard', purpose, 'warning', 'Blocked', "Allow clipboard access in the browser's site settings.");
  }
  return check('Clipboard', purpose, 'ok', 'Available');
}

function notifications(enabled: boolean): HealthCheck {
  const name = 'OS notifications';
  const purpose = 'Agent alerts while btmux is hidden or unfocused.';
  if (!enabled) return check(name, purpose, 'missing', 'Off', 'Turned off in Settings.');
  // Some webviews (e.g. WKWebView) lack the Notification API.
  if (typeof Notification === 'undefined') return check(name, purpose, 'missing', 'Unsupported');
  switch (Notification.permission) {
    case 'granted':
      return check(name, purpose, 'ok', 'Allowed');
    case 'denied':
      return check(name, purpose, 'warning', 'Blocked', "Allow them in the browser's site settings.");
    default:
      return check(name, purpose, 'missing', 'Not enabled', 'btmux offers to enable them with the first alert.');
  }
}

export async function browserHealth(osNotifications: boolean): Promise<HealthCheck[]> {
  const secure = window.isSecureContext
    ? check('Secure context', 'What browsers require for the features below.', 'ok', 'Yes')
    : check(
        'Secure context',
        'What browsers require for the features below.',
        'warning',
        'No',
        'Clipboard, notifications, and WebGPU need HTTPS or localhost.',
      );
  const [clipboardCheck, webGpuCheck] = await Promise.all([clipboard(), webGpu()]);
  return [secure, clipboardCheck, notifications(osNotifications), webGpuCheck];
}
