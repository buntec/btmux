import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@astryxdesign/core/Toast';
import type { ClientMessage } from '../protocol/messages';
import type { ClientConfig, ColorMode } from '../state/types';
import { colorSchemeLabel, DEFAULT_COLOR_SCHEMES } from '../lib/colorSchemeLabel';
import { APPEARANCES } from '../lib/appearance';
import { systemColorMode } from '../state/startupTheme';
import { PANE_BORDER_STYLES } from '../lib/paneSwitchBorder';
import type { ShaderLayer } from '../generated/protocol';
import { hasShaderWallpaper, wallpaperLayersToml } from '../lib/wallpaperCatalog';
import { ShaderLayerStack } from './ShaderLayerStack';
import { useWallpaperCheck, type WallpaperStatus } from '../hooks/useWallpaperCheck';
import {
  getDesktopBackgroundOpacity,
  getFontWeightRange,
  getBackdropBlur,
  getBackdropDim,
  getPaneSwitchBorderSpeed,
  getShowPaneTitles,
  getTerminalFontFamily,
  getTerminalFontSize,
  getTerminalFontWeight,
  getWallpaperBlur,
  getWallpaperFollowsKeyboard,
  getWallpaperFollowsMouse,
  getWallpaperFps,
  getWallpaperOpacity,
  getWallpaperResolution,
  getWallpaperSaturate,
  getWallpaperSpeed,
} from '../state/configDefaults';
import { useStore } from '../state/store';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Slider } from '@astryxdesign/core/Slider';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import {
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  LayoutPanel,
  HStack,
  VStack,
} from '@astryxdesign/core/Layout';
import { KeyCap } from './KeyHint';
import { actionLabel } from '../lib/actionLabel';
import { prefixError } from '../lib/prefixKey';

interface Props {
  config: ClientConfig;
  send: (message: ClientMessage) => void;
}

type Draft = {
  prefix: string;
  shell: string;
  appearance: ClientConfig['appearance'];
  colorsDark: string;
  colorsLight: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  animations: boolean;
  showPaneTitles: boolean;
  sessionSort: ClientConfig['session_sort'];
  windowSort: ClientConfig['window_sort'];
  editor: ClientConfig['editor'];
  windowGridCount: number;
  binds: Record<string, string>;
  keyOverrides: Record<string, string>;
  cursorBlink: boolean;
  scrollback: number;
  allowTransparency: boolean;
  disableStdin: boolean;
  smoothScrollDuration: number;
  cursorAnimationDuration: number;
  cellBackgroundOpacity: number;
  consoleLevel: string;
  fileLevel: string;
  osNotifications: boolean;
  osNotificationLevel: ClientConfig['notifications']['os-level'];
  wallpaper: string;
  wallpaperShaders: ShaderLayer[];
  wallpaperOpacity: number;
  desktopBackgroundOpacity: number;
  wallpaperBlur: number;
  wallpaperSaturate: number;
  wallpaperSpeed: number;
  wallpaperFps: number;
  wallpaperResolution: number;
  wallpaperFollowsMouse: boolean;
  wallpaperFollowsKeyboard: boolean;
  backdropBlur: number;
  backdropDim: number;
  paneSwitchBorderStyle: string;
  paneSwitchBorderSpeed: number;
};

type DraftKey = keyof Draft;

// Shell choices that aren't commands.
const SHELL_DEFAULT = ':default';
const SHELL_CUSTOM = ':custom';
const FONT_CUSTOM = ':custom';
// Typed font names preview after a pause: each change rebuilds terminals.
const FONT_PREVIEW_DEBOUNCE_MS = 500;
type ConfigUpdate = Extract<ClientMessage, { type: 'update_config' }>['update'];

function initialDraft(config: ClientConfig): Draft {
  return {
    prefix: config.prefix,
    shell: config.shell ?? '',
    appearance: config.appearance,
    colorsDark: config.colors_dark ?? '',
    colorsLight: config.colors_light ?? '',
    fontFamily: getTerminalFontFamily(config),
    fontWeight: getTerminalFontWeight(config),
    fontSize: getTerminalFontSize(config),
    animations: config.animations,
    showPaneTitles: getShowPaneTitles(config),
    sessionSort: config.session_sort,
    windowSort: config.window_sort,
    editor: config.editor,
    windowGridCount: config.window_grid_count,
    binds: Object.fromEntries(config.binds.map((bind) => [bind.action, bind.key])),
    keyOverrides: config.keys,
    cursorBlink: config.terminal.cursorBlink ?? true,
    scrollback: config.terminal.scrollback ?? 100_000,
    allowTransparency:
      config.terminal.allowTransparency ?? (config.wallpaper != null || hasShaderWallpaper(config.wallpaper_shaders)),
    disableStdin: config.terminal.disableStdin ?? false,
    smoothScrollDuration: config.terminal.smoothScrollDuration ?? 120,
    cursorAnimationDuration: config.terminal.cursorAnimationDuration ?? 120,
    cellBackgroundOpacity: config.terminal.cellBackgroundOpacity ?? 1,
    consoleLevel: config.log['console-level'],
    fileLevel: config.log['file-level'],
    osNotifications: config.notifications.os,
    osNotificationLevel: config.notifications['os-level'],
    wallpaper: config.wallpaper ?? '',
    wallpaperShaders: config.wallpaper_shaders,
    wallpaperOpacity: getWallpaperOpacity(config),
    desktopBackgroundOpacity: getDesktopBackgroundOpacity(config),
    wallpaperBlur: getWallpaperBlur(config),
    wallpaperSaturate: getWallpaperSaturate(config),
    wallpaperSpeed: getWallpaperSpeed(config),
    wallpaperFps: getWallpaperFps(config),
    wallpaperResolution: getWallpaperResolution(config),
    wallpaperFollowsMouse: getWallpaperFollowsMouse(config),
    wallpaperFollowsKeyboard: getWallpaperFollowsKeyboard(config),
    backdropBlur: getBackdropBlur(config),
    backdropDim: getBackdropDim(config),
    paneSwitchBorderStyle: config.pane_switch_border ?? 'none',
    paneSwitchBorderSpeed: getPaneSwitchBorderSpeed(config),
  };
}

