import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Check, Clipboard, Dices, RotateCcw, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ClientMessage } from '../protocol/messages';
import type { Bind, ClientConfig } from '../state/types';
import { SHADER_EFFECTS, PANE_SWITCH_EFFECTS } from '../lib/terminalFxShaders';
import { PANE_BORDER_STYLES } from '../lib/paneSwitchBorder';
import { WALLPAPER_SHADERS } from '../lib/wallpaperCatalog';
import { DEFAULT_THEME } from '../state/defaultTheme';
import {
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
import { Button } from './ui/button';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from './ui/field';
import { Input } from './ui/input';
import { Kbd, KbdGroup } from './ui/kbd';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Slider } from './ui/slider';
import { Switch } from './ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Textarea } from './ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

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

function IconAction({
  label,
  children,
  disabled,
  variant = 'outline',
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  const button = (
    <Button {...props} variant={variant} size="icon" disabled={disabled} aria-label={label}>
      {children}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{disabled ? <span className="inline-flex">{button}</span> : button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

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

const SETTINGS_BACKGROUND_BLUR = 5;

function randomItem(words: string[]): string {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return words[value[0] % words.length];
}

function generateWallpaperSeed(): string {
  return [randomItem(SEED_ADJECTIVES), randomItem(SEED_NOUNS), randomItem(SEED_ENDINGS)].join('-');
}

function bindLabel(bind: Bind): string {
  return bind.action.replace(/-/g, ' ');
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

function toToml(draft: Draft): string {
  const keyLines = Object.entries(draft.keyOverrides)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([action, key]) => `${action} = ${quote(key)}`);
  const lines = [
    '# Settings generated by btmux',
    `prefix = ${quote(draft.prefix)}`,
    draft.shell ? `shell = ${quote(draft.shell)}` : '# shell = ""  # use $SHELL',
    `vi-mode = ${draft.viMode}`,
    `animations = ${draft.animations}`,
    `show-pane-titles = ${draft.showPaneTitles}`,
    `session-sort = ${quote(draft.sessionSort)}`,
    `window-sort = ${quote(draft.windowSort)}`,
    `window-grid-count = ${draft.windowGridCount}`,
    draft.colors ? `colors = ${quote(draft.colors)}` : null,
    draft.wallpaper ? `wallpaper = ${quote(draft.wallpaper)}` : null,
    draft.wallpaperShader ? `wallpaper-shader = ${quote(draft.wallpaperShader)}` : null,
    `wallpaper-opacity = ${draft.wallpaperOpacity.toFixed(2)}`,
    `wallpaper-blur = ${draft.wallpaperBlur.toFixed(1)}`,
    `wallpaper-saturate = ${draft.wallpaperSaturate.toFixed(2)}`,
    `wallpaper-speed = ${draft.wallpaperSpeed.toFixed(2)}`,
    `wallpaper-seed = ${quote(draft.wallpaperSeed)}`,
    `wallpaper-shader-follows-mouse-cursor = ${draft.wallpaperFollowsMouse}`,
    `wallpaper-shader-follows-keyboard-input = ${draft.wallpaperFollowsKeyboard}`,
    draft.shader ? `shader = ${quote(draft.shader)}` : null,
    draft.sessionViewShader ? `session-view-shader = ${quote(draft.sessionViewShader)}` : null,
    draft.paneSwitchShader ? `pane-switch-shader = ${quote(draft.paneSwitchShader)}` : null,
    `pane-switch-intensity = ${draft.paneSwitchIntensity.toFixed(2)}`,
    `pane-switch-duration = ${draft.paneSwitchDuration.toFixed(2)}`,
    `pane-switch-border = ${quote(draft.paneSwitchBorderStyle)}`,
    `pane-switch-border-speed = ${draft.paneSwitchBorderSpeed.toFixed(2)}`,
    '',
    '[keys]',
    ...keyLines,
    '',
    '[terminal]',
    `renderer = ${quote(draft.renderer)}`,
    `cursor-blink = ${draft.cursorBlink}`,
    `cursor-style = ${quote(draft.cursorStyle)}`,
    `scrollback = ${draft.scrollback}`,
    `font-family = ${quote(draft.fontFamily)}`,
    `font-size = ${draft.fontSize.toFixed(1)}`,
    `font-weight = ${draft.fontWeight}`,
    `allow-transparency = ${draft.allowTransparency}`,
    `convert-eol = ${draft.convertEol}`,
    `disable-stdin = ${draft.disableStdin}`,
    `smooth-scroll-duration = ${draft.smoothScrollDuration.toFixed(2)}`,
    `scroll-sensitivity = ${draft.scrollSensitivity.toFixed(2)}`,
    '',
    '[log]',
    `console-level = ${quote(draft.consoleLevel)}`,
    `file-level = ${quote(draft.fileLevel)}`,
  ];
  return lines.filter((line) => line !== null).join('\n');
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

function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-4">
        <FieldLabel>{label}</FieldLabel>
        <output className="tabular-nums text-sm text-muted-foreground">{value.toFixed(step < 1 ? 2 : 0)}</output>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([next]) => onChange(next)} />
    </Field>
  );
}

export function ConfigPage({ config, send }: Props) {
  const setConfigPreview = useStore((state) => state.setConfigPreview);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const pageRef = useRef<HTMLElement>(null);
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

  useEffect(() => {
    pageRef.current?.focus();
  }, []);

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
    toast.success('Settings applied to the current session');
  };

  const copy = async () => {
    await navigator.clipboard.writeText(toml);
    setCopied(true);
    toast.success('Settings copied to clipboard');
    window.setTimeout(() => setCopied(false), 1600);
  };

  const reset = () => {
    send({ type: 'reset_config' });
    setDirty(new Set());
    toast.success('Settings reset to config.toml and defaults');
  };

  const { min: weightMin, max: weightMax } = getFontWeightRange(config.fonts, draft.fontFamily);

  const bindingRows = [...config.binds].sort((left, right) => left.action.localeCompare(right.action));

  const goBack = () => setSettingsOpen(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT';
      const quitWithQ =
        event.key.toLowerCase() === 'q' && !editing && !event.ctrlKey && !event.altKey && !event.metaKey;
      if (event.key === 'Escape' || quitWithQ) {
        event.preventDefault();
        goBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goBack]);

  return (
    <main
      ref={pageRef}
      tabIndex={-1}
      className="absolute inset-y-0 right-0 z-20 flex w-1/2 flex-col overflow-hidden border-l border-border bg-background/45 text-foreground outline-none"
      style={{
        backdropFilter: `blur(${SETTINGS_BACKGROUND_BLUR}px)`,
        WebkitBackdropFilter: `blur(${SETTINGS_BACKGROUND_BLUR}px)`,
      }}
    >
      <Tabs defaultValue="general" className="mx-auto flex min-h-0 w-full flex-1 flex-col gap-0">
        <div className="shrink-0 border-b border-border bg-background/75 px-4 pt-5 pb-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <TabsList className="grid min-w-0 flex-1 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="keybinds">Key binds</TabsTrigger>
              <TabsTrigger value="logging">Logging</TabsTrigger>
              <TabsTrigger value="wallpaper">Wallpaper</TabsTrigger>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
              <TabsTrigger value="effects">Effects</TabsTrigger>
            </TabsList>
            <div className="flex shrink-0 items-center gap-1">
              <IconAction label="Apply to current session" onClick={apply} disabled={dirty.size === 0}>
                <Upload />
              </IconAction>
              <IconAction label="Reset" variant="outline" onClick={reset}>
                <RotateCcw />
              </IconAction>
              <IconAction label="Copy settings to clipboard" onClick={copy}>
                {copied ? <Check /> : <Clipboard />}
              </IconAction>
              <IconAction label="Close settings" onClick={goBack}>
                <X />
              </IconAction>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid gap-4 px-4 py-5 xl:grid-cols-2 lg:px-6">
            <div className="min-w-0">
              <TabsContent value="general" className="pt-4">
                <FieldGroup>
                  <FieldSet>
                    <FieldLegend>Session and input</FieldLegend>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="prefix">Prefix key</FieldLabel>
                        <Input
                          id="prefix"
                          value={draft.prefix}
                          onChange={(event) => update('prefix', event.target.value)}
                        />
                        <FieldDescription>Use tmux notation such as C-b, C-a, or M-x.</FieldDescription>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="shell">Shell for new panes</FieldLabel>
                        <Input
                          id="shell"
                          value={draft.shell}
                          onChange={(event) => update('shell', event.target.value)}
                          placeholder="Use $SHELL"
                        />
                      </Field>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel htmlFor="vi-mode">Vi mode</FieldLabel>
                          <FieldDescription>Add h/j/k/l pane navigation bindings.</FieldDescription>
                        </FieldContent>
                        <Switch
                          id="vi-mode"
                          checked={draft.viMode}
                          onCheckedChange={(value) => update('viMode', value)}
                        />
                      </Field>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel htmlFor="animations">Animations</FieldLabel>
                          <FieldDescription>Enable animated transitions and effects.</FieldDescription>
                        </FieldContent>
                        <Switch
                          id="animations"
                          checked={draft.animations}
                          onCheckedChange={(value) => update('animations', value)}
                        />
                      </Field>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel htmlFor="show-pane-titles">Show pane titles</FieldLabel>
                          <FieldDescription>Show shell, cwd, size, and zoom metadata above panes.</FieldDescription>
                        </FieldContent>
                        <Switch
                          id="show-pane-titles"
                          checked={draft.showPaneTitles}
                          onCheckedChange={(value) => update('showPaneTitles', value)}
                        />
                      </Field>
                    </FieldGroup>
                  </FieldSet>
                  <FieldSet>
                    <FieldLegend>Ordering</FieldLegend>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="session-sort">Session sort</FieldLabel>
                        <Select
                          value={draft.sessionSort}
                          onValueChange={(value) => update('sessionSort', value as Draft['sessionSort'])}
                        >
                          <SelectTrigger id="session-sort" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="created">Created</SelectItem>
                              <SelectItem value="mru">Recently used</SelectItem>
                              <SelectItem value="alphabetical">Alphabetical</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="window-sort">Window sort</FieldLabel>
                        <Select
                          value={draft.windowSort}
                          onValueChange={(value) => update('windowSort', value as Draft['windowSort'])}
                        >
                          <SelectTrigger id="window-sort" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="created">Created</SelectItem>
                              <SelectItem value="mru">Recently used</SelectItem>
                              <SelectItem value="alphabetical">Alphabetical</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="window-grid-count">Window grid count</FieldLabel>
                        <Input
                          id="window-grid-count"
                          type="number"
                          min={1}
                          max={24}
                          value={draft.windowGridCount}
                          onChange={(event) =>
                            update('windowGridCount', Math.min(24, Math.max(1, Number(event.target.value) || 1)))
                          }
                        />
                      </Field>
                    </FieldGroup>
                  </FieldSet>
                </FieldGroup>
              </TabsContent>

              <TabsContent value="keybinds" className="pt-4">
                <FieldSet>
                  <FieldLegend>Prefix key bindings</FieldLegend>
                  <FieldDescription>
                    Change the second key pressed after the prefix. Values use browser key names for arrows.
                  </FieldDescription>
                  <FieldGroup>
                    {bindingRows.map((bind) => (
                      <Field key={bind.action} orientation="responsive">
                        <FieldContent>
                          <FieldLabel htmlFor={`bind-${bind.action}`}>{bindLabel(bind)}</FieldLabel>
                        </FieldContent>
                        <Input
                          id={`bind-${bind.action}`}
                          className="@md/field:w-40"
                          value={draft.binds[bind.action] ?? bind.key}
                          onChange={(event) => {
                            const key = event.target.value;
                            setDraft((current) => ({
                              ...current,
                              binds: { ...current.binds, [bind.action]: key },
                              keyOverrides: { ...current.keyOverrides, [bind.action]: key },
                            }));
                            setDirty((current) => new Set(current).add('binds'));
                          }}
                        />
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
              </TabsContent>

              <TabsContent value="logging" className="pt-4">
                <FieldSet>
                  <FieldLegend>Log levels</FieldLegend>
                  <FieldDescription>
                    Use error, warn, info, debug, trace, or a tracing directive such as btmux=debug,tower_http=info.
                    Changes are included in the copied TOML and take effect on restart.
                  </FieldDescription>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="console-level">Console level</FieldLabel>
                      <Input
                        id="console-level"
                        value={draft.consoleLevel}
                        onChange={(event) => update('consoleLevel', event.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="file-level">File level</FieldLabel>
                      <Input
                        id="file-level"
                        value={draft.fileLevel}
                        onChange={(event) => update('fileLevel', event.target.value)}
                      />
                    </Field>
                  </FieldGroup>
                </FieldSet>
              </TabsContent>

              <TabsContent value="wallpaper" className="pt-4">
                <FieldGroup>
                  <FieldSet>
                    <FieldLegend>Wallpaper source</FieldLegend>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="wallpaper-shader">Procedural shader</FieldLabel>
                        <Select
                          value={draft.wallpaperShader || 'none'}
                          onValueChange={(value) => update('wallpaperShader', value === 'none' ? '' : value)}
                        >
                          <SelectTrigger id="wallpaper-shader" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="none">None</SelectItem>
                              {WALLPAPER_SHADERS.map((item) => (
                                <SelectItem key={item.id} value={item.id}>
                                  {item.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="wallpaper-url">Image URL or path</FieldLabel>
                        <Input
                          id="wallpaper-url"
                          value={draft.wallpaper}
                          onChange={(event) => update('wallpaper', event.target.value)}
                          placeholder="https://… or ~/Pictures/wallpaper.png"
                        />
                      </Field>
                      <RangeField
                        label="Opacity"
                        value={draft.wallpaperOpacity}
                        min={0}
                        max={1}
                        step={0.01}
                        onChange={(value) => update('wallpaperOpacity', value)}
                      />
                      <RangeField
                        label="Blur"
                        value={draft.wallpaperBlur}
                        min={0}
                        max={50}
                        step={1}
                        onChange={(value) => update('wallpaperBlur', value)}
                      />
                      <RangeField
                        label="Saturation"
                        value={draft.wallpaperSaturate}
                        min={0}
                        max={1}
                        step={0.01}
                        onChange={(value) => update('wallpaperSaturate', value)}
                      />
                      <RangeField
                        label="Animation speed"
                        value={draft.wallpaperSpeed}
                        min={0}
                        max={10}
                        step={0.05}
                        onChange={(value) => update('wallpaperSpeed', value)}
                      />
                      <Field>
                        <FieldLabel htmlFor="wallpaper-seed">Seed</FieldLabel>
                        <div className="flex items-center gap-2">
                          <Input
                            id="wallpaper-seed"
                            className="min-w-0"
                            value={draft.wallpaperSeed}
                            onChange={(event) => update('wallpaperSeed', event.target.value)}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              const seed = generateWallpaperSeed();
                              update('wallpaperSeed', seed);
                            }}
                          >
                            <Dices data-icon="inline-start" />
                            Generate
                          </Button>
                        </div>
                      </Field>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel htmlFor="wallpaper-follows-mouse">Follow mouse cursor</FieldLabel>
                        </FieldContent>
                        <Switch
                          id="wallpaper-follows-mouse"
                          checked={draft.wallpaperFollowsMouse}
                          onCheckedChange={(value) => update('wallpaperFollowsMouse', value)}
                        />
                      </Field>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel htmlFor="wallpaper-follows-keyboard">Follow keyboard input</FieldLabel>
                        </FieldContent>
                        <Switch
                          id="wallpaper-follows-keyboard"
                          checked={draft.wallpaperFollowsKeyboard}
                          onCheckedChange={(value) => update('wallpaperFollowsKeyboard', value)}
                        />
                      </Field>
                    </FieldGroup>
                  </FieldSet>
                </FieldGroup>
              </TabsContent>

              <TabsContent value="terminal" className="pt-4">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="color-scheme">Color scheme</FieldLabel>
                    <Select
                      value={draft.colors || 'none'}
                      onValueChange={(value) => {
                        setColorSchemeTouched(true);
                        update('colors', value === 'none' ? '' : value);
                      }}
                    >
                      <SelectTrigger id="color-scheme" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="none">Built-in default</SelectItem>
                          {config.color_schemes.map((scheme) => (
                            <SelectItem key={scheme} value={scheme}>
                              {scheme}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="font-family">Font family</FieldLabel>
                    <Select
                      value={draft.fontFamily}
                      onValueChange={(value) => {
                        const { min, max } = getFontWeightRange(config.fonts, value);
                        const nextWeight = Math.min(max, Math.max(min, draft.fontWeight));
                        update('fontFamily', value);
                        update('fontWeight', nextWeight);
                      }}
                    >
                      <SelectTrigger id="font-family" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {config.fonts.map((item) => (
                            <SelectItem key={item.family} value={item.family}>
                              {item.family}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <RangeField
                    label="Font size"
                    value={draft.fontSize}
                    min={8}
                    max={36}
                    step={1}
                    onChange={(value) => update('fontSize', value)}
                  />
                  <RangeField
                    label="Font weight"
                    value={draft.fontWeight}
                    min={weightMin}
                    max={weightMax}
                    step={100}
                    onChange={(value) => update('fontWeight', value)}
                  />
                  <Field>
                    <FieldLabel htmlFor="renderer">Renderer</FieldLabel>
                    <Select
                      value={draft.renderer}
                      onValueChange={(value) => update('renderer', value as Draft['renderer'])}
                    >
                      <SelectTrigger id="renderer" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="webgl">WebGL</SelectItem>
                          <SelectItem value="canvas">Canvas</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="cursor-style">Cursor style</FieldLabel>
                    <Select
                      value={draft.cursorStyle}
                      onValueChange={(value) => update('cursorStyle', value as Draft['cursorStyle'])}
                    >
                      <SelectTrigger id="cursor-style" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="bar">Bar</SelectItem>
                          <SelectItem value="block">Block</SelectItem>
                          <SelectItem value="underline">Underline</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="cursor-blink">Blinking cursor</FieldLabel>
                    </FieldContent>
                    <Switch
                      id="cursor-blink"
                      checked={draft.cursorBlink}
                      onCheckedChange={(value) => update('cursorBlink', value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="scrollback">Scrollback lines</FieldLabel>
                    <Input
                      id="scrollback"
                      type="number"
                      min={1}
                      max={1_000_000}
                      value={draft.scrollback}
                      onChange={(event) =>
                        update('scrollback', Math.min(1_000_000, Math.max(1, Number(event.target.value) || 1)))
                      }
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="allow-transparency">Allow transparency</FieldLabel>
                    </FieldContent>
                    <Switch
                      id="allow-transparency"
                      checked={draft.allowTransparency}
                      onCheckedChange={(value) => update('allowTransparency', value)}
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="convert-eol">Convert line endings</FieldLabel>
                    </FieldContent>
                    <Switch
                      id="convert-eol"
                      checked={draft.convertEol}
                      onCheckedChange={(value) => update('convertEol', value)}
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="disable-stdin">Disable terminal input</FieldLabel>
                    </FieldContent>
                    <Switch
                      id="disable-stdin"
                      checked={draft.disableStdin}
                      onCheckedChange={(value) => update('disableStdin', value)}
                    />
                  </Field>
                  <RangeField
                    label="Smooth scroll duration"
                    value={draft.smoothScrollDuration}
                    min={0}
                    max={2}
                    step={0.05}
                    onChange={(value) => update('smoothScrollDuration', value)}
                  />
                  <RangeField
                    label="Scroll sensitivity"
                    value={draft.scrollSensitivity}
                    min={0.1}
                    max={20}
                    step={0.1}
                    onChange={(value) => update('scrollSensitivity', value)}
                  />
                </FieldGroup>
              </TabsContent>

              <TabsContent value="effects" className="pt-4">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="shader">Terminal shader</FieldLabel>
                    <Select
                      value={draft.shader || 'none'}
                      onValueChange={(value) => update('shader', value === 'none' ? '' : value)}
                    >
                      <SelectTrigger id="shader" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="none">None</SelectItem>
                          {SHADER_EFFECTS.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="session-view-shader">Session-view background shader</FieldLabel>
                    <Select
                      value={draft.sessionViewShader || 'none'}
                      onValueChange={(value) => update('sessionViewShader', value === 'none' ? '' : value)}
                    >
                      <SelectTrigger id="session-view-shader" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="none">None</SelectItem>
                          {SHADER_EFFECTS.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="pane-switch-shader">Pane-switch shader</FieldLabel>
                    <Select
                      value={draft.paneSwitchShader || 'none'}
                      onValueChange={(value) => update('paneSwitchShader', value === 'none' ? '' : value)}
                    >
                      <SelectTrigger id="pane-switch-shader" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {PANE_SWITCH_EFFECTS.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.id === 'none' ? 'None' : item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <RangeField
                    label="Pane-switch intensity"
                    value={draft.paneSwitchIntensity}
                    min={0}
                    max={3}
                    step={0.05}
                    onChange={(value) => update('paneSwitchIntensity', value)}
                  />
                  <RangeField
                    label="Pane-switch duration"
                    value={draft.paneSwitchDuration}
                    min={0.1}
                    max={5}
                    step={0.05}
                    onChange={(value) => update('paneSwitchDuration', value)}
                  />
                  <Field>
                    <FieldLabel htmlFor="pane-switch-border">Pane-switch border draw</FieldLabel>
                    <Select
                      value={draft.paneSwitchBorderStyle || 'none'}
                      onValueChange={(value) => update('paneSwitchBorderStyle', value)}
                    >
                      <SelectTrigger id="pane-switch-border" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="none">None</SelectItem>
                          {PANE_BORDER_STYLES.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <RangeField
                    label="Pane-switch border speed (seconds)"
                    value={draft.paneSwitchBorderSpeed}
                    min={0.05}
                    max={3}
                    step={0.05}
                    onChange={(value) => update('paneSwitchBorderSpeed', value)}
                  />
                </FieldGroup>
              </TabsContent>
            </div>

            <aside className="min-w-0">
              <div className="top-4 flex flex-col gap-3 xl:sticky">
                <Field>
                  <FieldLabel htmlFor="toml-output">Generated TOML</FieldLabel>
                  <Textarea id="toml-output" readOnly value={toml} className="min-h-72 resize-none font-mono text-xs" />
                </Field>
              </div>
            </aside>
          </div>
        </div>
      </Tabs>

      <footer className="shrink-0 border-t border-border bg-background/75">
        <div className="mx-auto flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 text-xs text-muted-foreground md:px-6">
          <span>
            <KbdGroup>
              <Kbd>←</Kbd>
              <Kbd>→</Kbd>
            </KbdGroup>{' '}
            switch tabs
          </span>
          <span>
            <KbdGroup>
              <Kbd>Tab</Kbd>
            </KbdGroup>{' '}
            navigate
          </span>
          <span>
            <KbdGroup>
              <Kbd>Esc</Kbd>
              <Kbd>q</Kbd>
            </KbdGroup>{' '}
            close
          </span>
        </div>
      </footer>
    </main>
  );
}
