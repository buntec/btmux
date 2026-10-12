// Mouse movement for scripts/desktop-demo.applescript, in screen points and
// milliseconds.
//
//   osascript -l JavaScript desktop-demo-mouse.js glide <x> <y> [ms]
//   osascript -l JavaScript desktop-demo-mouse.js swirl <cx> <cy> <rx> <ry> <ms>

ObjC.import('CoreGraphics');

const MOVED = 5;
const FPS = 60;

function post(type, x, y) {
  $.CGEventPost(0, $.CGEventCreateMouseEvent(null, type, { x, y }, 0));
}

function position() {
  const p = $.CGEventGetLocation($.CGEventCreate(null));
  return [p.x, p.y];
}

function glide(x, y, seconds) {
  const [x0, y0] = position();
  const steps = Math.max(1, Math.round(seconds * FPS));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    post(MOVED, x0 + (x - x0) * ease, y0 + (y - y0) * ease);
    delay(1 / FPS);
  }
}

// A Lissajous figure around the center.
function swirl(cx, cy, rx, ry, seconds) {
  glide(cx, cy, 0.5);
  const steps = Math.round(seconds * FPS);
  for (let i = 0; i <= steps; i++) {
    const a = (2 * Math.PI * i) / FPS / 3;
    post(MOVED, cx + rx * Math.sin(a), cy + ry * Math.sin(2 * a));
    delay(1 / FPS);
  }
}

function run(argv) {
  const [command, ...rest] = argv;
  const n = rest.map(Number);
  if (command === 'glide') glide(n[0], n[1], (n[2] ?? 600) / 1000);
  else if (command === 'swirl') swirl(n[0], n[1], n[2], n[3], n[4] / 1000);
  else throw new Error(`Unknown command: ${command}`);
}