/** Fixed-width slider value, so every track in the form has the same length. */
function formatSliderValue(value: number, step: number): string {
  const decimals = Math.min(2, step < 1 ? (String(step).split('.')[1]?.length ?? 0) : 0);
  // Figure spaces are digit-wide and don't collapse.
  return value.toFixed(decimals).padStart(5, '\u2007');
}

function quote(value: string): string {
  return JSON.stringify(value);
}

// Mirrors the built-in defaults in `src/config.rs` (the `DEFAULT_*` constants
// and each struct's `Default` impl). Kept separate from `CONFIG_DEFAULTS`
// (frontend fallbacks for a not-yet-loaded config) since a couple of fields
// here have no wire-level equivalent (log levels).
const TOML_DEFAULTS = {
  prefix: 'C-a',
  animations: true,
  showPaneTitles: false,
  sessionSort: 'mru',
  windowSort: 'alphabetical',
  editor: 'neovim',
  windowGridCount: 4,
  appearance: 'auto',
  wallpaperOpacity: 0.1,
  desktopBackgroundOpacity: 0.95,
  wallpaperBlur: 0,
  wallpaperSaturate: 0.05,
  wallpaperSpeed: 0.2,
  wallpaperFps: 30,
  wallpaperResolution: 0.4,
  wallpaperFollowsMouse: true,
  wallpaperFollowsKeyboard: false,
  backdropBlur: 2,
  backdropDim: 0.5,
  paneSwitchBorderStyle: 'wipe',
  paneSwitchBorderSpeed: 0.15,
  cursorBlink: true,
  scrollback: 100_000,
  fontFamily: 'Geist Mono',
  fontSize: 18,
  fontWeight: 300,
  disableStdin: false,
  smoothScrollDuration: 120,
  cursorAnimationDuration: 120,
  cellBackgroundOpacity: 1,
  consoleLevel: 'warn',
  fileLevel: 'info',
  osNotifications: true,
  osNotificationLevel: 'attention',
} as const;

function optLine(name: string, value: string): string | null {
  return value ? `${name} = ${quote(value)}` : null;
}

function strLine(name: string, value: string, fallback: string): string | null {
  return value === fallback ? null : `${name} = ${quote(value)}`;
}

function boolLine(name: string, value: boolean, fallback: boolean): string | null {
  return value === fallback ? null : `${name} = ${value}`;
}

function intLine(name: string, value: number, fallback: number): string | null {
  return value === fallback ? null : `${name} = ${value}`;
}

function numLine(name: string, value: number, fallback: number, decimals: number): string | null {
  const formatted = value.toFixed(decimals);
  return formatted === fallback.toFixed(decimals) ? null : `${name} = ${formatted}`;
}

