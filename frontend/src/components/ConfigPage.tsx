import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@astryxdesign/core/Toast';
import type { ClientMessage } from '../protocol/messages';
import type { ClientConfig } from '../state/types';
import { SHADER_EFFECTS, PANE_SWITCH_EFFECTS } from '../lib/terminalFxShaders';
import { PANE_BORDER_STYLES } from '../lib/paneSwitchBorder';
import { WALLPAPER_SHADERS } from '../lib/wallpaperCatalog';
import { DEFAULT_THEME } from '../state/defaultTheme';
import {
  getDesktopBackgroundOpacity,
  getFontWeightRange,
  getPaneSwitchBorderSpeed,
  getPaneSwitchDuration,
  getPaneSwitchIntensity,
  getShowPaneTitles,
  getTerminalFontFamily,
  getTerminalFontSize,
  getTerminalFontWeight,
  getWallpaperBlur,
  getWallpaperFollowsKeyboard,
  getWallpaperFollowsMouse,
  getWallpaperOpacity,
  getWallpaperSaturate,
  getWallpaperSeed,
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
import { Layout, LayoutContent, LayoutFooter, LayoutHeader, HStack, VStack } from '@astryxdesign/core/Layout';
import { KeyCap } from './KeyHint';
import { actionLabel } from '../lib/actionLabel';

interface Props {
  config: ClientConfig;
  send: (message: ClientMessage) => void;
}

type Draft = {
  prefix: string;
  shell: string;
  viMode: boolean;
  colors: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  animations: boolean;
  showPaneTitles: boolean;
  sessionSort: ClientConfig['session_sort'];
  windowSort: ClientConfig['window_sort'];
  windowGridCount: number;
  binds: Record<string, string>;
  keyOverrides: Record<string, string>;
  renderer: NonNullable<ClientConfig['terminal']['renderer']>;
  cursorBlink: boolean;
  cursorStyle: NonNullable<ClientConfig['terminal']['cursorStyle']>;
  scrollback: number;
  allowTransparency: boolean;
  convertEol: boolean;
  disableStdin: boolean;
  smoothScrollDuration: number;
  scrollSensitivity: number;
  consoleLevel: string;
  fileLevel: string;
  wallpaper: string;
  wallpaperShader: string;
  wallpaperOpacity: number;
  desktopBackgroundOpacity: number;
  wallpaperBlur: number;
  wallpaperSaturate: number;
  wallpaperSpeed: number;
  wallpaperSeed: string;
  wallpaperFollowsMouse: boolean;
  wallpaperFollowsKeyboard: boolean;
  shader: string;
  sessionViewShader: string;
  paneSwitchShader: string;
  paneSwitchIntensity: number;
  paneSwitchDuration: number;
  paneSwitchBorderStyle: string;
  paneSwitchBorderSpeed: number;
};

type DraftKey = keyof Draft;
type ConfigUpdate = Extract<ClientMessage, { type: 'update_config' }>['update'];

const SEED_ADJECTIVES = [
  'ancient',
  'brisk',
  'cosmic',
  'electric',
  'fuzzy',
  'luminous',
  'mellow',
  'neon',
  'quiet',
  'velvet',
  'wandering',
  'wobbly',
];

const SEED_NOUNS = [
  'badger',
  'circuit',
  'comet',
  'fjord',
  'lantern',
  'mushroom',
  'nebula',
  'orbit',
  'pancake',
  'sprocket',
  'teapot',
  'volcano',
];

const SEED_ENDINGS = [
  'cascade',
  'disco',
  'dream',
  'engine',
  'glitch',
  'monsoon',
  'parade',
  'signal',
  'soup',
  'storm',
  'tango',
  'whisper',
];

function randomItem(words: string[]): string {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return words[value[0] % words.length];
}

function generateWallpaperSeed(): string {
  return [randomItem(SEED_ADJECTIVES), randomItem(SEED_NOUNS), randomItem(SEED_ENDINGS)].join('-');
}

function initialDraft(config: ClientConfig): Draft {
  return {
    prefix: config.prefix,
    shell: config.shell ?? '',
    viMode: config.vi_mode,
    colors: config.active_color_scheme ?? '',
    fontFamily: getTerminalFontFamily(config),
    fontWeight: getTerminalFontWeight(config),
    fontSize: getTerminalFontSize(config),
    animations: config.animations,
    showPaneTitles: getShowPaneTitles(config),
    sessionSort: config.session_sort,
    windowSort: config.window_sort,
    windowGridCount: config.window_grid_count,
    binds: Object.fromEntries(config.binds.map((bind) => [bind.action, bind.key])),
    keyOverrides: config.keys,
    renderer: config.terminal.renderer ?? 'webgl',
    cursorBlink: config.terminal.cursorBlink ?? true,
    cursorStyle: config.terminal.cursorStyle ?? 'bar',
    scrollback: config.terminal.scrollback ?? 100_000,
    allowTransparency:
      config.terminal.allowTransparency ?? (config.wallpaper != null || config.wallpaper_shader != null),
    convertEol: config.terminal.convertEol ?? false,
    disableStdin: config.terminal.disableStdin ?? false,
    smoothScrollDuration: config.terminal.smoothScrollDuration ?? 0,
    scrollSensitivity: config.terminal.scrollSensitivity ?? 5,
    consoleLevel: config.log['console-level'],
    fileLevel: config.log['file-level'],
    wallpaper: config.wallpaper ?? '',
    wallpaperShader: config.wallpaper_shader ?? '',
    wallpaperOpacity: getWallpaperOpacity(config),
    desktopBackgroundOpacity: getDesktopBackgroundOpacity(config),
    wallpaperBlur: getWallpaperBlur(config),
    wallpaperSaturate: getWallpaperSaturate(config),
    wallpaperSpeed: getWallpaperSpeed(config),
    wallpaperSeed: getWallpaperSeed(config),
    wallpaperFollowsMouse: getWallpaperFollowsMouse(config),
    wallpaperFollowsKeyboard: getWallpaperFollowsKeyboard(config),
    shader: config.shader ?? '',
    sessionViewShader: config.session_view_shader ?? '',
    paneSwitchShader: config.pane_switch_shader ?? '',
    paneSwitchIntensity: getPaneSwitchIntensity(config),
    paneSwitchDuration: getPaneSwitchDuration(config),
    paneSwitchBorderStyle: config.pane_switch_border ?? 'none',
    paneSwitchBorderSpeed: getPaneSwitchBorderSpeed(config),
  };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

// Mirrors the built-in defaults in `src/config.rs` (the `DEFAULT_*` constants
// and each struct's `Default` impl). Kept separate from `CONFIG_DEFAULTS`
// (frontend fallbacks for a not-yet-loaded config) since a couple of fields
// here have no wire-level equivalent (vi-mode, log levels).
const TOML_DEFAULTS = {
  prefix: 'C-b',
  viMode: false,
  animations: true,
  showPaneTitles: false,
  sessionSort: 'mru',
  windowSort: 'alphabetical',
  windowGridCount: 4,
  wallpaperShader: 'radiant:aurora-curtain',
  wallpaperOpacity: 0.1,
  desktopBackgroundOpacity: 0.8,
  wallpaperBlur: 0,
  wallpaperSaturate: 0.05,
  wallpaperSpeed: 0.2,
  wallpaperSeed: 'mellow-nebula-dream',
  wallpaperFollowsMouse: true,
  wallpaperFollowsKeyboard: false,
  paneSwitchIntensity: 0.25,
  paneSwitchDuration: 0.5,
  paneSwitchBorderStyle: 'wipe',
  paneSwitchBorderSpeed: 0.1,
  renderer: 'webgl',
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 100_000,
  fontFamily: 'Geist Mono',
  fontSize: 18,
  fontWeight: 200,
  convertEol: false,
  disableStdin: false,
  smoothScrollDuration: 0,
  scrollSensitivity: 5,
  consoleLevel: 'warn',
  fileLevel: 'info',
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
  const defaultAllowTransparency = draft.wallpaper !== '' || draft.wallpaperShader !== '';

  const topLines = [
    strLine('prefix', draft.prefix, TOML_DEFAULTS.prefix),
    draft.shell ? `shell = ${quote(draft.shell)}` : null,
    boolLine('vi-mode', draft.viMode, TOML_DEFAULTS.viMode),
    boolLine('animations', draft.animations, TOML_DEFAULTS.animations),
    boolLine('show-pane-titles', draft.showPaneTitles, TOML_DEFAULTS.showPaneTitles),
    strLine('session-sort', draft.sessionSort, TOML_DEFAULTS.sessionSort),
    strLine('window-sort', draft.windowSort, TOML_DEFAULTS.windowSort),
    intLine('window-grid-count', draft.windowGridCount, TOML_DEFAULTS.windowGridCount),
    optLine('colors', draft.colors),
    optLine('wallpaper', draft.wallpaper),
    strLine('wallpaper-shader', draft.wallpaperShader, TOML_DEFAULTS.wallpaperShader),
    numLine('wallpaper-opacity', draft.wallpaperOpacity, TOML_DEFAULTS.wallpaperOpacity, 2),
    numLine('desktop-background-opacity', draft.desktopBackgroundOpacity, TOML_DEFAULTS.desktopBackgroundOpacity, 2),
    numLine('wallpaper-blur', draft.wallpaperBlur, TOML_DEFAULTS.wallpaperBlur, 1),
    numLine('wallpaper-saturate', draft.wallpaperSaturate, TOML_DEFAULTS.wallpaperSaturate, 2),
    numLine('wallpaper-speed', draft.wallpaperSpeed, TOML_DEFAULTS.wallpaperSpeed, 2),
    strLine('wallpaper-seed', draft.wallpaperSeed, TOML_DEFAULTS.wallpaperSeed),
    boolLine('wallpaper-shader-follows-mouse-cursor', draft.wallpaperFollowsMouse, TOML_DEFAULTS.wallpaperFollowsMouse),
    boolLine(
      'wallpaper-shader-follows-keyboard-input',
      draft.wallpaperFollowsKeyboard,
      TOML_DEFAULTS.wallpaperFollowsKeyboard,
    ),
    optLine('shader', draft.shader),
    optLine('session-view-shader', draft.sessionViewShader),
    optLine('pane-switch-shader', draft.paneSwitchShader),
    numLine('pane-switch-intensity', draft.paneSwitchIntensity, TOML_DEFAULTS.paneSwitchIntensity, 2),
    numLine('pane-switch-duration', draft.paneSwitchDuration, TOML_DEFAULTS.paneSwitchDuration, 2),
    strLine('pane-switch-border', draft.paneSwitchBorderStyle, TOML_DEFAULTS.paneSwitchBorderStyle),
    numLine('pane-switch-border-speed', draft.paneSwitchBorderSpeed, TOML_DEFAULTS.paneSwitchBorderSpeed, 2),
  ].filter((line): line is string => line !== null);

  const terminalLines = [
    strLine('renderer', draft.renderer, TOML_DEFAULTS.renderer),
    boolLine('cursor-blink', draft.cursorBlink, TOML_DEFAULTS.cursorBlink),
    strLine('cursor-style', draft.cursorStyle, TOML_DEFAULTS.cursorStyle),
    intLine('scrollback', draft.scrollback, TOML_DEFAULTS.scrollback),
    strLine('font-family', draft.fontFamily, TOML_DEFAULTS.fontFamily),
    numLine('font-size', draft.fontSize, TOML_DEFAULTS.fontSize, 1),
    intLine('font-weight', draft.fontWeight, TOML_DEFAULTS.fontWeight),
    boolLine('allow-transparency', draft.allowTransparency, defaultAllowTransparency),
    boolLine('convert-eol', draft.convertEol, TOML_DEFAULTS.convertEol),
    boolLine('disable-stdin', draft.disableStdin, TOML_DEFAULTS.disableStdin),
    numLine('smooth-scroll-duration', draft.smoothScrollDuration, TOML_DEFAULTS.smoothScrollDuration, 2),
    numLine('scroll-sensitivity', draft.scrollSensitivity, TOML_DEFAULTS.scrollSensitivity, 2),
  ].filter((line): line is string => line !== null);

  const logLines = [
    strLine('console-level', draft.consoleLevel, TOML_DEFAULTS.consoleLevel),
    strLine('file-level', draft.fileLevel, TOML_DEFAULTS.fileLevel),
  ].filter((line): line is string => line !== null);

  const sections = [
    ['# Settings generated by btmux', ...topLines],
    keyLines.length ? ['[keys]', ...keyLines] : [],
    terminalLines.length ? ['[terminal]', ...terminalLines] : [],
    logLines.length ? ['[log]', ...logLines] : [],
  ].filter((section) => section.length > 0);

  return sections.map((section) => section.join('\n')).join('\n\n');
}

function toConfigUpdate(draft: Draft, dirty: Set<DraftKey>): ConfigUpdate {
  const update: ConfigUpdate = {};
  if (dirty.has('prefix')) update.prefix = draft.prefix;
  if (dirty.has('shell')) update.shell = draft.shell;
  if (dirty.has('viMode')) update.vi_mode = draft.viMode;
  if (dirty.has('showPaneTitles')) update.show_pane_titles = draft.showPaneTitles;
  if (dirty.has('sessionSort')) update.session_sort = draft.sessionSort;
  if (dirty.has('windowSort')) update.window_sort = draft.windowSort;
  if (dirty.has('windowGridCount')) update.window_grid_count = draft.windowGridCount;
  if (dirty.has('binds')) update.keys = draft.keyOverrides;
  if (dirty.has('colors')) update.colors = draft.colors;
  if (dirty.has('fontFamily')) update.font_family = draft.fontFamily;
  if (dirty.has('fontWeight')) update.font_weight = draft.fontWeight;
  if (dirty.has('fontSize')) update.font_size = draft.fontSize;
  if (dirty.has('renderer')) update.renderer = draft.renderer;
  if (dirty.has('cursorBlink')) update.cursor_blink = draft.cursorBlink;
  if (dirty.has('cursorStyle')) update.cursor_style = draft.cursorStyle;
  if (dirty.has('scrollback')) update.scrollback = draft.scrollback;
  if (dirty.has('allowTransparency')) update.allow_transparency = draft.allowTransparency;
  if (dirty.has('convertEol')) update.convert_eol = draft.convertEol;
  if (dirty.has('disableStdin')) update.disable_stdin = draft.disableStdin;
  if (dirty.has('smoothScrollDuration')) update.smooth_scroll_duration = draft.smoothScrollDuration;
  if (dirty.has('scrollSensitivity')) update.scroll_sensitivity = draft.scrollSensitivity;
  if (dirty.has('animations')) update.animations = draft.animations;
  if (dirty.has('consoleLevel')) update.console_level = draft.consoleLevel;
  if (dirty.has('fileLevel')) update.file_level = draft.fileLevel;
  if (dirty.has('wallpaper')) update.wallpaper = draft.wallpaper;
  if (dirty.has('wallpaperShader')) update.wallpaper_shader = draft.wallpaperShader;
  if (dirty.has('wallpaperOpacity')) update.wallpaper_opacity = draft.wallpaperOpacity;
  if (dirty.has('desktopBackgroundOpacity')) update.desktop_background_opacity = draft.desktopBackgroundOpacity;
  if (dirty.has('wallpaperBlur')) update.wallpaper_blur = draft.wallpaperBlur;
  if (dirty.has('wallpaperSaturate')) update.wallpaper_saturate = draft.wallpaperSaturate;
  if (dirty.has('wallpaperSpeed')) update.wallpaper_speed = draft.wallpaperSpeed;
  if (dirty.has('wallpaperSeed')) update.wallpaper_seed = draft.wallpaperSeed;
  if (dirty.has('wallpaperFollowsMouse')) {
    update.wallpaper_shader_follows_mouse_cursor = draft.wallpaperFollowsMouse;
  }
  if (dirty.has('wallpaperFollowsKeyboard')) {
    update.wallpaper_shader_follows_keyboard_input = draft.wallpaperFollowsKeyboard;
  }
  if (dirty.has('shader')) update.shader = draft.shader;
  if (dirty.has('sessionViewShader')) update.session_view_shader = draft.sessionViewShader;
  if (dirty.has('paneSwitchShader')) update.pane_switch_shader = draft.paneSwitchShader;
  if (dirty.has('paneSwitchIntensity')) update.pane_switch_intensity = draft.paneSwitchIntensity;
  if (dirty.has('paneSwitchDuration')) update.pane_switch_duration = draft.paneSwitchDuration;
  if (dirty.has('paneSwitchBorderStyle')) update.pane_switch_border = draft.paneSwitchBorderStyle;
  if (dirty.has('paneSwitchBorderSpeed')) update.pane_switch_border_speed = draft.paneSwitchBorderSpeed;
  return update;
}

function previewTheme(config: ClientConfig, draft: Draft, colorSchemeTouched: boolean) {
  if (!colorSchemeTouched) return config.theme ?? DEFAULT_THEME;
  if (!draft.colors) return DEFAULT_THEME;
  return config.color_scheme_themes[draft.colors] ?? DEFAULT_THEME;
}

const TAB_LABELS = {
  general: 'General',
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
  const [tab, setTab] = useState<SettingsTab>('general');
  const setConfigPreview = useStore((state) => state.setConfigPreview);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const toast = useToast();
  const [draft, setDraft] = useState(() => initialDraft(config));
  const [dirty, setDirty] = useState<Set<DraftKey>>(() => new Set());
  const [colorSchemeTouched, setColorSchemeTouched] = useState(false);
  const [copied, setCopied] = useState(false);
  const toml = useMemo(() => toToml(draft), [draft]);

  const previewConfig = useMemo<ClientConfig>(
    () => ({
      ...config,
      theme: previewTheme(config, draft, colorSchemeTouched),
      animations: draft.animations,
      show_pane_titles: draft.showPaneTitles,
      terminal: {
        ...config.terminal,
        renderer: draft.renderer,
        cursorBlink: draft.cursorBlink,
        cursorStyle: draft.cursorStyle,
        scrollback: draft.scrollback,
        fontFamily: draft.fontFamily,
        fontSize: draft.fontSize,
        fontWeight: draft.fontWeight,
        // Keep null until the user changes this control so a wallpaper can
        // still enable terminal transparency through its normal default.
        allowTransparency: dirty.has('allowTransparency') ? draft.allowTransparency : config.terminal.allowTransparency,
        convertEol: dirty.has('convertEol') ? draft.convertEol : config.terminal.convertEol,
        disableStdin: dirty.has('disableStdin') ? draft.disableStdin : config.terminal.disableStdin,
        smoothScrollDuration: dirty.has('smoothScrollDuration')
          ? draft.smoothScrollDuration
          : config.terminal.smoothScrollDuration,
        scrollSensitivity: draft.scrollSensitivity,
      },
      wallpaper: draft.wallpaper || null,
      wallpaper_shader: draft.wallpaperShader || null,
      wallpaper_opacity: draft.wallpaperOpacity,
      desktop_background_opacity: draft.desktopBackgroundOpacity,
      wallpaper_blur: draft.wallpaperBlur,
      wallpaper_saturate: draft.wallpaperSaturate,
      wallpaper_speed: draft.wallpaperSpeed,
      wallpaper_seed: draft.wallpaperSeed,
      wallpaper_shader_follows_mouse_cursor: draft.wallpaperFollowsMouse,
      wallpaper_shader_follows_keyboard_input: draft.wallpaperFollowsKeyboard,
      shader: draft.shader || null,
      session_view_shader: draft.sessionViewShader || null,
      pane_switch_shader: draft.paneSwitchShader || null,
      pane_switch_intensity: draft.paneSwitchIntensity,
      pane_switch_duration: draft.paneSwitchDuration,
      pane_switch_border: draft.paneSwitchBorderStyle || null,
      pane_switch_border_speed: draft.paneSwitchBorderSpeed,
    }),
    [config, draft, dirty, colorSchemeTouched],
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
    setColorSchemeTouched(false);
  }, [config]);

  const update = <K extends DraftKey>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty((current) => new Set(current).add(key));
  };

  const apply = () => {
    const update = toConfigUpdate(draft, dirty);
    if (Object.keys(update).length === 0) return;
    send({ type: 'update_config', update });
    setDirty(new Set());
    toast({ body: 'Settings applied to the current session' });
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
  ) => (
    <TextInput
      key={key}
      label={label}
      value={draft[key]}
      onChange={(value) => update(key, value as never)}
      description={description}
    />
  );
  const range = (
    key: { [K in DraftKey]: Draft[K] extends number ? K : never }[DraftKey],
    label: string,
    min: number,
    max: number,
    step = 1,
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
    />
  );
  const choose = (
    key: { [K in DraftKey]: Draft[K] extends string ? K : never }[DraftKey],
    label: string,
    options: { value: string; label: string }[],
  ) => (
    <Selector
      key={key}
      label={label}
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
  const effects = SHADER_EFFECTS.map((item) => ({ value: item.id, label: item.label }));

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) goBack();
      }}
      purpose="form"
      width={960}
      maxHeight="90dvh"
      style={{ height: '90dvh' }}
    >
      <Layout
        header={
          <VStack>
            <DialogHeader
              title="Settings"
              subtitle="Preview changes in the terminal and UI. Apply for this run, or copy TOML to save them."
              hasDivider={false}
              onOpenChange={(open) => {
                if (!open) goBack();
              }}
            />
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
          </VStack>
        }
        content={
          <LayoutContent padding={6}>
            <VStack gap={8}>
              {tab === 'general' && (
                <VStack gap={4} id="settings-general" role="tabpanel" aria-label={TAB_LABELS.general}>
                  <FormLayout>
                    {text('prefix', 'Prefix key', 'Use tmux notation such as C-b, C-a, or M-x.')}
                    {text('shell', 'Shell for new panes', 'Leave empty to use $SHELL.')}
                    {toggle('viMode', 'Vi mode', 'Add h/j/k/l pane navigation bindings.')}
                    {toggle('animations', 'Animations')}
                    {toggle('showPaneTitles', 'Show pane titles')}
                    {choose('sessionSort', 'Session sort', ordering)}
                    {choose('windowSort', 'Window sort', ordering)}
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
                    <Selector
                      label="Color scheme"
                      value={draft.colors || 'none'}
                      hasSearch
                      presentation="adaptive"
                      options={[
                        { value: 'none', label: 'Built-in default' },
                        ...config.color_schemes.map((value) => ({ value, label: value })),
                      ]}
                      onChange={(value) => {
                        setColorSchemeTouched(true);
                        update('colors', value === 'none' ? '' : value);
                      }}
                    />
                    <Selector
                      label="Font family"
                      value={draft.fontFamily}
                      presentation="adaptive"
                      options={config.fonts.map((font) => ({ value: font.family, label: font.family }))}
                      onChange={(value) => {
                        const { min, max } = getFontWeightRange(config.fonts, value);
                        update('fontFamily', value);
                        update('fontWeight', Math.min(max, Math.max(min, draft.fontWeight)));
                      }}
                    />
                    {range('fontSize', 'Terminal font size', 8, 36)}
                    {range('fontWeight', 'Font weight', weightMin, weightMax, 100)}
                    {choose('renderer', 'Renderer', [
                      { value: 'webgl', label: 'WebGL' },
                      { value: 'canvas', label: 'Canvas' },
                    ])}
                    {choose('cursorStyle', 'Cursor style', [
                      { value: 'bar', label: 'Bar' },
                      { value: 'block', label: 'Block' },
                      { value: 'underline', label: 'Underline' },
                    ])}
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
                    {toggle('convertEol', 'Convert line endings')}
                    {toggle('disableStdin', 'Disable terminal input')}
                    {range('smoothScrollDuration', 'Smooth scroll duration', 0, 2, 0.05)}
                    {range('scrollSensitivity', 'Scroll sensitivity', 0.1, 20, 0.1)}
                  </FormLayout>
                </VStack>
              )}
              {tab === 'wallpaper' && (
                <VStack gap={4} id="settings-wallpaper" role="tabpanel" aria-label={TAB_LABELS.wallpaper}>
                  <FormLayout>
                    {choose('wallpaperShader', 'Procedural shader', [
                      none,
                      ...WALLPAPER_SHADERS.map((item) => ({ value: item.id, label: item.label })),
                    ])}
                    {text('wallpaper', 'Wallpaper URL or path')}
                    {range('wallpaperOpacity', 'Wallpaper opacity', 0, 1, 0.01)}
                    {range('wallpaperBlur', 'Wallpaper blur', 0, 40, 0.5)}
                    {range('wallpaperSaturate', 'Wallpaper saturation', 0, 3, 0.05)}
                    {range('wallpaperSpeed', 'Wallpaper speed', 0, 10, 0.05)}
                    <HStack gap={2} align="end">
                      {text('wallpaperSeed', 'Wallpaper seed')}
                      <Button label="Randomize" onClick={() => update('wallpaperSeed', generateWallpaperSeed())} />
                    </HStack>
                    {toggle('wallpaperFollowsMouse', 'Follow mouse cursor')}
                    {toggle('wallpaperFollowsKeyboard', 'Follow keyboard input')}
                  </FormLayout>
                </VStack>
              )}
              {tab === 'effects' && (
                <VStack gap={4} id="settings-effects" role="tabpanel" aria-label={TAB_LABELS.effects}>
                  <FormLayout>
                    {choose('shader', 'Terminal shader', [none, ...effects])}
                    {choose('sessionViewShader', 'Session switcher shader', [none, ...effects])}
                    {choose(
                      'paneSwitchShader',
                      'Pane switch shader',
                      PANE_SWITCH_EFFECTS.map((item) => ({ value: item.id, label: item.label })),
                    )}
                    {range('paneSwitchIntensity', 'Pane switch intensity', 0, 3, 0.05)}
                    {range('paneSwitchDuration', 'Pane switch duration', 0.1, 5, 0.05)}
                    {choose('paneSwitchBorderStyle', 'Pane switch border', [
                      none,
                      ...PANE_BORDER_STYLES.map((item) => ({ value: item.id, label: item.label })),
                    ])}
                    {range('paneSwitchBorderSpeed', 'Pane switch border speed (seconds)', 0.05, 3, 0.05)}
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
              {tab === 'logging' && (
                <VStack gap={4} id="settings-logging" role="tabpanel" aria-label={TAB_LABELS.logging}>
                  <Text color="secondary">
                    Use error, warn, info, debug, trace, or a tracing directive. Changes take effect on restart.
                  </Text>
                  <FormLayout>
                    {text('consoleLevel', 'Console level')}
                    {text('fileLevel', 'File level')}
                  </FormLayout>
                </VStack>
              )}
              <TextArea label="Generated TOML" value={toml} isReadOnly rows={12} hasSpellCheck={false} />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} wrap="wrap" hAlign="between">
              <Button label="Reset" onClick={reset} />
              <HStack gap={2} wrap="wrap">
                <Button label={copied ? 'Copied' : 'Copy TOML'} clickAction={copy} />
                <Button label="Close" onClick={goBack} />
                <Button label="Apply" variant="primary" onClick={apply} isDisabled={dirty.size === 0} />
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
