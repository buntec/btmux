import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state/store';
import { ClientMessage } from '../protocol/messages';
import { ClientConfig } from '../state/types';
import { DEFAULT_THEME } from '../state/defaultTheme';

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

  const bg = config?.theme?.background ?? DEFAULT_THEME.background;
  const fg = config?.theme?.foreground ?? DEFAULT_THEME.foreground;
  const accent = config?.theme?.yellow ?? DEFAULT_THEME.yellow;
  const dimFg = config?.theme?.brightBlack ?? DEFAULT_THEME.brightBlack;
  const activeFg = config?.theme?.green ?? DEFAULT_THEME.green;
  const selBg = config?.theme?.selectionBackground ?? DEFAULT_THEME.selectionBackground;

  return (
    <div
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        background: bg,
        color: fg,
        borderTop: `1px solid ${accent}`,
        fontFamily: 'var(--btmux-font, monospace)',
        fontWeight: 'var(--btmux-font-weight, 400)',
        fontSize: `${fontSize}px`,
        zIndex: 10,
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
        <div
          tabIndex={0}
          ref={focusRef}
          style={{ outline: 'none', padding: '4px 0', maxHeight: '60vh', overflowY: 'auto' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0 8px 4px',
              color: accent,
            }}
          >
            <span style={{ marginRight: '8px' }}>:</span>
            <span style={{ color: fg }}>{cmdQuery}</span>
            <span>▏</span>
            <span style={{ marginLeft: 'auto', color: dimFg, fontSize: `${Math.max(6, fontSize - 2)}px` }}>
              ↑/↓ C-n/C-p select · enter run · esc cancel
            </span>
          </div>
          {filteredCommands.length === 0 ? (
            <div style={{ color: dimFg, padding: '2px 8px' }}>
              {overlay.commands.length === 0 ? 'No commands.' : 'No matching commands.'}
            </div>
          ) : (
            filteredCommands.map((c, i) => {
              const selected = i === clampedCmdIdx;
              return (
                <div
                  key={c.id}
                  onClick={() => {
                    if (runCommand(c.id)) return;
                    if (c.confirm) {
                      setOverlay({
                        mode: 'confirm',
                        title: c.confirm,
                        onConfirm: () => send({ type: 'run_command', command: c.id, session_id: sessionId }),
                      });
                    } else {
                      send({ type: 'run_command', command: c.id, session_id: sessionId });
                      close();
                    }
                  }}
                  style={{
                    padding: '2px 8px',
                    cursor: 'pointer',
                    background: selected ? selBg : 'transparent',
                    userSelect: 'none',
                  }}
                >
                  <span style={{ color: activeFg }}>{c.label}</span>
                  <span style={{ color: dimFg, marginLeft: '12px' }}>{c.description}</span>
                </div>
              );
            })
          )}
        </div>
      ) : overlay.mode === 'picker' ? (
        /* picker overlay */
        <div
          tabIndex={0}
          ref={focusRef}
          style={{ outline: 'none', padding: '4px 0', maxHeight: '60vh', overflowY: 'auto' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px 4px', color: accent }}>
            <span>{overlay.title}</span>
            <span style={{ marginLeft: 'auto', color: dimFg, fontSize: `${Math.max(6, fontSize - 2)}px` }}>
              ↑/↓ select · space apply · enter confirm · esc cancel
            </span>
          </div>
          {overlay.items.length === 0 ? (
            <div style={{ color: dimFg, padding: '2px 8px' }}>No items available.</div>
          ) : (
            overlay.items.map((item, i) => {
              const selected = i === Math.min(pickerIdx, overlay.items.length - 1);
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
                    padding: '2px 8px',
                    cursor: 'pointer',
                    background: selected ? selBg : 'transparent',
                    userSelect: 'none',
                    display: 'flex',
                    gap: '8px',
                  }}
                >
                  {(() => {
                    const isApplied = pickerApplied !== null ? item.id === pickerApplied : item.active;
                    return (
                      <>
                        <span style={{ color: isApplied ? activeFg : fg }}>{item.label}</span>
                        {isApplied && <span style={{ color: dimFg }}>●</span>}
                      </>
                    );
                  })()}
                </div>
              );
            })
          )}
        </div>
      ) : (
        /* keys overlay */
        <div
          tabIndex={0}
          ref={focusRef}
          style={{
            outline: 'none',
            padding: '4px 0',
            maxHeight: '60vh',
            overflowY: 'auto',
          }}
        >
          <div style={{ color: accent, padding: '0 8px 4px' }}>
            {overlay.title} — prefix: {config?.prefix ?? 'C-b'} (esc to close)
          </div>
          {[...overlay.binds]
            .sort((a, b) => a.action.localeCompare(b.action))
            .map((b) => (
              <div key={b.action} style={{ display: 'flex', padding: '1px 8px', gap: '16px' }}>
                <span style={{ color: activeFg, minWidth: '120px' }}>{b.action}</span>
                <span style={{ color: dimFg }}>{b.key === ' ' ? 'Space' : b.key}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