function toToml(draft: Draft): string {
  const keyLines = Object.entries(draft.keyOverrides)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([action, key]) => `${action} = ${quote(key)}`);

  // `allow-transparency` has no fixed default: an unset value inherits
  // whichever behavior a wallpaper being present would already imply.
  const defaultAllowTransparency = draft.wallpaper !== '' || hasShaderWallpaper(draft.wallpaperShaders);

  const topLines = [
    strLine('prefix', draft.prefix, TOML_DEFAULTS.prefix),
    draft.shell ? `shell = ${quote(draft.shell)}` : null,
    boolLine('animations', draft.animations, TOML_DEFAULTS.animations),
    boolLine('show-pane-titles', draft.showPaneTitles, TOML_DEFAULTS.showPaneTitles),
    strLine('session-sort', draft.sessionSort, TOML_DEFAULTS.sessionSort),
    strLine('window-sort', draft.windowSort, TOML_DEFAULTS.windowSort),
    strLine('editor', draft.editor, TOML_DEFAULTS.editor),
    intLine('window-grid-count', draft.windowGridCount, TOML_DEFAULTS.windowGridCount),
    strLine('appearance', draft.appearance, TOML_DEFAULTS.appearance),
    optLine('colors-dark', draft.colorsDark),
    optLine('colors-light', draft.colorsLight),
    optLine('wallpaper', draft.wallpaper),
    numLine('wallpaper-opacity', draft.wallpaperOpacity, TOML_DEFAULTS.wallpaperOpacity, 2),
    numLine('desktop-background-opacity', draft.desktopBackgroundOpacity, TOML_DEFAULTS.desktopBackgroundOpacity, 2),
    numLine('wallpaper-blur', draft.wallpaperBlur, TOML_DEFAULTS.wallpaperBlur, 1),
    numLine('wallpaper-saturate', draft.wallpaperSaturate, TOML_DEFAULTS.wallpaperSaturate, 2),
    numLine('wallpaper-speed', draft.wallpaperSpeed, TOML_DEFAULTS.wallpaperSpeed, 2),
    intLine('wallpaper-fps', draft.wallpaperFps, TOML_DEFAULTS.wallpaperFps),
    numLine('wallpaper-resolution', draft.wallpaperResolution, TOML_DEFAULTS.wallpaperResolution, 2),
    boolLine('wallpaper-shader-follows-mouse-cursor', draft.wallpaperFollowsMouse, TOML_DEFAULTS.wallpaperFollowsMouse),
    boolLine(
      'wallpaper-shader-follows-keyboard-input',
      draft.wallpaperFollowsKeyboard,
      TOML_DEFAULTS.wallpaperFollowsKeyboard,
    ),
    numLine('backdrop-blur', draft.backdropBlur, TOML_DEFAULTS.backdropBlur, 1),
    numLine('backdrop-dim', draft.backdropDim, TOML_DEFAULTS.backdropDim, 2),
    strLine('pane-switch-border', draft.paneSwitchBorderStyle, TOML_DEFAULTS.paneSwitchBorderStyle),
    numLine('pane-switch-border-speed', draft.paneSwitchBorderSpeed, TOML_DEFAULTS.paneSwitchBorderSpeed, 2),
  ].filter((line): line is string => line !== null);

  const terminalLines = [
    boolLine('cursor-blink', draft.cursorBlink, TOML_DEFAULTS.cursorBlink),
    intLine('scrollback', draft.scrollback, TOML_DEFAULTS.scrollback),
    strLine('font-family', draft.fontFamily.trim(), TOML_DEFAULTS.fontFamily),
    numLine('font-size', draft.fontSize, TOML_DEFAULTS.fontSize, 1),
    intLine('font-weight', draft.fontWeight, TOML_DEFAULTS.fontWeight),
    boolLine('allow-transparency', draft.allowTransparency, defaultAllowTransparency),
    boolLine('disable-stdin', draft.disableStdin, TOML_DEFAULTS.disableStdin),
    numLine('smooth-scroll-duration', draft.smoothScrollDuration, TOML_DEFAULTS.smoothScrollDuration, 1),
    numLine('cursor-animation-duration', draft.cursorAnimationDuration, TOML_DEFAULTS.cursorAnimationDuration, 1),
    numLine('cell-background-opacity', draft.cellBackgroundOpacity, TOML_DEFAULTS.cellBackgroundOpacity, 2),
  ].filter((line): line is string => line !== null);

  const logLines = [
    strLine('console-level', draft.consoleLevel, TOML_DEFAULTS.consoleLevel),
    strLine('file-level', draft.fileLevel, TOML_DEFAULTS.fileLevel),
  ].filter((line): line is string => line !== null);

  const notificationLines = [
    boolLine('os', draft.osNotifications, TOML_DEFAULTS.osNotifications),
    strLine('os-level', draft.osNotificationLevel, TOML_DEFAULTS.osNotificationLevel),
  ].filter((line): line is string => line !== null);

  const sections = [
    ['# Settings generated by btmux', ...topLines],
    wallpaperLayersToml(draft.wallpaperShaders),
    keyLines.length ? ['[keys]', ...keyLines] : [],
    terminalLines.length ? ['[terminal]', ...terminalLines] : [],
    logLines.length ? ['[log]', ...logLines] : [],
    notificationLines.length ? ['[notifications]', ...notificationLines] : [],
  ].filter((section) => section.length > 0);

  return sections.map((section) => section.join('\n')).join('\n\n');
}

