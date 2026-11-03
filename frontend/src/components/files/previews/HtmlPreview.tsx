import { useLayoutEffect, useRef } from 'react';
import { previewUrl } from '@/lib/previewUrl';
import { useFileStore } from '@/state/fileStore';

const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml']);

export function isHtmlFile(path: string | null): boolean {
  return HTML_EXTENSIONS.has(path?.split('.').pop()?.toLowerCase() ?? '');
}

export function HtmlPreview() {
  const selectedFile = useFileStore((s) => s.selectedFile);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const forwardingKeys = useRef(false);

  const returnFocus = () => {
    const frame = frameRef.current;
    if (document.activeElement !== frame) return;
    window.focus();
    frame?.closest<HTMLElement>('[tabindex="-1"]')?.focus();
  };

  const onBlur = () =>
    window.setTimeout(() => {
      // Keys in a nested frame, which may be cross-origin, never reach the listener below.
      const nested = frameRef.current?.contentDocument?.activeElement?.matches('iframe, frame');
      if (!forwardingKeys.current || nested) returnFocus();
    });

  useLayoutEffect(() => {
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      // Removing a focused frame would drop focus to <body>, where the file browser ignores keys.
      returnFocus();
    };
  }, []);

  if (!selectedFile) return null;

  // Keys never leave a focused iframe, so hand them to the file browser. Where
  // that can't work, the frame gives up focus instead: WebKit runs no listeners
  // on a sandboxed document, and a link may have left this origin.
  const forwardKeys = () => {
    const win = frameRef.current?.contentDocument?.defaultView;
    forwardingKeys.current = false;
    win?.addEventListener('btmux-probe', () => (forwardingKeys.current = true));
    win?.dispatchEvent(new Event('btmux-probe'));
    if (!forwardingKeys.current) {
      returnFocus();
      return;
    }
    win?.addEventListener('blur', onBlur);
    win?.addEventListener(
      'keydown',
      (e) => {
        const replay = new KeyboardEvent('keydown', {
          key: e.key,
          code: e.code,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
          repeat: e.repeat,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(replay);
        if (replay.defaultPrevented) e.preventDefault();
      },
      true,
    );
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Same origin so assets get the auth cookie; without allow-scripts nothing in it can use that. */}
      <iframe
        ref={frameRef}
        src={previewUrl(selectedFile)}
        sandbox="allow-same-origin"
        data-html-preview
        onLoad={forwardKeys}
        className="flex-1 w-full border-0 bg-white"
        title={selectedFile.split('/').pop() ?? 'HTML'}
      />
    </div>
  );
}
