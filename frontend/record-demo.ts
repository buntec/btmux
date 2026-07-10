/**
 * Playwright demo recorder for btmux.
 *
 * Usage (against the running production instance on :8004):
 *   just record-demo
 *
 * Or against the dev stack:
 *   just dev-backend   # in one terminal
 *   just dev-frontend  # in another
 *   BTMUX_URL=http://localhost:5173 just record-demo
 *
 * Output: demo.webm in the repo root (and demo.mp4 if ffmpeg is in PATH).
 *
 * Set BTMUX_PREFIX=C-a (or your configured prefix) if needed (default: C-b).
 */

import { chromium } from 'playwright';
import * as path from 'path';
import * as child_process from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const URL = process.env.BTMUX_URL ?? 'http://localhost:8004';
// Single letter after C-, e.g. "b" for C-b, "a" for C-a.
const PREFIX_LETTER = (() => {
  const raw = process.env.BTMUX_PREFIX ?? 'a';
  const m = raw.match(/^[Cc]-([a-zA-Z])$/);
  return m ? m[1] : raw;
})();

const OUT_DIR = path.resolve(__dirname, '..');
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 800;

// Helper: send prefix then a second key (tmux-style two-key chord).
async function prefix(page: import('playwright').Page, key: string) {
  await page.keyboard.press(`Control+${PREFIX_LETTER}`);
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

// Wait for at least one terminal canvas to be visible (PTY connected).
async function waitForTerminal(page: import('playwright').Page, timeoutMs = 15_000) {
  await page.waitForSelector('canvas', { state: 'visible', timeout: timeoutMs });
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
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    // Press Enter to open the first (default) session.
    await page.keyboard.press('Enter');
    await waitForTerminal(page);
    await page.waitForTimeout(1500); // let the terminal paint

    // ── 2. Type a command in the first pane ──────────────────────────────────
    console.log('Typing in first pane…');
    await typeSlowly(page, 'echo "hello from btmux"');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    // ── 3. Split vertical (prefix + %) ───────────────────────────────────────
    console.log('Splitting vertically…');
    await prefix(page, 'Shift+5'); // % key
    await waitForTerminal(page);
    await page.waitForTimeout(1000);

    await typeSlowly(page, 'ls -la');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);

    // ── 4. Split horizontal in the right pane (prefix + ") ───────────────────
    console.log('Splitting horizontally…');
    await prefix(page, 'Shift+Quote'); // " key
    await waitForTerminal(page);
    await page.waitForTimeout(1000);

    await typeSlowly(page, 'htop', 40);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1400);

    // ── 5. Navigate between panes (prefix + arrow keys) ──────────────────────
    console.log('Navigating panes…');
    await prefix(page, 'ArrowLeft');
    await page.waitForTimeout(700);
    await prefix(page, 'ArrowDown');
    await page.waitForTimeout(700);
    await prefix(page, 'ArrowLeft');
    await page.waitForTimeout(700);

    // ── 6. Zoom a pane (prefix + z) ──────────────────────────────────────────
    console.log('Zooming pane…');
    await prefix(page, 'z');
    await page.waitForTimeout(1000);
    await prefix(page, 'z'); // unzoom
    await page.waitForTimeout(800);

    // ── 7. Rename this window (prefix + ,) ───────────────────────────────────
    console.log('Renaming window…');
    await prefix(page, 'Comma');
    await page.waitForTimeout(500);
    await typeSlowly(page, 'demo', 80);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    // ── 8. Open the session switcher (prefix + s) ────────────────────────────
    console.log('Opening session switcher…');
    await prefix(page, 's');
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    // ── 9. Show keybinding help (prefix + ?) ─────────────────────────────────
    console.log('Showing keybinding help…');
    await prefix(page, 'Shift+Slash'); // ? = Shift+/
    await page.waitForTimeout(1800);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    // ── 10. New window (prefix + c) ──────────────────────────────────────────
    console.log('Creating new window…');
    await prefix(page, 'c');
    await waitForTerminal(page);
    await page.waitForTimeout(1000);

    await typeSlowly(page, 'echo "window 2"');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);

    // Cycle back to window 0
    await prefix(page, 'p');
    await page.waitForTimeout(800);

    // ── 11. Detach to landing page (prefix + d) ──────────────────────────────
    console.log('Detaching to landing page…');
    await prefix(page, 'd');
    await page.waitForTimeout(1500);

    // ── 12. Hold on landing page, then re-enter ───────────────────────────────
    await page.keyboard.press('Enter');
    await waitForTerminal(page);
    await page.waitForTimeout(1200);

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
