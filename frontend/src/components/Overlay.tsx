import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import { Bind, ClientConfig } from '../state/types';
import { chromePalette, withAlpha } from '../lib/chrome-colors';

/** Ordered keybinding-help sections, each matching a set of action names. */
const KEY_SECTIONS: { title: string; actions: string[] }[] = [
  {
    title: 'Panes',
    actions: [
      'split-horizontal',
      'split-vertical',
      'navigate-left',
      'navigate-right',
      'navigate-up',
      'navigate-down',
      'zoom-pane',
      'kill-pane',
      'next-pane',
      'last-pane',
      'swap-pane-back',
      'swap-pane-forward',
      'next-layout',
      'display-panes',
      'capture-pane',
      'file-browser',
    ],
  },
  {
    title: 'Windows',
    actions: ['new-window', 'next-window', 'prev-window', 'last-window', 'rename-window', 'window-grid', 'kill-window'],
  },
  {
    title: 'Sessions',
    actions: [
      'choose-session',
      'new-session',
      'rename-session',
      'kill-session',
      'next-session',
      'prev-session',
      'last-session',
      'detach',
    ],
  },
  {
    title: 'General',
    actions: ['command-palette', 'list-keys', 'choose-colors', 'choose-font', 'choose-font-weight'],
  },
];

/** Human-friendly label for an action name (kebab-case → spaced words). */
function actionLabel(action: string): string {
  return action.replace(/-/g, ' ');
}

/** Render a key string as a compact keycap glyph (Space, arrows, etc.). */
function keyLabel(key: string): string {
  if (key === ' ') return '␣';
  if (key === 'ArrowLeft') return '←';
  if (key === 'ArrowRight') return '→';
  if (key === 'ArrowUp') return '↑';
  if (key === 'ArrowDown') return '↓';
  return key;
}

interface Props {
  sessionId: string;
  send: (msg: ClientMessage) => void;
  config: ClientConfig | null;
}

