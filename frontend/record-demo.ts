/**
 * Playwright demo recorder for btmux.
 *
 * Usage (against an already-running btmux instance):
 *   BTMUX_URL=http://localhost:8004 BTMUX_AUTH_TOKEN=… bun run record-demo.ts
 *
 * The normal entry point is:
 *   just record-demo
 *
 *   BTMUX_SESSION=my-session BTMUX_PREFIX=C-a just record-demo
 *
 * Output: demo.webm in the repo root (and demo.mp4 if ffmpeg is in PATH).
 *
 * Set BTMUX_SESSION to select a session (otherwise the first API session is
 * used) and BTMUX_PREFIX=C-a (or your configured prefix) if needed.
 */

import { chromium } from 'playwright';
import * as path from 'path';
import * as child_process from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.BTMUX_URL ?? 'http://localhost:8004';
const AUTH_TOKEN = process.env.BTMUX_AUTH_TOKEN;
const SESSION_NAME = process.env.BTMUX_SESSION;
const PREFIX_OVERRIDE = process.env.BTMUX_PREFIX;

interface PrefixBinding {
  modifier: 'Control' | 'Alt';
  key: string;
  label: string;
}

function parsePrefix(raw: string): PrefixBinding {
  const match = raw.match(/^([CcMm])-(.+)$/);
  if (!match) return { modifier: 'Control', key: raw, label: raw };
  return {
    modifier: match[1].toLowerCase() === 'm' ? 'Alt' : 'Control',
    key: match[2],
    label: raw,
  };
}

const OUT_DIR = path.resolve(__dirname, '..');
const DEMO_CWD = process.env.BTMUX_CWD ?? OUT_DIR;
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 800;

// Helper: send prefix then a second key (tmux-style two-key chord).
async function prefix(page: import('playwright').Page, key: string, binding: PrefixBinding) {
  await page.keyboard.press(`${binding.modifier}+${binding.key}`);
  await page.waitForTimeout(120);
  await page.keyboard.press(key);
}

// Helper: type text into the active element with a slight per-character delay.
async function typeSlowly(page: import('playwright').Page, text: string, delayMs = 60) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(delayMs);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Wait for at least one terminal canvas to be visible (PTY connected).
async function waitForTerminal(page: import('playwright').Page, timeoutMs = 15_000) {
  await page.waitForSelector('canvas', { state: 'visible', timeout: timeoutMs });
}

