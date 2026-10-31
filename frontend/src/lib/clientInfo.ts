// What the browser can tell about the machine it runs on, for the System tab.
import { isDesktopApp } from './desktopApp';
import { isTouchPrimary } from './touch';

export interface ClientInfo {
  browser: string;
  os: string;
  display: string;
  gpu: string | null;
  threads: number | null;
  locale: string;
  timeZone: string;
  input: string;
}

interface UADataValues {
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  fullVersionList?: { brand: string; version: string }[];
}

interface NavigatorUAData {
  platform: string;
  getHighEntropyValues(hints: string[]): Promise<UADataValues>;
}

export async function collectClientInfo(desktopVersion: string | null): Promise<ClientInfo> {
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  const hints = await uaData
    ?.getHighEntropyValues(['platformVersion', 'architecture', 'fullVersionList'])
    .catch(() => undefined);
  const ua = navigator.userAgent;
  const [hz, gpu] = await Promise.all([refreshRate(), gpuName()]);
  return {
    browser: desktopVersion ? `btmux desktop ${desktopVersion} (${engine(ua)})` : browserName(ua, hints),
    os: osName(ua, hints ?? (uaData ? { platform: uaData.platform } : undefined)),
    display: display(hz),
    gpu,
    threads: navigator.hardwareConcurrency || null,
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    input: isTouchPrimary() ? 'Touch' : 'Mouse and keyboard',
  };
}

function engine(ua: string): string {
  if (/Edg\//.test(ua)) return 'WebView2';
  if (/AppleWebKit/.test(ua) && !/Chrome\//.test(ua)) return 'WebKit';
  return 'Chromium';
}

function browserName(ua: string, hints?: UADataValues): string {
  const brand = hints?.fullVersionList?.find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand));
  if (brand) return `${brand.brand} ${brand.version}`;
  if (isDesktopApp()) return `btmux desktop (${engine(ua)})`;
  for (const [pattern, name] of BROWSERS) {
    const match = ua.match(pattern);
    if (match) return `${name} ${match[1]}`;
  }
  return 'Unknown';
}

const BROWSERS: [RegExp, string][] = [
  [/Edg(?:A|iOS)?\/([\d.]+)/, 'Microsoft Edge'],
  [/(?:Firefox|FxiOS)\/([\d.]+)/, 'Firefox'],
  [/(?:Chrome|CriOS)\/([\d.]+)/, 'Chrome'],
  [/Version\/([\d.]+).*Safari/, 'Safari'],
];

function osName(ua: string, hints?: UADataValues): string {
  const arch = hints?.architecture ? ` ${hints.architecture === 'arm' ? 'arm64' : hints.architecture}` : '';
  const version = hints?.platformVersion;
  switch (hints?.platform) {
    case 'macOS':
      return `macOS${version ? ` ${version.replace(/\.0$/, '')}` : ''}${arch}`;
    case 'Windows':
      // Client hints report 13 and above for Windows 11.
      return `Windows ${version && parseInt(version) >= 13 ? '11' : '10'}${arch}`;
    case 'Android':
      return `Android${version ? ` ${version}` : ''}`;
    case 'Chrome OS':
      return 'ChromeOS';
    case 'Linux':
      return `Linux${arch}`;
  }
  const ios = ua.match(/(iPhone|iPad|iPod).* OS (\d+[_\d]*)/);
  if (ios) return `${ios[1] === 'iPad' ? 'iPadOS' : 'iOS'} ${ios[2].replace(/_/g, '.')}`;
  // iPads request desktop sites as a Mac.
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? 'iPadOS' : 'macOS';
  const android = ua.match(/Android ([\d.]+)/);
  if (android) return `Android ${android[1]}`;
  if (/Windows/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

function display(hz: number | null): string {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = window.screen;
  const physical = `${Math.round(width * dpr)}×${Math.round(height * dpr)}`;
  const parts = [physical];
  if (hz) parts.push(`@ ${hz} Hz`);
  if (dpr !== 1) parts.push(`(as ${width}×${height})`);
  if (window.matchMedia?.('(dynamic-range: high)').matches) parts.push('HDR');
  return parts.join(' ');
}

/** The median frame interval over a few animation frames. */
function refreshRate(): Promise<number | null> {
  return new Promise((resolve) => {
    const times: number[] = [];
    const timeout = setTimeout(() => resolve(null), 1000);
    const frame = (t: number) => {
      times.push(t);
      if (times.length < 21) return void requestAnimationFrame(frame);
      clearTimeout(timeout);
      const deltas = times
        .slice(1)
        .map((t, i) => t - times[i])
        .sort((a, b) => a - b);
      const median = deltas[deltas.length >> 1];
      resolve(median > 0 ? Math.round(1000 / median) : null);
    };
    requestAnimationFrame(frame);
  });
}

async function gpuName(): Promise<string | null> {
  const webgl = webglRenderer();
  if (webgl && webgl !== 'Apple GPU') return webgl;
  type Adapter = { info?: { vendor?: string; architecture?: string; description?: string } };
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<Adapter | null> } }).gpu;
  const info = (await gpu?.requestAdapter().catch(() => null))?.info;
  const name = info?.description || [info?.vendor, info?.architecture].filter(Boolean).join(' ');
  return name || webgl;
}

function webglRenderer(): string | null {
  const gl = document.createElement('canvas').getContext('webgl');
  if (!gl) return null;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return cleanRenderer(renderer) || null;
}

/** "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)" → "Apple M4". */
export function cleanRenderer(renderer: string): string {
  const angle = renderer.match(/^ANGLE \((.*)\)$/);
  if (!angle) return renderer.trim();
  const [vendor, device = vendor] = angle[1].split(', ');
  return device
    .replace(/^ANGLE \w+ Renderer: /, '')
    .replace(/ \(0x[0-9a-f]+\)/i, '')
    .replace(/ Direct3D.*$/, '')
    .trim();
}
