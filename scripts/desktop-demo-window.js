// Prints the window ID and height in points of a process's frontmost
// on-screen window, for `screencapture -l` in scripts/record-desktop-demo.sh.
//
//   osascript -l JavaScript desktop-demo-window.js <pid>

ObjC.import('CoreGraphics');

function run(argv) {
  const pid = Number(argv[0]);
  const windows = ObjC.deepUnwrap(
    ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID)),
  );
  // Front to back; layer 0 holds normal windows.
  const window = windows.find((w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0);
  if (!window) throw new Error(`No on-screen window for pid ${pid}`);
  return `${window.kCGWindowNumber} ${window.kCGWindowBounds.Height}`;
}
