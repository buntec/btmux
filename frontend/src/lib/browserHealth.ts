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

function clipboard(): HealthCheck {
  const purpose = 'The paste shortcut and copying from the browser surface.';
  if (!navigator.clipboard?.readText) {
    return check('Clipboard', purpose, 'warning', 'Blocked', 'The browser blocks clipboard access on this page.');
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
  return [secure, clipboard(), notifications(osNotifications), await webGpu()];
}