export function Overlay({ sessionId, send, config }: Props) {
  const overlay = useStore((s) => s.overlay);
  const setOverlay = useStore((s) => s.setOverlay);
  const fontSize = Math.max(6, Math.min(72, config?.terminal?.fontSize ?? 14));
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const focusRef = useRef<HTMLDivElement>(null);

  // Command-palette selection + typeahead filter (only used in `command` mode).
  const [cmdIdx, setCmdIdx] = useState(0);
  const [cmdQuery, setCmdQuery] = useState('');
  // Picker selection index.
  const [pickerIdx, setPickerIdx] = useState(0);
  // Tracks which picker item was last applied (space/click).
  const [pickerApplied, setPickerApplied] = useState<string | null>(null);

  useEffect(() => {
    if (!overlay) return;
    if (overlay.mode === 'prompt') inputRef.current?.focus();
    else focusRef.current?.focus();
    // Reset palette state whenever a new overlay opens.
    setCmdIdx(0);
    setCmdQuery('');
    // Start picker at the active item if there is one.
    if (overlay.mode === 'picker') {
      const activeIdx = overlay.items.findIndex((i) => i.active);
      setPickerIdx(activeIdx >= 0 ? activeIdx : 0);
      setPickerApplied(null);
    } else {
      setPickerIdx(0);
      setPickerApplied(null);
    }
  }, [overlay?.mode]);

  // Re-focus the picker after config-change re-renders (space-to-apply causes
  // a config broadcast that rebuilds terminal panes which grab focus).
  useEffect(() => {
    if (overlay?.mode === 'picker') {
      const id = setTimeout(() => focusRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  });

  if (!overlay) return null;

  const runCommand = (cmdId: string) => {
    if (cmdId === 'choose-colors') {
      const schemes = config?.color_schemes ?? [];
      const active = config?.active_color_scheme;
      setOverlay({
        mode: 'picker',
        title: 'Color scheme',
        items: [
          { id: '', label: '(none)', active: !active },
          ...schemes.map((s) => ({ id: s, label: s, active: s === active })),
        ],
        onSelect: (id) => send({ type: 'update_config', update: { colors: id } }),
      });
      return true;
    }
    if (cmdId === 'choose-font') {
      const fonts = config?.fonts ?? [];
      const currentFamily = config?.terminal?.fontFamily ?? 'JetBrains Mono';
      const currentWeight = config?.terminal?.fontWeight ?? 200;
      setOverlay({
        mode: 'picker',
        title: `Font (current: ${currentFamily} @ ${currentWeight})`,
        items: fonts.map((f) => ({
          id: `${f.family}:${f.weight_min}`,
          label: `${f.family} (${f.weight_min}–${f.weight_max})`,
          active: f.family === currentFamily,
        })),
        onSelect: (id) => {
          const [family] = id.split(':');
          send({ type: 'update_config', update: { font_family: family } });
        },
      });
      return true;
    }
    if (cmdId === 'choose-font-weight') {
      const fonts = config?.fonts ?? [];
      const currentFamily = config?.terminal?.fontFamily ?? 'JetBrains Mono';
      const currentWeight = config?.terminal?.fontWeight ?? 200;
      const fontInfo = fonts.find((f) => f.family === currentFamily);
      const min = fontInfo?.weight_min ?? 100;
      const max = fontInfo?.weight_max ?? 900;
      const weights: { id: string; label: string; active: boolean }[] = [];
      for (let w = min; w <= max; w += 100) {
        weights.push({ id: String(w), label: String(w), active: w === currentWeight });
      }
      setOverlay({
        mode: 'picker',
        title: `Font weight (${currentFamily})`,
        items: weights,
        onSelect: (id) => {
          send({ type: 'update_config', update: { font_weight: parseInt(id, 10) } });
        },
      });
      return true;
    }
    return false;
  };

  // Filtered command list (palette mode). Computed before the early-return-free
  // render so the key handler and the list render agree on indices.
  const filteredCommands =
    overlay.mode === 'command'
      ? overlay.commands.filter((c) => c.label.toLowerCase().includes(cmdQuery.trim().toLowerCase()))
      : [];
  const clampedCmdIdx = Math.min(cmdIdx, Math.max(0, filteredCommands.length - 1));

  const close = () => setOverlay(null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();

    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }

    if (overlay.mode === 'prompt' && e.key === 'Enter') {
      e.preventDefault();
      const name = overlay.value.trim();
      if (name) {
        if (overlay.action === 'rename-window') {
          send({ type: 'rename_window', session_id: sessionId, name });
        } else if (overlay.action === 'rename-session') {
          send({ type: 'rename_session', session_id: sessionId, name });
          navigate(`/s/${encodeURIComponent(name)}`, { replace: true });
        } else if (overlay.action === 'new-session') {
          send({ type: 'create_session', name });
        }
      } else if (overlay.action === 'new-session') {
        send({ type: 'create_session', name: null });
      }
      close();
      return;
    }

    if (overlay.mode === 'command') {
      const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
      const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
      if (down || up) {
        e.preventDefault();
        const n = filteredCommands.length;
        if (n === 0) return;
        setCmdIdx((i) => (Math.min(i, n - 1) + (down ? 1 : -1) + n) % n);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filteredCommands[clampedCmdIdx];
        if (!cmd) return;
        if (runCommand(cmd.id)) return;
        if (cmd.confirm) {
          setOverlay({
            mode: 'confirm',
            title: cmd.confirm,
            onConfirm: () => send({ type: 'run_command', command: cmd.id, session_id: sessionId }),
          });
        } else {
          send({ type: 'run_command', command: cmd.id, session_id: sessionId });
          close();
        }
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        setCmdQuery((q) => q.slice(0, -1));
        setCmdIdx(0);
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setCmdQuery((q) => q + e.key);
        setCmdIdx(0);
        return;
      }
      return;
    }

    if (overlay.mode === 'picker') {
      const n = overlay.items.length;
      const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') || e.key === 'j';
      const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') || e.key === 'k';
      if (down || up) {
        e.preventDefault();
        if (n === 0) return;
        setPickerIdx((i) => (Math.min(i, n - 1) + (down ? 1 : -1) + n) % n);
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        const item = overlay.items[Math.min(pickerIdx, n - 1)];
        if (item) {
          overlay.onSelect(item.id);
          setPickerApplied(item.id);
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = overlay.items[Math.min(pickerIdx, n - 1)];
        if (item) {
          overlay.onSelect(item.id);
          close();
        }
        return;
      }
      return;
    }

    if (overlay.mode === 'confirm') {
      if (e.key === 'y' || e.key === 'Enter') {
        e.preventDefault();
        overlay.onConfirm();
        if (overlay.returnTo) setOverlay(overlay.returnTo);
        else close();
      } else if (e.key === 'n' || e.key === 'Escape') {
        e.preventDefault();
        if (overlay.returnTo) setOverlay(overlay.returnTo);
        else close();
      }
    }
  };

  const c = chromePalette(config?.theme ?? null);
  const bg = c.panelBg;
  const fg = c.fg;
  const accent = c.accent;
  const dimFg = c.fgDim;
  const hintFont = `${Math.max(6, fontSize - 2)}px`;
  const animations = config?.animations ?? true;

  // The keybinding-help overlay is a centered modal (backdrop + panel); every
  // other overlay mode is a bottom-anchored sheet.
  if (overlay.mode === 'keys') {
    const byAction = new Map(overlay.binds.map((b) => [b.action, b] as const));
    const shown = new Set<string>();
    return (
      <div
        onKeyDown={onKeyDown}
        tabIndex={0}
        ref={focusRef}
        style={{
          position: 'absolute',
          inset: 0,
          background: withAlpha(c.bodyBg, 0.55),
          backdropFilter: 'blur(3px)',
          WebkitBackdropFilter: 'blur(3px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          outline: 'none',
          zIndex: 10,
          fontFamily: 'var(--btmux-font, monospace)',
          fontWeight: 'var(--btmux-font-weight, 400)',
          fontSize: `${fontSize}px`,
          animation: animations ? 'btm-fade .15s ease' : undefined,
        }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div
          style={{
            width: '840px',
            maxWidth: '94%',
            maxHeight: '88%',
            overflow: 'auto',
            borderRadius: '12px',
            background: c.panelBg,
            border: `1px solid ${c.border}`,
            boxShadow: `0 30px 80px ${withAlpha(c.bodyBg, 0.55)}`,
            animation: animations ? 'btm-in .18s ease' : undefined,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '16px 20px 14px',
              borderBottom: `1px solid ${c.borderDim}`,
            }}
          >
            <span style={{ color: c.fgBright, fontWeight: 800, fontSize: `${fontSize + 2}px` }}>{overlay.title}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: c.fgDim, fontSize: hintFont }}>
              prefix
              <span style={{ ...keycapStyle(c), fontSize: hintFont }}>{config?.prefix ?? 'C-b'}</span>
              then…
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ color: c.fgDim, fontSize: hintFont }}>esc to close</span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '18px 34px',
              padding: '18px 22px 22px',
            }}
          >
            {KEY_SECTIONS.map((section) => {
              const rows = section.actions.map((action) => byAction.get(action)).filter((b): b is Bind => !!b);
              rows.forEach((b) => shown.add(b.action));
              if (rows.length === 0) return null;
              return <KeySection key={section.title} title={section.title} rows={rows} c={c} />;
            })}
            {(() => {
              // Any bound action not placed in a named section (e.g. user-added
              // vi binds) goes in a catch-all so the help stays complete.
              const rest = overlay.binds.filter((b) => !shown.has(b.action));
              if (rest.length === 0) return null;
              return <KeySection title="Other" rows={rest} c={c} />;
            })()}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        background: withAlpha(bg, 0.96),
        backdropFilter: 'blur(9px)',
        WebkitBackdropFilter: 'blur(9px)',
        color: fg,
        borderTop: `1px solid ${c.border}`,
        boxShadow: `0 -14px 40px ${withAlpha(c.bodyBg, 0.4)}`,
        fontFamily: 'var(--btmux-font, monospace)',
        fontWeight: 'var(--btmux-font-weight, 400)',
        fontSize: `${fontSize}px`,
        zIndex: 10,
        animation: animations ? 'btm-in .16s ease' : undefined,
      }}
    >
      {overlay.mode === 'prompt' ? (
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px' }}>
          <span style={{ color: accent, marginRight: '8px' }}>{overlay.title}:</span>
          <input
            ref={inputRef}
            value={overlay.value}
            onChange={(e) => setOverlay({ ...overlay, value: e.target.value })}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: fg,
              fontFamily: 'var(--btmux-font, monospace)',
              fontWeight: 'var(--btmux-font-weight, 400)',
              fontSize: `${fontSize}px`,
            }}
          />
        </div>
      ) : overlay.mode === 'confirm' ? (
        <div tabIndex={0} ref={focusRef} style={{ outline: 'none', padding: '4px 8px' }}>
          <span style={{ color: accent }}>{overlay.title} </span>
          <span style={{ color: dimFg }}>(y/enter=yes, n/esc=no)</span>
        </div>
      ) : overlay.mode === 'command' ? (
        /* command palette */
        <div tabIndex={0} ref={focusRef} style={{ outline: 'none' }}>
          <div
            style={{
              padding: '9px 14px 4px',
              fontSize: `${Math.max(6, fontSize - 3)}px`,
              letterSpacing: '.12em',
              textTransform: 'uppercase',
              color: c.fgDim,
            }}
          >
            Commands
          </div>
          <div style={{ maxHeight: '48vh', overflowY: 'auto' }}>
            {filteredCommands.length === 0 ? (
              <div style={{ color: dimFg, padding: '8px 14px' }}>
                {overlay.commands.length === 0 ? 'No commands.' : 'No matching commands.'}
              </div>
            ) : (
              filteredCommands.map((cmd, i) => {
                const selected = i === clampedCmdIdx;
                return (
                  <div
                    key={cmd.id}
                    onClick={() => {
                      if (runCommand(cmd.id)) return;
                      if (cmd.confirm) {
                        setOverlay({
                          mode: 'confirm',
                          title: cmd.confirm,
                          onConfirm: () => send({ type: 'run_command', command: cmd.id, session_id: sessionId }),
                        });
                      } else {
                        send({ type: 'run_command', command: cmd.id, session_id: sessionId });
                        close();
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '8px 14px',
                      cursor: 'pointer',
                      background: selected ? withAlpha(accent, 0.09) : 'transparent',
                      borderLeft: `2px solid ${selected ? accent : 'transparent'}`,
                      userSelect: 'none',
                    }}
                  >
                    <span style={{ color: selected ? accent : fg, fontWeight: 700, minWidth: '150px' }}>
                      {cmd.label}
                    </span>
                    <span style={{ color: selected ? c.fgMuted : dimFg }}>{cmd.description}</span>
                  </div>
                );
              })
            )}
          </div>
          {/* Prompt line footer with the typed query. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '9px',
              padding: '11px 14px',
              borderTop: `1px solid ${c.borderDim}`,
              background: withAlpha(c.bodyBg, 0.5),
            }}
          >
            <span style={{ color: accent, fontWeight: 800, fontSize: `${fontSize + 1}px` }}>:</span>
            <span style={{ color: c.fgBright }}>
              {cmdQuery}<span style={{ animation: 'btm-blink 1.05s steps(1) infinite' }}>▏</span>
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ color: dimFg, fontSize: hintFont }}>↵ run · ⇥/↑↓ select · esc cancel</span>
          </div>
        </div>
      ) : overlay.mode === 'picker' ? (
        /* picker overlay */
        <div tabIndex={0} ref={focusRef} style={{ outline: 'none' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '9px 14px 6px',
              gap: '10px',
            }}
          >
            <span
              style={{
                fontSize: `${Math.max(6, fontSize - 3)}px`,
                letterSpacing: '.12em',
                textTransform: 'uppercase',
                color: c.fgDim,
              }}
            >
              {overlay.title}
            </span>
            <span style={{ marginLeft: 'auto', color: dimFg, fontSize: hintFont }}>
              ↑/↓ select · space apply · enter confirm · esc cancel
            </span>
          </div>
          <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
            {overlay.items.length === 0 ? (
              <div style={{ color: dimFg, padding: '8px 14px' }}>No items available.</div>
            ) : (
              overlay.items.map((item, i) => {
                const selected = i === Math.min(pickerIdx, overlay.items.length - 1);
                const isApplied = pickerApplied !== null ? item.id === pickerApplied : item.active;
                return (
                  <div
                    key={item.id || `__none_${i}`}
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      setPickerIdx(i);
                      overlay.onSelect(item.id);
                      setPickerApplied(item.id);
                    }}
                    style={{
                      padding: '7px 14px',
                      cursor: 'pointer',
                      background: selected ? withAlpha(accent, 0.09) : 'transparent',
                      borderLeft: `2px solid ${selected ? accent : 'transparent'}`,
                      userSelect: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span
                      style={{
                        color: isApplied ? accent : selected ? c.fgBright : fg,
                        fontWeight: isApplied ? 700 : 400,
                      }}
                    >
                      {item.label}
                    </span>
                    {isApplied && <span style={{ color: accent }}>●</span>}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A key-cap glyph style used in the keybinding-help header + rows. */
function keycapStyle(c: ReturnType<typeof chromePalette>): React.CSSProperties {
  return {
    minWidth: '30px',
    textAlign: 'center',
    padding: '3px 8px',
    borderRadius: '6px',
    background: c.titleActiveBg,
    border: `1px solid ${c.border}`,
    color: c.fgBright,
    fontWeight: 700,
  };
}

/** One titled column of key→action rows in the keybinding-help modal. */
function KeySection({ title, rows, c }: { title: string; rows: Bind[]; c: ReturnType<typeof chromePalette> }) {
  return (
    <div>
      <div
        style={{
          color: c.accent,
          fontSize: '11px',
          letterSpacing: '.14em',
          textTransform: 'uppercase',
          fontWeight: 700,
          marginBottom: '10px',
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
        {rows.map((b) => (
          <div key={b.action} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ ...keycapStyle(c), fontSize: '12px', flex: 'none' }}>{keyLabel(b.key)}</span>
            <span style={{ color: c.fgMuted, fontSize: '12.5px' }}>{actionLabel(b.action)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