function toConfigUpdate(draft: Draft, dirty: Set<DraftKey>): ConfigUpdate {
  const update: ConfigUpdate = {};
  if (dirty.has('prefix')) update.prefix = draft.prefix;
  if (dirty.has('shell')) update.shell = draft.shell;
  if (dirty.has('showPaneTitles')) update.show_pane_titles = draft.showPaneTitles;
  if (dirty.has('sessionSort')) update.session_sort = draft.sessionSort;
  if (dirty.has('windowSort')) update.window_sort = draft.windowSort;
  if (dirty.has('editor')) update.editor = draft.editor;
  if (dirty.has('windowGridCount')) update.window_grid_count = draft.windowGridCount;
  if (dirty.has('binds')) update.keys = draft.keyOverrides;
  if (dirty.has('appearance')) update.appearance = draft.appearance;
  if (dirty.has('colorsDark')) update.colors_dark = draft.colorsDark;
  if (dirty.has('colorsLight')) update.colors_light = draft.colorsLight;
  if (dirty.has('fontFamily')) update.font_family = draft.fontFamily.trim();
  if (dirty.has('fontWeight')) update.font_weight = draft.fontWeight;
  if (dirty.has('fontSize')) update.font_size = draft.fontSize;
  if (dirty.has('cursorBlink')) update.cursor_blink = draft.cursorBlink;
  if (dirty.has('scrollback')) update.scrollback = draft.scrollback;
  if (dirty.has('allowTransparency')) update.allow_transparency = draft.allowTransparency;
  if (dirty.has('disableStdin')) update.disable_stdin = draft.disableStdin;
  if (dirty.has('smoothScrollDuration')) update.smooth_scroll_duration = draft.smoothScrollDuration;
  if (dirty.has('cursorAnimationDuration')) update.cursor_animation_duration = draft.cursorAnimationDuration;
  if (dirty.has('cellBackgroundOpacity')) update.cell_background_opacity = draft.cellBackgroundOpacity;
  if (dirty.has('animations')) update.animations = draft.animations;
  if (dirty.has('consoleLevel')) update.console_level = draft.consoleLevel;
  if (dirty.has('fileLevel')) update.file_level = draft.fileLevel;
  if (dirty.has('osNotifications')) update.os_notifications = draft.osNotifications;
  if (dirty.has('osNotificationLevel')) update.os_notification_level = draft.osNotificationLevel;
  if (dirty.has('wallpaper')) update.wallpaper = draft.wallpaper;
  if (dirty.has('wallpaperShaders')) update.wallpaper_shaders = draft.wallpaperShaders;
  if (dirty.has('wallpaperOpacity')) update.wallpaper_opacity = draft.wallpaperOpacity;
  if (dirty.has('desktopBackgroundOpacity')) update.desktop_background_opacity = draft.desktopBackgroundOpacity;
  if (dirty.has('wallpaperBlur')) update.wallpaper_blur = draft.wallpaperBlur;
  if (dirty.has('wallpaperSaturate')) update.wallpaper_saturate = draft.wallpaperSaturate;
  if (dirty.has('wallpaperSpeed')) update.wallpaper_speed = draft.wallpaperSpeed;
  if (dirty.has('wallpaperFps')) update.wallpaper_fps = draft.wallpaperFps;
  if (dirty.has('wallpaperResolution')) update.wallpaper_resolution = draft.wallpaperResolution;
  if (dirty.has('wallpaperFollowsMouse')) {
    update.wallpaper_shader_follows_mouse_cursor = draft.wallpaperFollowsMouse;
  }
  if (dirty.has('wallpaperFollowsKeyboard')) {
    update.wallpaper_shader_follows_keyboard_input = draft.wallpaperFollowsKeyboard;
  }
  if (dirty.has('backdropBlur')) update.backdrop_blur = draft.backdropBlur;
  if (dirty.has('backdropDim')) update.backdrop_dim = draft.backdropDim;
  if (dirty.has('paneSwitchBorderStyle')) update.pane_switch_border = draft.paneSwitchBorderStyle;
  if (dirty.has('paneSwitchBorderSpeed')) update.pane_switch_border_speed = draft.paneSwitchBorderSpeed;
  return update;
}

const COLORS_KEY = { dark: 'colorsDark', light: 'colorsLight' } as const satisfies Record<ColorMode, DraftKey>;

function previewTheme(config: ClientConfig, draft: Draft, dirty: Set<DraftKey>) {
  const mode = draft.appearance === 'auto' ? systemColorMode() : draft.appearance;
  const resolved = mode === 'dark' ? config.dark_theme : config.light_theme;
  const key = COLORS_KEY[mode];
  if (!dirty.has(key)) return resolved;
  return config.color_scheme_themes[draft[key] || DEFAULT_COLOR_SCHEMES[mode]] ?? resolved;
}

const TAB_LABELS = {
  general: 'General',
  notifications: 'Notifications',
  keybinds: 'Key binds',
  logging: 'Logging',
  wallpaper: 'Wallpaper',
  terminal: 'Terminal',
  effects: 'Effects',
};
type SettingsTab = keyof typeof TAB_LABELS;

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** A binding shown as its key cap; click it, then press the new key. Escape cancels. */
function KeyBindField({ label, value, onChange }: { label: string; value: string; onChange: (key: string) => void }) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    // Window capture runs before the keybinding hook and the dialog's Escape handling.
    const onKeyDown = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key !== 'Escape') onChange(e.key);
      setRecording(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, onChange]);

  return (
    <HStack gap={3} vAlign="center" hAlign="between" className="min-w-0">
      <Text>{label}</Text>
      <Button
        label={recording ? `Press a key for ${label}` : `Change key for ${label}`}
        size="sm"
        variant={recording ? 'primary' : 'ghost'}
        onClick={() => setRecording((current) => !current)}
        onBlur={() => setRecording(false)}
      >
        {recording ? 'Press a key…' : value ? <KeyCap keys={value} /> : 'Unbound'}
      </Button>
    </HStack>
  );
}