async function resolveSessionName(): Promise<string> {
  if (SESSION_NAME) return SESSION_NAME;

  const response = await fetch(`${BASE_URL}/api/sessions`, {
    headers: AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {},
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Could not list btmux sessions (${response.status}): ${body.slice(0, 200)}`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error('Could not list btmux sessions: expected a JSON array');
  }
  const sessions = payload as Array<{ name: string }>;
  const first = sessions[0]?.name;
  if (!first) throw new Error('No btmux sessions are available');
  return first;
}

async function resolvePrefix(page: import('playwright').Page): Promise<PrefixBinding> {
  if (PREFIX_OVERRIDE) return parsePrefix(PREFIX_OVERRIDE);

  const configured = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(
          `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/control`,
        );
        const timeout = window.setTimeout(() => {
          socket.close();
          reject(new Error('Timed out waiting for btmux config'));
        }, 5000);
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as { type?: string; config?: { prefix?: unknown } };
            if (message.type === 'config' && typeof message.config?.prefix === 'string') {
              window.clearTimeout(timeout);
              socket.close();
              resolve(message.config.prefix);
            }
          } catch {
            // Ignore non-JSON frames.
          }
        };
        socket.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('Could not read btmux config'));
        };
      }),
  );
  return parsePrefix(configured);
}

async function main() {
  const browser = await chromium.launch({
    headless: false, // headed for font rendering and WebGL
    args: [
      '--window-size=1280,800',
      '--disable-web-security', // for local WebSocket
      '--no-sandbox',
    ],
  });

  const context = await browser.newContext({
    httpCredentials: AUTH_TOKEN ? { username: 'btmux', password: AUTH_TOKEN } : undefined,
    viewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
    recordVideo: {
      dir: OUT_DIR,
      size: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
    },
  });

  const page = await context.newPage();

  try {
    // ── 1. Landing page ──────────────────────────────────────────────────────
    console.log('Navigating to btmux…');
    const sessionName = await resolveSessionName();
    await page.goto(`${BASE_URL}/s/${encodeURIComponent(sessionName)}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const prefixBinding = await resolvePrefix(page);
    console.log(`Using prefix ${prefixBinding.label}…`);

    // ── 2. Use the checkout as the working directory ──────────────────────────
    console.log(`Changing to ${DEMO_CWD}…`);
    await typeSlowly(page, `cd ${shellQuote(DEMO_CWD)}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // ── 3. Type a command in the first pane ──────────────────────────────────
    console.log('Typing in first pane…');
    await typeSlowly(page, 'echo "hello from btmux"');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    // ── 4. Split vertical (prefix + %) ───────────────────────────────────────
    console.log('Splitting vertically…');
    await prefix(page, 'Shift+Digit5', prefixBinding); // % key
    await waitForTerminal(page);
    await page.waitForTimeout(1000);

    await typeSlowly(page, 'ls -la');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);

    // ── 5. Split horizontal in the right pane (prefix + ") ───────────────────
    console.log('Splitting horizontally…');
    await prefix(page, 'Shift+Quote', prefixBinding); // " key
    await waitForTerminal(page);
    await page.waitForTimeout(1000);

    await typeSlowly(page, 'git status', 40);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1400);

    // ── 6. Navigate between panes (prefix + arrow keys) ──────────────────────
    console.log('Navigating panes…');
    await prefix(page, 'ArrowLeft', prefixBinding);
    await page.waitForTimeout(700);
    await prefix(page, 'ArrowDown', prefixBinding);
    await page.waitForTimeout(700);
    await prefix(page, 'ArrowLeft', prefixBinding);
    await page.waitForTimeout(700);

    // ── 7. Zoom a pane (prefix + z) ──────────────────────────────────────────
    console.log('Zooming pane…');
    await prefix(page, 'z', prefixBinding);
    await page.waitForTimeout(1000);
    await prefix(page, 'z', prefixBinding); // unzoom
    await page.waitForTimeout(800);

    // ── 8. Rename this window (prefix + ,) ───────────────────────────────────
    console.log('Renaming window…');
    await prefix(page, 'Comma', prefixBinding);
    await page.waitForTimeout(500);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    await typeSlowly(page, 'demo', 80);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    // ── 9. Open the session switcher (prefix + s) ────────────────────────────
    console.log('Opening session switcher…');
    await prefix(page, 's', prefixBinding);
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    // ── 10. Show keybinding help (prefix + ?) ────────────────────────────────
    console.log('Showing keybinding help…');
    await prefix(page, 'Shift+Slash', prefixBinding); // ? = Shift+/
    await page.waitForTimeout(1800);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    // ── 11. New window (prefix + c) ──────────────────────────────────────────
    console.log('Creating new window…');
    await prefix(page, 'c', prefixBinding);
    await waitForTerminal(page);
    await page.waitForTimeout(1000);

    await typeSlowly(page, 'echo "window 2"');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);

    // Cycle back to window 0
    await prefix(page, 'p', prefixBinding);
    await page.waitForTimeout(800);

    console.log('Recording complete.');
  } finally {
    await context.close(); // flushes the video
    await browser.close();
  }

  // Rename the generated .webm to demo.webm
  const { execSync } = child_process;
  try {
    const webm = execSync(`ls -t "${OUT_DIR}"/*.webm | head -1`).toString().trim();
    const dest = path.join(OUT_DIR, 'demo.webm');
    if (webm && webm !== dest) {
      execSync(`mv "${webm}" "${dest}"`);
      console.log(`Saved: ${dest}`);
    } else if (webm) {
      console.log(`Saved: ${webm}`);
    }
  } catch {
    console.log('Could not locate output .webm — check the repo root directory.');
  }

  // Optional: convert to MP4 if ffmpeg is available
  try {
    execSync('which ffmpeg', { stdio: 'ignore' });
    const mp4 = path.join(OUT_DIR, 'demo.mp4');
    console.log('Converting to MP4 with ffmpeg…');
    execSync(`ffmpeg -y -i "${path.join(OUT_DIR, 'demo.webm')}" -c:v libx264 -pix_fmt yuv420p "${mp4}"`, {
      stdio: 'inherit',
    });
    console.log(`MP4 saved: ${mp4}`);
  } catch {
    console.log('ffmpeg not found — keeping .webm output. Convert manually:');
    console.log('  ffmpeg -i demo.webm -c:v libx264 -pix_fmt yuv420p demo.mp4');
    console.log('  gifski --fps 20 -o demo.gif demo.webm  (requires gifski + ffmpeg)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
