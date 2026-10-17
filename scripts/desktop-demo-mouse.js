// Mouse movement for scripts/desktop-demo.applescript, in screen points and
// milliseconds.
//
//   osascript -l JavaScript desktop-demo-mouse.js glide <x> <y> [ms]
//   osascript -l JavaScript desktop-demo-mouse.js swirl <cx> <cy> <rx> <ry> <ms>

ObjC.import('CoreGraphics');
ObjC.import('Foundation');

const MOVED = 5;
const FPS = 60;

function post(type, x, y) {
  $.CGEventPost(0, $.CGEventCreateMouseEvent(null, type, { x, y }, 0));
}

function now() {
  return $.NSDate.timeIntervalSinceReferenceDate;
}

// Timers of this background process are coalesced, so delay() overshoots by
// up to ~100 ms; spin to the next frame instead.
function frames(seconds, draw) {
  const start = now();
  for (let frame = 1; ; frame++) {
    const target = start + frame / FPS;
    while (now() < target);
    const elapsed = Math.min(now() - start, seconds);
    draw(elapsed);
    if (elapsed >= seconds) return;
  }
}

function position() {
  const p = $.CGEventGetLocation($.CGEventCreate(null));
  return [p.x, p.y];
}

function glide(x, y, seconds) {
  const [x0, y0] = position();
  frames(seconds, (elapsed) => {
    const t = seconds > 0 ? elapsed / seconds : 1;
    const ease = t * t * (3 - 2 * t);
    post(MOVED, x0 + (x - x0) * ease, y0 + (y - y0) * ease);
  });
}

// A Lissajous figure around the center.
function swirl(cx, cy, rx, ry, seconds) {
  glide(cx, cy, 0.5);
  frames(seconds, (elapsed) => {
    const a = (2 * Math.PI * elapsed) / 3;
    post(MOVED, cx + rx * Math.sin(a), cy + ry * Math.sin(2 * a));
  });
}

function run(argv) {
  const [command, ...rest] = argv;
  const n = rest.map(Number);
  if (command === 'glide') glide(n[0], n[1], (n[2] ?? 600) / 1000);
  else if (command === 'swirl') swirl(n[0], n[1], n[2], n[3], n[4] / 1000);
  else throw new Error(`Unknown command: ${command}`);
}