export function ConfigPage({ config, send }: Props) {
  const isNarrow = useMediaQuery('(max-width: 767px)');
  const [tab, setTab] = useState<SettingsTab>('general');
  const setConfigPreview = useStore((state) => state.setConfigPreview);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const toast = useToast();
  const [draft, setDraft] = useState(() => initialDraft(config));
  const [customShell, setCustomShell] = useState(false);
  const [customFont, setCustomFont] = useState(false);
  const [typedFont, setTypedFont] = useState(draft.fontFamily);
  const wallpaperCheck = useWallpaperCheck(draft.wallpaper);
  const [dirty, setDirty] = useState<Set<DraftKey>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const [showToml, setShowToml] = useState(false);
  const [clearBackdrop, setClearBackdrop] = useState(false);
  const toml = useMemo(() => toToml(draft), [draft]);

  const knownFont = config.fonts.some((font) => font.family === draft.fontFamily);
  const fontChoice = customFont || !knownFont ? FONT_CUSTOM : draft.fontFamily;
  const fontInvalid =
    fontChoice === FONT_CUSTOM && draft.fontFamily.trim() === '' ? 'Enter the name of an installed font.' : null;
  useEffect(() => {
    const timer = setTimeout(() => setTypedFont(draft.fontFamily.trim()), FONT_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft.fontFamily]);
  const previewFont = fontChoice === FONT_CUSTOM ? typedFont || getTerminalFontFamily(config) : draft.fontFamily;

  const previewConfig = useMemo<ClientConfig>(
    () => ({
      ...config,
      theme: previewTheme(config, draft, dirty),
      animations: draft.animations,
      show_pane_titles: draft.showPaneTitles,
      terminal: {
        ...config.terminal,
        cursorBlink: draft.cursorBlink,
        scrollback: draft.scrollback,
        fontFamily: previewFont,
        fontSize: draft.fontSize,
        fontWeight: draft.fontWeight,
        // Keep null until the user changes this control so a wallpaper can
        // still enable terminal transparency through its normal default.
        allowTransparency: dirty.has('allowTransparency') ? draft.allowTransparency : config.terminal.allowTransparency,
        disableStdin: dirty.has('disableStdin') ? draft.disableStdin : config.terminal.disableStdin,
        smoothScrollDuration: dirty.has('smoothScrollDuration')
          ? draft.smoothScrollDuration
          : config.terminal.smoothScrollDuration,
        cursorAnimationDuration: dirty.has('cursorAnimationDuration')
          ? draft.cursorAnimationDuration
          : config.terminal.cursorAnimationDuration,
        cellBackgroundOpacity: draft.cellBackgroundOpacity,
      },
      wallpaper: draft.wallpaper || null,
      // An edited wallpaper previews once checked, through the same proxy as applied ones.
      wallpaper_url: draft.wallpaper === (config.wallpaper ?? '') ? config.wallpaper_url : wallpaperCheck.url,
      wallpaper_shaders: draft.wallpaperShaders,
      wallpaper_opacity: draft.wallpaperOpacity,
      desktop_background_opacity: draft.desktopBackgroundOpacity,
      wallpaper_blur: draft.wallpaperBlur,
      wallpaper_saturate: draft.wallpaperSaturate,
      wallpaper_speed: draft.wallpaperSpeed,
      wallpaper_fps: draft.wallpaperFps,
      wallpaper_resolution: draft.wallpaperResolution,
      wallpaper_shader_follows_mouse_cursor: draft.wallpaperFollowsMouse,
      wallpaper_shader_follows_keyboard_input: draft.wallpaperFollowsKeyboard,
      backdrop_blur: draft.backdropBlur,
      backdrop_dim: draft.backdropDim,
      pane_switch_border: draft.paneSwitchBorderStyle || null,
      pane_switch_border_speed: draft.paneSwitchBorderSpeed,
    }),
    [config, draft, dirty, wallpaperCheck.url, previewFont],
  );

  // The active session consumes this local layer directly, so draft changes
  // update its real terminals without a control-socket round trip.
  useEffect(() => {
    setConfigPreview(previewConfig);
  }, [previewConfig, setConfigPreview]);
  useEffect(() => () => setConfigPreview(null), [setConfigPreview]);

  // Config broadcasts are authoritative. This also refreshes the local draft
  // after reset, when the server replaces session-only overrides with the
  // values resolved from config.toml and built-in defaults.
  useEffect(() => {
    setDraft(initialDraft(config));
    setDirty(new Set());
    setCustomShell(false);
    setCustomFont(false);
  }, [config]);

  const update = <K extends DraftKey>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty((current) => new Set(current).add(key));
  };

  const knownShell = draft.shell === '' || config.shells.some((shell) => shell.command === draft.shell);
  const shellChoice = customShell || !knownShell ? SHELL_CUSTOM : draft.shell || SHELL_DEFAULT;
  const chooseShell = (value: string) => {
    setCustomShell(value === SHELL_CUSTOM);
    if (value !== SHELL_CUSTOM) update('shell', value === SHELL_DEFAULT ? '' : value);
  };

  const chooseFont = (value: string) => {
    setCustomFont(value === FONT_CUSTOM);
    if (value === FONT_CUSTOM) return;
    const { min, max } = getFontWeightRange(config.fonts, value);
    update('fontFamily', value);
    update('fontWeight', Math.min(max, Math.max(min, draft.fontWeight)));
  };

  const prefixInvalid = dirty.has('prefix') && draft.prefix.trim() !== '' ? prefixError(draft.prefix) : null;

  const apply = () => {
    if (prefixInvalid || fontInvalid) return;
    const update = toConfigUpdate(draft, dirty);
    if (Object.keys(update).length === 0) return;
    send({ type: 'update_config', update });
    setDirty(new Set());
    toast({ body: 'Applied until restart' });
    setSettingsOpen(false);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(toml);
    setCopied(true);
    toast({ body: 'Settings copied to clipboard' });
    window.setTimeout(() => setCopied(false), 1600);
  };

  const reset = () => {
    send({ type: 'reset_config' });
    setDirty(new Set());
    toast({ body: 'Settings reset to config.toml and defaults' });
  };

  const { min: weightMin, max: weightMax } = getFontWeightRange(config.fonts, draft.fontFamily);

  const bindingRows = [...new Map(config.binds.map((bind) => [bind.action, bind])).values()].sort((left, right) =>
    left.action.localeCompare(right.action),
  );

  const goBack = () => setSettingsOpen(false);
  const [osPermission, setOsPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  const toggle = (
    key: { [K in DraftKey]: Draft[K] extends boolean ? K : never }[DraftKey],
    label: string,
    description?: string,
  ) => (
    <Switch
      key={key}
      label={label}
      description={description}
      value={draft[key]}
      onChange={(value) => update(key, value)}
      labelPosition="start"
      labelSpacing="spread"
    />
  );
  const text = (
    key: { [K in DraftKey]: Draft[K] extends string ? K : never }[DraftKey],
    label: string,
    description?: string,
    /** An error message, or a full status. */
    status?: string | WallpaperStatus | null,
  ) => (
    <TextInput
      key={key}
      label={label}
      value={draft[key]}
      onChange={(value) => update(key, value as never)}
      description={description}
      status={typeof status === 'string' ? { type: 'error', message: status } : (status ?? undefined)}
    />
  );
  const range = (
    key: { [K in DraftKey]: Draft[K] extends number ? K : never }[DraftKey],
    label: string,
    min: number,
    max: number,
    step = 1,
    isDisabled = false,
  ) => (
    <Slider
      key={key}
      label={label}
      value={draft[key]}
      min={min}
      max={max}
      step={step}
      onChange={(value: number) => update(key, value)}
      valueDisplay="text"
      formatValue={(value) => formatSliderValue(value, step)}
      isDisabled={isDisabled}
    />
  );
  const choose = (
    key: { [K in DraftKey]: Draft[K] extends string ? K : never }[DraftKey],
    label: string,
    options: { value: string; label: string; description?: string }[],
    description?: string,
  ) => (
    <Selector
      key={key}
      label={label}
      description={description}
      value={draft[key] || 'none'}
      options={options}
      onChange={(value) => update(key, (value === 'none' ? '' : value) as never)}
      presentation="adaptive"
    />
  );
  const none = { value: 'none', label: 'None' };
  const ordering = [
    { value: 'created', label: 'Created' },
    { value: 'mru', label: 'Recently used' },
    { value: 'alphabetical', label: 'Alphabetical' },
  ];
  const paneBorderOff = !draft.paneSwitchBorderStyle || draft.paneSwitchBorderStyle === 'none';

  const tomlPanel = (
    <LayoutPanel
      width={isNarrow ? '100%' : '50%'}
      padding={0}
      hasDivider={!isNarrow}
      isScrollable={false}
      role="region"
      label="Generated TOML"
      className={isNarrow ? 'h-64 border-t border-border' : 'h-full'}
    >
      <Layout
        padding={6}
        header={
          <LayoutHeader>
            <Text weight="medium">Generated TOML</Text>
          </LayoutHeader>
        }
        content={
          <LayoutContent isScrollable={false} className="[&>.astryx-field]:h-full">
            <TextArea
              label="Generated TOML"
              isLabelHidden
              value={toml}
              isReadOnly
              hasSpellCheck={false}
              statusVariant="detached"
              className="h-full [&_textarea]:h-full [&_textarea]:resize-none [&_textarea]:font-mono"
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <Button label={copied ? 'Copied' : 'Copy TOML'} clickAction={copy} />
          </LayoutFooter>
        }
      />
    </LayoutPanel>
  );

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) goBack();
      }}
      purpose="form"
      width={showToml ? 1200 : 640}
      maxHeight="90dvh"
      className={clearBackdrop ? 'h-full btm-clear-backdrop' : 'h-full'}
    >
      <Layout
        header={
          <DialogHeader
            title="Settings"
            hasDivider={false}
            onOpenChange={(open) => {
              if (!open) goBack();
            }}
          />
        }
        end={showToml && !isNarrow ? tomlPanel : undefined}
        footer={showToml && isNarrow ? tomlPanel : undefined}
        content={
          <Layout
            header={
              <LayoutHeader paddingBlockEnd={0}>
                <TabList
                  value={tab}
                  onChange={(value) => setTab(value as SettingsTab)}
                  role="tablist"
                  hasDivider
                  isFullBleed
                >
                  {(Object.keys(TAB_LABELS) as SettingsTab[]).map((value) => (
                    <Tab key={value} value={value} label={TAB_LABELS[value]} panelId={`settings-${value}`} />
                  ))}
                </TabList>
              </LayoutHeader>
            }
            content={
              <LayoutContent padding={6}>
                <VStack gap={8}>
                  {tab === 'general' && (
                    <VStack gap={4} id="settings-general" role="tabpanel" aria-label={TAB_LABELS.general}>
                      <FormLayout>
                        {choose(
                          'appearance',
                          'Appearance',
                          APPEARANCES.map(({ value, label }) => ({ value, label })),
                          'Auto follows the system setting.',
                        )}
                        {(['dark', 'light'] as const).map((mode) => (
                          <Selector
                            key={mode}
                            label={mode === 'dark' ? 'Dark color scheme' : 'Light color scheme'}
                            value={draft[COLORS_KEY[mode]] || DEFAULT_COLOR_SCHEMES[mode]}
                            hasSearch
                            presentation="adaptive"
                            options={config.color_schemes.map((value) => ({
                              value,
                              label: colorSchemeLabel(value),
                            }))}
                            onChange={(value) => update(COLORS_KEY[mode], value)}
                          />
                        ))}
                        <Selector
                          label="Terminal font"
                          description="Also used for paths, names, and key hints in the UI."
                          value={fontChoice}
                          presentation="adaptive"
                          options={[
                            {
                              type: 'section',
                              title: 'Bundled',
                              options: config.fonts.map((font) => ({ value: font.family, label: font.family })),
                            },
                            { type: 'section', title: 'Custom', options: [{ value: FONT_CUSTOM, label: 'Custom…' }] },
                          ]}
                          onChange={chooseFont}
                        />
                        {fontChoice === FONT_CUSTOM &&
                          text('fontFamily', 'Font family', 'A font installed on this device.', fontInvalid)}
                        {text(
                          'prefix',
                          'Prefix key',
                          'Use tmux notation such as C-a, C-b, M-x, or C-Space.',
                          prefixInvalid,
                        )}
                        <Selector
                          label="Shell for new panes"
                          value={config.cli_shell ?? shellChoice}
                          presentation="adaptive"
                          isDisabled={config.cli_shell != null}
                          disabledMessage="Set by btmux --shell."
                          options={
                            config.cli_shell != null
                              ? [{ value: config.cli_shell, label: config.cli_shell }]
                              : [
                                  { value: SHELL_DEFAULT, label: `Default (${config.default_shell})` },
                                  ...config.shells.map((shell) => ({
                                    value: shell.command,
                                    label: shell.label,
                                    description: shell.command,
                                  })),
                                  { type: 'divider' as const },
                                  { value: SHELL_CUSTOM, label: 'Custom…' },
                                ]
                          }
                          onChange={chooseShell}
                        />
                        {config.cli_shell == null &&
                          shellChoice === SHELL_CUSTOM &&
                          text('shell', 'Shell command', 'A program, with arguments on Windows (wsl.exe -d Ubuntu).')}
                        {toggle('animations', 'Animations')}
                        {toggle(
                          'showPaneTitles',
                          'Show pane titles',
                          'Title bar with command, directory, and size above each pane.',
                        )}
                        {choose('sessionSort', 'Session sort', ordering)}
                        {choose('windowSort', 'Window sort', ordering)}
                        {choose(
                          'editor',
                          'Editor',
                          [
                            {
                              value: 'neovim',
                              label: 'Neovim',
                              description:
                                "Run headless Neovim with btmux's built-in GUI. Injects config for theming and UI. (Requires Neovim 0.12+ on PATH.)",
                            },
                            {
                              value: 'vscode',
                              label: 'VS Code',
                              description:
                                'Run headless VS Code (code serve-web). Injects an extension to sync theme and font. (Requires VS Code.)',
                            },
                            {
                              value: 'pane',
                              label: 'Terminal',
                              description: 'Run $EDITOR in the pane.',
                            },
                          ],
                          'Opens with prefix + e, or from the file browser and Git mode.',
                        )}
                        <NumberInput
                          label="Window grid count"
                          value={draft.windowGridCount}
                          min={1}
                          max={24}
                          isIntegerOnly
                          onChange={(value) => update('windowGridCount', value)}
                        />
                        {range('desktopBackgroundOpacity', 'Desktop background opacity', 0, 1, 0.01)}
                      </FormLayout>
                    </VStack>
                  )}
                  {tab === 'terminal' && (
                    <VStack gap={4} id="settings-terminal" role="tabpanel" aria-label={TAB_LABELS.terminal}>
                      <FormLayout>
                        {range('fontSize', 'Terminal font size', 8, 36)}
                        {range('fontWeight', 'Terminal font weight', weightMin, weightMax, 100)}
                        {toggle('cursorBlink', 'Blinking cursor')}
                        <NumberInput
                          label="Scrollback lines"
                          value={draft.scrollback}
                          min={1}
                          max={1_000_000}
                          isIntegerOnly
                          onChange={(value) => update('scrollback', value)}
                        />
                        {toggle('allowTransparency', 'Allow transparency')}
                        {toggle('disableStdin', 'Disable terminal input')}
                        {range('smoothScrollDuration', 'Smooth scroll duration (ms)', 0, 500, 10)}
                        {range('cursorAnimationDuration', 'Cursor animation duration (ms)', 0, 500, 10)}
                        {range('cellBackgroundOpacity', 'Cell background opacity', 0, 1, 0.05)}
                      </FormLayout>
                    </VStack>
                  )}
                  {tab === 'wallpaper' && (
                    <VStack gap={4} id="settings-wallpaper" role="tabpanel" aria-label={TAB_LABELS.wallpaper}>
                      <FormLayout>
                        {text(
                          'wallpaper',
                          'Wallpaper URL or path',
                          'Drawn beneath the shader layers.',
                          wallpaperCheck.status,
                        )}
                        {range('wallpaperOpacity', 'Wallpaper opacity', 0, 1, 0.01)}
                        {range('wallpaperBlur', 'Wallpaper blur', 0, 40, 0.5)}
                        {range('wallpaperSaturate', 'Wallpaper saturation', 0, 3, 0.05)}
                        {range('wallpaperSpeed', 'Wallpaper speed', 0, 10, 0.05)}
                        {range('wallpaperFps', 'Wallpaper frame rate', 10, 60, 1)}
                        {range('wallpaperResolution', 'Wallpaper resolution', 0.1, 1, 0.05)}
                        {toggle('wallpaperFollowsMouse', 'Follow mouse cursor')}
                        {toggle(
                          'wallpaperFollowsKeyboard',
                          'Follow keyboard input',
                          'Drives interactive effects from the active terminal cursor.',
                        )}
                      </FormLayout>
                      <ShaderLayerStack
                        layers={draft.wallpaperShaders}
                        onChange={(layers) => update('wallpaperShaders', layers)}
                      />
                    </VStack>
                  )}
                  {tab === 'effects' && (
                    <VStack gap={4} id="settings-effects" role="tabpanel" aria-label={TAB_LABELS.effects}>
                      <FormLayout>
                        {range('backdropBlur', 'Modal backdrop blur (px)', 0, 40, 0.5)}
                        {range('backdropDim', 'Modal backdrop dimming', 0, 1, 0.05)}
                        {choose('paneSwitchBorderStyle', 'Pane switch border animation', [
                          none,
                          ...PANE_BORDER_STYLES.map((item) => ({ value: item.id, label: item.label })),
                        ])}
                        {range('paneSwitchBorderSpeed', 'Border duration (s)', 0.05, 1, 0.01, paneBorderOff)}
                      </FormLayout>
                    </VStack>
                  )}
                  {tab === 'keybinds' && (
                    <VStack gap={4} id="settings-keybinds" role="tabpanel" aria-label={TAB_LABELS.keybinds}>
                      <FormLayout>
                        {bindingRows.map((bind) => (
                          <KeyBindField
                            key={bind.action}
                            label={actionLabel(bind.action)}
                            value={draft.binds[bind.action] ?? bind.key}
                            onChange={(key) => {
                              setDraft((current) => ({
                                ...current,
                                binds: { ...current.binds, [bind.action]: key },
                                keyOverrides: { ...current.keyOverrides, [bind.action]: key },
                              }));
                              setDirty((current) => new Set(current).add('binds'));
                            }}
                          />
                        ))}
                      </FormLayout>
                    </VStack>
                  )}
                  {tab === 'notifications' && (
                    <VStack gap={4} id="settings-notifications" role="tabpanel" aria-label={TAB_LABELS.notifications}>
                      <FormLayout>
                        {toggle('osNotifications', 'OS notifications', 'Alert while btmux is hidden or unfocused.')}
                        {choose('osNotificationLevel', 'Minimum level', [
                          { value: 'info', label: 'Info and above' },
                          { value: 'success', label: 'Success and above' },
                          { value: 'attention', label: 'Attention and error' },
                          { value: 'error', label: 'Errors only' },
                        ])}
                      </FormLayout>
                      {osPermission === 'default' ? (
                        <HStack gap={2} vAlign="center">
                          <Text color="secondary">This browser has not allowed notifications yet.</Text>
                          <Button
                            label="Allow"
                            onClick={() => void Notification.requestPermission().then(setOsPermission)}
                          />
                        </HStack>
                      ) : osPermission === 'denied' ? (
                        <Text color="secondary">Blocked; allow in site settings.</Text>
                      ) : osPermission === 'unsupported' ? (
                        <Text color="secondary">This browser does not support notifications.</Text>
                      ) : null}
                    </VStack>
                  )}
                  {tab === 'logging' && (
                    <VStack gap={4} id="settings-logging" role="tabpanel" aria-label={TAB_LABELS.logging}>
                      <Text color="secondary">
                        Use error, warn, info, debug, trace, or a tracing directive. Applies after restart.
                      </Text>
                      <FormLayout>
                        {text('consoleLevel', 'Console level')}
                        {text('fileLevel', 'File level')}
                      </FormLayout>
                    </VStack>
                  )}
                </VStack>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <HStack gap={2} wrap="wrap" hAlign="between">
                  <HStack gap={4} wrap="wrap">
                    <Button label="Reset" onClick={reset} />
                    <Switch label="Show TOML" value={showToml} onChange={setShowToml} />
                    <Switch label="Clear background" value={clearBackdrop} onChange={setClearBackdrop} />
                  </HStack>
                  <HStack gap={2} wrap="wrap">
                    <Button label="Close" onClick={goBack} />
                    <Button
                      label="Apply"
                      variant="primary"
                      onClick={apply}
                      isDisabled={dirty.size === 0 || !!prefixInvalid || !!fontInvalid}
                    />
                  </HStack>
                </HStack>
              </LayoutFooter>
            }
          />
        }
      />
    </Dialog>
  );
}
