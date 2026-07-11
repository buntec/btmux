import { CircleCheckIcon, InfoIcon, OctagonXIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import type { NotificationLevel } from '../protocol/messages';

const LEVEL_STYLE: Record<NotificationLevel, { icon: typeof InfoIcon; badge: string; bar: string }> = {
  success: { icon: CircleCheckIcon, badge: 'bg-theme-green/15 text-theme-green', bar: 'bg-theme-green/70' },
  attention: { icon: TriangleAlertIcon, badge: 'bg-theme-yellow/15 text-theme-yellow', bar: 'bg-theme-yellow/70' },
  error: { icon: OctagonXIcon, badge: 'bg-theme-red/15 text-theme-red', bar: 'bg-theme-red/70' },
  info: { icon: InfoIcon, badge: 'bg-theme-blue/15 text-theme-blue', bar: 'bg-theme-blue/70' },
};

interface ToastCardProps {
  level: NotificationLevel;
  title: string;
  message?: string;
  duration: number;
  onDismiss: () => void;
  onView?: () => void;
}

/** The "btmux chrome" toast — a glyph badge, title/message, close button, and a
 * duration bar that shrinks to zero over the toast's lifetime. Rendered via
 * `toast.custom()` so sonner still owns stacking, swipe-to-dismiss, and timing. */
export function ToastCard({ level, title, message, duration, onDismiss, onView }: ToastCardProps) {
  const { icon: Icon, badge, bar } = LEVEL_STYLE[level];
  return (
    <div
      className={`relative flex w-full items-start gap-2.5 overflow-hidden rounded-lg border border-border bg-popover py-2.5 pr-2 pl-3 shadow-lg ${onView ? 'cursor-pointer' : ''}`}
      onClick={
        onView
          ? () => {
              onView();
              onDismiss();
            }
          : undefined
      }
    >
      <div className={`mt-0.5 flex size-5 flex-none items-center justify-center rounded-md ${badge}`}>
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-popover-foreground">{title}</div>
        {message && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{message}</div>}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="-mt-0.5 -mr-1 flex size-4.5 flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-popover-foreground"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
      >
        <XIcon className="size-3" />
      </button>
      <div
        className={`absolute inset-x-0 bottom-0 h-0.5 origin-left motion-reduce:hidden ${bar}`}
        style={{ animation: `btm-toast-shrink ${duration}ms linear forwards` }}
      />
    </div>
  );
}
