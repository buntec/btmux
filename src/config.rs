use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use clap::Parser;
use serde::{Deserialize, Serialize};

/// Command-line arguments. These take precedence over the file config where they overlap.
#[derive(Parser, Clone)]
#[command(name = "btmux", about = "Browser-based tmux")]
pub struct CliArgs {
    #[command(subcommand)]
    pub command: Option<SubCommand>,

    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,

    #[arg(short, long, default_value_t = 8004)]
    pub port: u16,

    /// Shell to spawn. Overrides `shell` in config.toml when passed explicitly.
    #[arg(long)]
    pub shell: Option<String>,

    /// Do not open a browser tab on startup.
    #[arg(long)]
    pub no_browser: bool,
}

#[derive(clap::Subcommand, Clone)]
pub enum SubCommand {
    /// Print the btmux version and exit.
    Version,
    /// Print a default config.toml with all settings documented and commented out.
    GenerateConfig,
    /// Install btmux as a per-user background service so it starts at login and
    /// restarts on crash. The current `--host`/`--port`/`--shell` and the
    /// installing shell's PATH are baked into the generated unit. Currently
    /// macOS-only (a launchd LaunchAgent); the OS is detected at runtime.
    Install {
        /// Print the generated service unit to stdout instead of installing it.
        #[arg(long)]
        print: bool,
    },
    /// Uninstall the background service created by `install` (stop it and remove
    /// its service unit).
    Uninstall,
    /// Restart the background service (e.g. after updating the btmux binary).
    Restart,
}

/// The btmux version, taken from `Cargo.toml` at compile time. Shown by the
/// `version` subcommand and sent to the browser in `ClientConfig` for display.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Sort order for the session list on the landing page.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SessionSort {
    /// Sessions appear in creation order (default).
    #[default]
    Created,
    /// Most recently visited session appears first.
    Mru,
    /// Sessions sorted alphabetically by name.
    Alphabetical,
}

/// Log level configuration. Both fields accept standard tracing directives
/// (`error`, `warn`, `info`, `debug`, `trace`) or full `EnvFilter` syntax.
#[derive(Deserialize, Clone, Debug)]
#[serde(default, deny_unknown_fields)]
pub struct LogConfig {
    /// Log level for stderr output. Defaults to "warn".
    #[serde(rename = "console-level")]
    pub console_level: String,
    /// Log level for the file appender. Defaults to "info".
    #[serde(rename = "file-level")]
    pub file_level: String,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            console_level: "warn".to_string(),
            file_level: "info".to_string(),
        }
    }
}

/// User config read from `config.toml`. Every field is optional so a missing or
/// partial file still yields working defaults.
#[derive(Deserialize, Clone)]
#[serde(default, deny_unknown_fields)]
pub struct FileConfig {
    /// Prefix key, tmux-style string e.g. "C-a", "C-b", "M-x".
    pub prefix: Option<String>,
    /// Shell override (CLI `--shell` still wins over this).
    pub shell: Option<String>,
    /// When true, h/j/k/l are added as additional navigation keys alongside
    /// the arrow keys. The default `l → last-window` binding is dropped since
    /// `l` becomes navigate-right; rebind it via `[keys]` if needed.
    #[serde(rename = "vi-mode")]
    pub vi_mode: bool,
    /// Enable CSS animations/transitions in the browser (e.g. border highlight
    /// when switching panes). Set to false to disable all animated effects.
    #[serde(default = "default_true")]
    pub animations: bool,
    /// URL of a background image displayed behind all terminal panes.
    pub wallpaper: Option<String>,
    /// How visible the wallpaper is: 0.0 = not visible, 1.0 = fully visible.
    /// Defaults to 0.1 when a wallpaper URL is set.
    #[serde(rename = "wallpaper-opacity")]
    pub wallpaper_opacity: Option<f32>,
    /// Gaussian blur radius in pixels applied to the wallpaper.
    /// 0 = no blur (default), higher values = more blur.
    #[serde(rename = "wallpaper-blur")]
    pub wallpaper_blur: Option<f32>,
    /// Saturation multiplier for the wallpaper: 0.0 = grayscale, 1.0 = normal.
    /// Defaults to 1.0 (no desaturation).
    #[serde(rename = "wallpaper-saturate")]
    pub wallpaper_saturate: Option<f32>,
    /// Sort order for the session list on the landing page.
    #[serde(rename = "session-sort", default)]
    pub session_sort: SessionSort,
    /// How many of the most-recently-viewed windows the window-grid
    /// (`prefix + w`) shows as live thumbnails. Defaults to 6.
    #[serde(rename = "window-grid-count")]
    pub window_grid_count: Option<u32>,
    /// Per-action key overrides: action name (kebab-case) -> key string.
    pub keys: BTreeMap<String, String>,
    /// ghostty-web terminal options (cursor, fonts, scrollback, …).
    pub terminal: TerminalOptions,
    /// Inline base16/base24 palette translated to an `ITheme` for the browser.
    pub theme: Option<BaseTheme>,
    /// Name of a color scheme file in `~/.config/btmux/colors/` (without extension).
    /// Overridden by an inline `[theme]` if both are present.
    pub colors: Option<String>,
    /// Logging configuration.
    pub log: LogConfig,
}

impl Default for FileConfig {
    fn default() -> Self {
        Self {
            prefix: None,
            shell: None,
            vi_mode: false,
            animations: true,
            wallpaper: None,
            wallpaper_opacity: None,
            wallpaper_blur: None,
            wallpaper_saturate: None,
            session_sort: SessionSort::default(),
            window_grid_count: None,
            keys: BTreeMap::new(),
            terminal: TerminalOptions::default(),
            theme: None,
            colors: None,
            log: LogConfig::default(),
        }
    }
}

fn default_true() -> bool {
    true
}

/// Mirror of ghostty-web's `ITerminalOptions`, minus the runtime/internal fields
/// (`cols`, `rows`, `ghostty`) which the frontend owns. All optional: an absent
/// field means "use the ghostty-web default" (serialized as `null`, omitted by
/// the frontend when constructing the `Terminal`). Field names are kebab-cased
/// in TOML and camelCased on the wire to match the TS interface.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(
    default,
    rename_all(serialize = "camelCase", deserialize = "kebab-case"),
    deny_unknown_fields
)]
pub struct TerminalOptions {
    pub renderer: Option<String>,
    pub cursor_blink: Option<bool>,
    pub cursor_style: Option<String>,
    pub scrollback: Option<u32>,
    pub font_size: Option<f32>,
    pub font_family: Option<String>,
    pub font_weight: Option<u16>,
    pub allow_transparency: Option<bool>,
    pub convert_eol: Option<bool>,
    pub disable_stdin: Option<bool>,
    pub smooth_scroll_duration: Option<f32>,
    /// Wheel/trackpad scroll-speed multiplier for scrollback (1.0 = ghostty-web
    /// default). Higher moves more lines per wheel notch / gesture. Applied by
    /// the patched ghostty-web `handleWheel`; not part of upstream ITerminalOptions.
    pub scroll_sensitivity: Option<f32>,
}

impl Default for TerminalOptions {
    fn default() -> Self {
        Self {
            renderer: Some("webgl".to_string()),
            cursor_blink: Some(true),
            cursor_style: Some("bar".to_string()),
            scrollback: Some(10000),
            font_size: Some(18.0),
            font_family: Some("Geist Mono".to_string()),
            font_weight: Some(400),
            allow_transparency: None,
            convert_eol: None,
            disable_stdin: None,
            smooth_scroll_duration: None,
            scroll_sensitivity: Some(5.0),
        }
    }
}

/// An inline base16/base24 palette. base16 uses base00–base0F; base24 adds
/// base10–base17 for dedicated bright/extra-background colors. Which system is
/// in use is auto-detected by the presence of base10–base17 (see `to_theme`).
/// Each value is a CSS color string (e.g. "#1e1e2e").
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BaseTheme {
    pub base00: String,
    pub base01: String,
    pub base02: String,
    pub base03: String,
    pub base04: String,
    pub base05: String,
    pub base06: String,
    pub base07: String,
    pub base08: String,
    pub base09: String,
    #[serde(rename = "base0A")]
    pub base0a: String,
    #[serde(rename = "base0B")]
    pub base0b: String,
    #[serde(rename = "base0C")]
    pub base0c: String,
    #[serde(rename = "base0D")]
    pub base0d: String,
    #[serde(rename = "base0E")]
    pub base0e: String,
    #[serde(rename = "base0F")]
    pub base0f: String,
    // base24 extension (all-or-nothing; presence flips to the base24 mapping).
    pub base10: Option<String>,
    pub base11: Option<String>,
    pub base12: Option<String>,
    pub base13: Option<String>,
    pub base14: Option<String>,
    pub base15: Option<String>,
    pub base16: Option<String>,
    pub base17: Option<String>,
}

/// The terminal color theme sent to the browser, matching ghostty-web's
/// `ITheme`: default fg/bg/cursor/selection plus the 16 named ANSI colors.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    pub cursor_accent: String,
    pub selection_background: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

impl BaseTheme {
    /// Whether all eight base24 slots (base10–base17) are present. base24 is
    /// all-or-nothing: a partial set falls back to the base16 mapping.
    fn is_base24(&self) -> bool {
        self.base10.is_some()
            && self.base11.is_some()
            && self.base12.is_some()
            && self.base13.is_some()
            && self.base14.is_some()
            && self.base15.is_some()
            && self.base16.is_some()
            && self.base17.is_some()
    }

    /// Translate to an `ITheme`. The 16 ANSI colors follow the canonical
    /// tinted-theming mapping. For base16, bright variants reuse the normal
    /// accent colors (except bright-black=base03, bright-white=base07). For
    /// base24, the dedicated bright slots base12–base17 are used instead.
    pub fn to_theme(&self) -> Theme {
        // Shared base16 ANSI mapping.
        let mut theme = Theme {
            foreground: self.base05.clone(),
            background: self.base00.clone(),
            cursor: self.base05.clone(),
            cursor_accent: self.base00.clone(),
            selection_background: self.base02.clone(),
            black: self.base00.clone(),
            red: self.base08.clone(),
            green: self.base0b.clone(),
            yellow: self.base0a.clone(),
            blue: self.base0d.clone(),
            magenta: self.base0e.clone(),
            cyan: self.base0c.clone(),
            white: self.base05.clone(),
            bright_black: self.base03.clone(),
            // base16 bright colors reuse the normal accents; overridden below for base24.
            bright_red: self.base08.clone(),
            bright_green: self.base0b.clone(),
            bright_yellow: self.base0a.clone(),
            bright_blue: self.base0d.clone(),
            bright_magenta: self.base0e.clone(),
            bright_cyan: self.base0c.clone(),
            bright_white: self.base07.clone(),
        };

        if self.is_base24() {
            // base24 dedicates base12–base17 to the bright ANSI colors.
            theme.bright_red = self.base12.clone().unwrap();
            theme.bright_yellow = self.base13.clone().unwrap();
            theme.bright_green = self.base14.clone().unwrap();
            theme.bright_cyan = self.base15.clone().unwrap();
            theme.bright_blue = self.base16.clone().unwrap();
            theme.bright_magenta = self.base17.clone().unwrap();
        }

        theme
    }
}

/// A single resolved key binding sent to the browser.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Bind {
    pub key: String,
    pub action: String,
}

/// A runnable entry in the in-browser command palette (prefix + `:`). `id` is the
/// kebab-case command name matched server-side in `run_palette_command`; `confirm`
/// is `Some(prompt)` for destructive commands (the frontend shows a y/n confirm
/// with that text before running) and `None` otherwise. This is a static built-in
/// registry — see `default_commands`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Command {
    pub id: String,
    pub label: String,
    pub description: String,
    pub confirm: Option<String>,
}

/// The built-in command-palette registry sent to the browser in `ClientConfig`.
fn default_commands() -> Vec<Command> {
    vec![
        Command {
            id: "select-layout-even-horizontal".to_string(),
            label: "layout: even-horizontal".to_string(),
            description: "Arrange panes in a single evenly-sized row.".to_string(),
            confirm: None,
        },
        Command {
            id: "select-layout-even-vertical".to_string(),
            label: "layout: even-vertical".to_string(),
            description: "Arrange panes in a single evenly-sized column.".to_string(),
            confirm: None,
        },
        Command {
            id: "select-layout-main-vertical".to_string(),
            label: "layout: main-vertical".to_string(),
            description: "Large main pane on the left, the rest stacked on the right.".to_string(),
            confirm: None,
        },
        Command {
            id: "select-layout-main-horizontal".to_string(),
            label: "layout: main-horizontal".to_string(),
            description: "Large main pane on top, the rest in a row below.".to_string(),
            confirm: None,
        },
        Command {
            id: "select-layout-tiled".to_string(),
            label: "layout: tiled".to_string(),
            description: "Arrange panes in an even grid.".to_string(),
            confirm: None,
        },
        Command {
            id: "create-sessions-from-git-repos".to_string(),
            label: "create sessions from git repos".to_string(),
            description: "For each git repo under the active pane's directory, \
                create a session named after the repo, with one window per worktree."
                .to_string(),
            confirm: None,
        },
        Command {
            id: "clear-sessions".to_string(),
            label: "clear sessions".to_string(),
            description: "Kill every session and reset to a single fresh session.".to_string(),
            confirm: Some("Kill ALL sessions and reset to one fresh session?".to_string()),
        },
        Command {
            id: "choose-colors".to_string(),
            label: "colors: choose scheme".to_string(),
            description: "Pick a color scheme from ~/.config/btmux/colors/.".to_string(),
            confirm: None,
        },
        Command {
            id: "choose-font".to_string(),
            label: "font: choose family".to_string(),
            description: "Pick a font from the bundled families.".to_string(),
            confirm: None,
        },
        Command {
            id: "choose-font-weight".to_string(),
            label: "font: choose weight".to_string(),
            description: "Pick a font weight for the current font.".to_string(),
            confirm: None,
        },
    ]
}

/// Bundled font families available in the frontend.
pub const BUNDLED_FONTS: &[FontInfo] = &[
    FontInfo {
        family: "JetBrains Mono",
        weight_min: 100,
        weight_max: 800,
    },
    FontInfo {
        family: "Fira Code",
        weight_min: 300,
        weight_max: 700,
    },
    FontInfo {
        family: "Cascadia Code",
        weight_min: 200,
        weight_max: 700,
    },
    FontInfo {
        family: "Source Code Pro",
        weight_min: 200,
        weight_max: 900,
    },
    FontInfo {
        family: "Geist Mono",
        weight_min: 400,
        weight_max: 700,
    },
    FontInfo {
        family: "Departure Mono",
        weight_min: 400,
        weight_max: 400,
    },
];

pub struct FontInfo {
    pub family: &'static str,
    pub weight_min: u16,
    pub weight_max: u16,
}

/// Serializable font entry sent to the browser.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FontEntry {
    pub family: String,
    pub weight_min: u16,
    pub weight_max: u16,
}

/// Fully resolved config the frontend needs: the active prefix, the second-key
/// bind table, ghostty-web terminal options, and the resolved color theme. This
/// is the single source of truth — the browser renders it directly.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ClientConfig {
    pub prefix: String,
    pub binds: Vec<Bind>,
    /// Built-in command-palette entries (prefix + `:`).
    pub commands: Vec<Command>,
    pub terminal: TerminalOptions,
    /// Resolved `ITheme`, or `null` when no `[theme]` is configured (the frontend
    /// then falls back to its built-in default theme).
    pub theme: Option<Theme>,
    pub vi_mode: bool,
    /// Whether CSS animations/transitions are enabled in the browser.
    pub animations: bool,
    /// URL of a background image displayed behind all terminal panes, or `null`.
    /// When the user specifies a local file path, this is rewritten to `"/wallpaper"`.
    pub wallpaper: Option<String>,
    /// The resolved absolute path to a local wallpaper file, if any. Not sent to
    /// the browser — used by the `/wallpaper` route to serve the file.
    #[serde(skip)]
    pub wallpaper_path: Option<std::path::PathBuf>,
    /// Opacity of the wallpaper: 0.0 = invisible, 1.0 = fully visible.
    /// Always `Some` when `wallpaper` is `Some` (defaults to 1.0).
    pub wallpaper_opacity: Option<f32>,
    /// Blur radius in pixels for the wallpaper. `None` when no wallpaper.
    pub wallpaper_blur: Option<f32>,
    /// Saturation multiplier for the wallpaper: 0.0 = grayscale, 1.0 = normal.
    pub wallpaper_saturate: Option<f32>,
    /// Sort order for the session list on the landing page.
    pub session_sort: SessionSort,
    /// How many recently-viewed windows the window-grid (`prefix + w`) shows.
    pub window_grid_count: u32,
    /// btmux version (compile-time `CARGO_PKG_VERSION`), shown in the UI.
    pub version: String,
    /// Available color scheme names from `~/.config/btmux/colors/`.
    pub color_schemes: Vec<String>,
    /// Currently active color scheme name (from `colors` in config.toml), or null.
    pub active_color_scheme: Option<String>,
    /// Bundled font families with their available weight ranges.
    pub fonts: Vec<FontEntry>,
}

pub const DEFAULT_PREFIX: &str = "C-b";

/// Canonical tmux-style default binds: (key, action). Actions map 1:1 to a
/// frontend handler. Note `0-9` window-select is special-cased in the frontend
/// and intentionally absent here, as is `kill-session` (unbound by default).
const DEFAULT_BINDS: &[(&str, &str)] = &[
    ("%", "split-vertical"),
    ("\"", "split-horizontal"),
    ("ArrowLeft", "navigate-left"),
    ("ArrowRight", "navigate-right"),
    ("ArrowUp", "navigate-up"),
    ("ArrowDown", "navigate-down"),
    ("x", "kill-pane"),
    ("z", "zoom-pane"),
    ("[", "capture-pane"),
    ("c", "new-window"),
    ("n", "next-window"),
    ("p", "prev-window"),
    (",", "rename-window"),
    ("&", "kill-window"),
    ("C", "new-session"),
    ("s", "choose-session"),
    ("w", "window-grid"),
    (")", "next-session"),
    ("(", "prev-session"),
    ("$", "rename-session"),
    ("l", "last-window"),
    ("L", "last-session"),
    ("o", "next-pane"),
    ("{", "swap-pane-back"),
    ("}", "swap-pane-forward"),
    (" ", "next-layout"),
    ("q", "display-panes"),
    ("d", "detach"),
    (";", "last-pane"),
    ("?", "list-keys"),
    (":", "command-palette"),
];

/// Resolve the config file path: `$XDG_CONFIG_HOME/btmux/config.toml`, falling
/// back to `$HOME/.config/btmux/config.toml`.
pub fn config_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("btmux").join("config.toml"))
}

/// Resolve the colors directory: `$XDG_CONFIG_HOME/btmux/colors/`, falling back
/// to `$HOME/.config/btmux/colors/`.
pub fn colors_dir() -> Option<PathBuf> {
    config_path().map(|p| p.parent().unwrap().join("colors"))
}

/// Load a color scheme YAML file by name from the colors directory. Forgiving:
/// looks for base00–base0F (and optionally base10–base17) at the top level or
/// under a `palette` key. Returns `None` if the file doesn't exist or doesn't
/// contain the required keys.
pub fn load_color_scheme(name: &str) -> Option<BaseTheme> {
    let dir = colors_dir()?;
    let yaml_path = dir.join(format!("{name}.yaml"));
    let path = if yaml_path.exists() {
        yaml_path
    } else {
        let yml_path = dir.join(format!("{name}.yml"));
        if yml_path.exists() {
            yml_path
        } else {
            tracing::warn!("color scheme '{name}' not found in {}", dir.display());
            return None;
        }
    };

    let contents = std::fs::read_to_string(&path).ok()?;
    let doc: HashMap<String, serde_yaml::Value> = serde_yaml::from_str(&contents).ok()?;

    // Try top-level first, then under a "palette" key.
    let palette = extract_palette(&doc).or_else(|| {
        doc.get("palette")
            .and_then(|v| {
                serde_yaml::from_value::<HashMap<String, serde_yaml::Value>>(v.clone()).ok()
            })
            .and_then(|m| extract_palette(&m))
    });

    if palette.is_none() {
        tracing::warn!(
            "color scheme '{}' does not contain base00–base0F",
            path.display()
        );
    }
    palette
}

/// Try to extract a BaseTheme from a flat map of string keys. Accepts values
/// that are either plain strings (`"#abc123"`) or integers (which get formatted
/// as zero-padded 6-digit hex).
fn extract_palette(map: &HashMap<String, serde_yaml::Value>) -> Option<BaseTheme> {
    let get = |key: &str| -> Option<String> {
        map.get(key).and_then(|v| match v {
            serde_yaml::Value::String(s) => {
                let s = s.trim().trim_start_matches('#');
                Some(format!("#{s}"))
            }
            serde_yaml::Value::Number(n) => {
                // Some schemes store colors as bare hex integers.
                n.as_u64().map(|i| format!("#{:06x}", i & 0xFFFFFF))
            }
            _ => None,
        })
    };

    // Require all base16 keys.
    let theme = BaseTheme {
        base00: get("base00")?,
        base01: get("base01")?,
        base02: get("base02")?,
        base03: get("base03")?,
        base04: get("base04")?,
        base05: get("base05")?,
        base06: get("base06")?,
        base07: get("base07")?,
        base08: get("base08")?,
        base09: get("base09")?,
        base0a: get("base0A").or_else(|| get("base0a"))?,
        base0b: get("base0B").or_else(|| get("base0b"))?,
        base0c: get("base0C").or_else(|| get("base0c"))?,
        base0d: get("base0D").or_else(|| get("base0d"))?,
        base0e: get("base0E").or_else(|| get("base0e"))?,
        base0f: get("base0F").or_else(|| get("base0f"))?,
        // base24 extension — all optional.
        base10: get("base10"),
        base11: get("base11"),
        base12: get("base12"),
        base13: get("base13"),
        base14: get("base14"),
        base15: get("base15"),
        base16: get("base16"),
        base17: get("base17"),
    };

    Some(theme)
}

/// List available color scheme names (filenames without extension) from the
/// colors directory. Returns an empty vec if the directory doesn't exist.
pub fn list_color_schemes() -> Vec<String> {
    let Some(dir) = colors_dir() else {
        return vec![];
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return vec![];
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let ext = path.extension()?.to_str()?;
            if ext == "yaml" || ext == "yml" {
                path.file_stem()?.to_str().map(String::from)
            } else {
                None
            }
        })
        .collect();
    names.sort();
    names
}

/// Load and parse the config file. A missing file writes a commented-out default
/// and returns defaults; a parse error is surfaced to the caller (which logs it
/// and keeps the last good config).
pub fn load(path: &std::path::Path) -> Result<FileConfig, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => toml::from_str(&contents).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(path, generate_config_toml());
            Ok(FileConfig::default())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Return an annotated default config.toml. Every field is commented out so the
/// file compiles as TOML and shows the default value without overriding anything.
pub fn generate_config_toml() -> String {
    let mut binds: Vec<(&str, &str)> = DEFAULT_BINDS.to_vec();
    binds.sort_by_key(|(_, action)| *action);
    let keys_lines: String = binds
        .iter()
        .map(|(key, action)| {
            let escaped = key.replace('"', "\\\"");
            format!("# {action} = \"{escaped}\"\n")
        })
        .collect();

    format!(
        r##"# btmux configuration
# Generated by `btmux generate-config`. All values are the built-in defaults.
# Uncomment and edit any line to override that setting.

# Prefix key (tmux-style). Modifiers: C- (ctrl), M- (alt), S- (shift).
# prefix = "{DEFAULT_PREFIX}"

# Shell to spawn in new panes. Defaults to $SHELL / /bin/bash.
# shell = "/bin/bash"

# Enable vi-style navigation after the prefix:
#   h/l  → navigate panes left/right (alongside arrow keys)
#   j/k  → cycle sessions next/prev  (alongside ) and ()
# The default `l → last-window` binding is dropped because `l` becomes
# navigate-right; rebind it via `[keys]` if you need it.
# vi-mode = false

# Enable CSS animations/transitions in the browser (e.g. border highlight when
# switching panes). Set to false to disable all animated effects.
# animations = true

# Background wallpaper image displayed behind all terminal panes.
# Accepts a URL or a local file path (absolute or ~/relative).
# wallpaper = "https://example.com/bg.jpg"
# wallpaper = "~/Pictures/bg.png"
# How visible the wallpaper is: 0.0 = not visible, 1.0 = fully visible.
# wallpaper-opacity = 0.1
# Gaussian blur radius in pixels applied to the wallpaper. 0 = no blur.
# wallpaper-blur = 0.0
# Saturation multiplier: 0.0 = grayscale, 1.0 = normal color.
# wallpaper-saturate = 1.0

# Sort order for the session list on the landing page.
# "created" = creation order (default), "mru" = most recently visited first,
# "alphabetical" = sorted by name.
# session-sort = "created"

# How many recently-viewed windows the window-grid (prefix + w) shows as live
# thumbnails, laid out on a square-ish grid.
# window-grid-count = 6

# Per-action key overrides. Uncomment a line to rebind that action.
# [keys]
{keys_lines}
# ghostty-web terminal options. All are optional; absent fields use btmux's
# built-in defaults shown below.
# [terminal]
# renderer = "webgl"        # "canvas" | "webgl" (default; falls back to canvas)
# cursor-blink = true
# cursor-style = "bar"      # "block" | "underline" | "bar"
# scrollback = 10000
# font-size = 18.0
# font-family = "Geist Mono"        # bundled: "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", "Geist Mono", "Departure Mono"
# font-weight = 400           # bold = font-weight + 200 (capped at 900)
#                              # bundled weight ranges: JetBrains Mono 100-800, Fira Code 300-700,
#                              # Source Code Pro 200-900, Cascadia Code 200-700, Geist Mono 400-700, Departure Mono 400
# allow-transparency = false
# convert-eol = false
# disable-stdin = false
# smooth-scroll-duration = 0.0
# scroll-sensitivity = 5.0   # wheel/trackpad scroll-speed multiplier (>1 = faster)

# Logging configuration. Both levels accept standard tracing directives:
# "error", "warn", "info", "debug", "trace", or full EnvFilter syntax like
# "btmux=debug,tower_http=info".
# [log]
# console-level = "warn"    # stderr output (keep the terminal quiet)
# file-level = "info"       # file output (~/.local/state/btmux/log/btmux.log.YYYY-MM-DD)

# Color scheme from ~/.config/btmux/colors/<name>.yaml (base16/base24 YAML files).
# An inline [theme] below overrides this.
# colors = "catppuccin-mocha"

# Inline base16 color palette. Uncomment the entire [theme] block to activate.
# [theme]
# base00 = "#1e1e2e"  # background
# base01 = "#181825"  # alt background
# base02 = "#313244"  # selection background
# base03 = "#585b70"  # comments / bright-black
# base04 = "#45475a"  # dark foreground
# base05 = "#cdd6f4"  # foreground
# base06 = "#f5e0dc"  # light foreground
# base07 = "#b4befe"  # light background / bright-white
# base08 = "#f38ba8"  # red / variables
# base09 = "#fab387"  # orange
# base0A = "#f9e2af"  # yellow
# base0B = "#a6e3a1"  # green
# base0C = "#94e2d5"  # cyan
# base0D = "#89b4fa"  # blue
# base0E = "#cba4f7"  # magenta
# base0F = "#f2cdcd"  # brown / special
"##
    )
}

/// vi-mode extra binds: (key, action). These supplement the arrow-key defaults.
/// `l` conflicts with the `last-window` default so that binding is dropped when
/// vi mode is active (users can restore it via `[keys]` if needed).
const VI_BINDS: &[(&str, &str)] = &[
    ("h", "navigate-left"),
    ("j", "navigate-down"),
    ("k", "navigate-up"),
    ("l", "navigate-right"),
];

/// Merge a FileConfig's `[keys]` overrides over the default bind table to produce
/// the ClientConfig the browser consumes. An override moves the action onto a new
/// key (the action's old default key is dropped); identical-key collisions take
/// the override.
pub fn resolve_binds(file: &FileConfig) -> ClientConfig {
    // Primary table: one canonical key per action (used for the ? overlay and
    // for user overrides).
    let mut by_action: BTreeMap<String, String> = DEFAULT_BINDS
        .iter()
        .map(|(k, a)| (a.to_string(), k.to_string()))
        .collect();

    // vi-mode: drop `l → last-window` since `l` becomes navigate-right.
    if file.vi_mode {
        by_action.remove("last-window");
    }

    for (action, key) in &file.keys {
        by_action.insert(action.clone(), key.clone());
    }

    let mut binds: Vec<Bind> = by_action
        .into_iter()
        .map(|(action, key)| Bind { key, action })
        .collect();

    // vi-mode: append extra hjkl binds (the arrow-key binds remain).
    if file.vi_mode {
        for (key, action) in VI_BINDS {
            // Only add if not already covered by a user override on this key.
            if !binds.iter().any(|b| b.key == *key) {
                binds.push(Bind {
                    key: key.to_string(),
                    action: action.to_string(),
                });
            }
        }
    }

    let wallpaper_opacity = if file.wallpaper.is_some() {
        Some(file.wallpaper_opacity.unwrap_or(0.1).clamp(0.0, 1.0))
    } else {
        None
    };
    let wallpaper_blur = if file.wallpaper.is_some() {
        Some(file.wallpaper_blur.unwrap_or(0.0).max(0.0))
    } else {
        None
    };
    let wallpaper_saturate = if file.wallpaper.is_some() {
        Some(file.wallpaper_saturate.unwrap_or(1.0).clamp(0.0, 1.0))
    } else {
        None
    };

    // Inline [theme] takes priority; fall back to `colors` scheme file.
    let theme = file.theme.as_ref().map(BaseTheme::to_theme).or_else(|| {
        file.colors
            .as_deref()
            .and_then(load_color_scheme)
            .map(|bt| bt.to_theme())
    });

    let (wallpaper_url, wallpaper_path) = match &file.wallpaper {
        Some(raw) if raw.starts_with('/') => (
            Some("/wallpaper".to_string()),
            Some(std::path::PathBuf::from(raw)),
        ),
        Some(raw) if raw.starts_with('~') => {
            let expanded = if let Ok(home) = std::env::var("HOME") {
                std::path::PathBuf::from(home).join(raw.strip_prefix("~/").unwrap_or(&raw[1..]))
            } else {
                std::path::PathBuf::from(raw)
            };
            (Some("/wallpaper".to_string()), Some(expanded))
        }
        other => (other.clone(), None),
    };

    ClientConfig {
        prefix: file
            .prefix
            .clone()
            .unwrap_or_else(|| DEFAULT_PREFIX.to_string()),
        binds,
        commands: default_commands(),
        terminal: file.terminal.clone(),
        theme,
        vi_mode: file.vi_mode,
        animations: file.animations,
        wallpaper: wallpaper_url,
        wallpaper_path,
        wallpaper_opacity,
        wallpaper_blur,
        wallpaper_saturate,
        session_sort: file.session_sort.clone(),
        window_grid_count: file.window_grid_count.unwrap_or(6),
        version: VERSION.to_string(),
        color_schemes: list_color_schemes(),
        active_color_scheme: file.colors.clone(),
        fonts: BUNDLED_FONTS
            .iter()
            .map(|f| FontEntry {
                family: f.family.to_string(),
                weight_min: f.weight_min,
                weight_max: f.weight_max,
            })
            .collect(),
    }
}

/// A partial config update request from the browser.
#[derive(Deserialize, Debug)]
pub struct ConfigUpdate {
    pub colors: Option<String>,
    pub font_family: Option<String>,
    pub font_weight: Option<u16>,
}

/// Apply a partial config update to the config file on disk. Reads the file as
/// raw TOML, patches the relevant keys, and writes it back. The file-watcher
/// then triggers the normal reload path.
pub fn apply_config_update(update: &ConfigUpdate) -> Result<(), String> {
    let path = config_path().ok_or("cannot resolve config path")?;
    let contents = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc: toml::Table = contents.parse::<toml::Table>().map_err(|e| e.to_string())?;

    if let Some(colors) = &update.colors {
        if colors.is_empty() {
            doc.remove("colors");
        } else {
            doc.insert("colors".to_string(), toml::Value::String(colors.clone()));
        }
        // Remove inline [theme] when switching to a named scheme.
        doc.remove("theme");
    }

    if update.font_family.is_some() || update.font_weight.is_some() {
        let terminal = doc
            .entry("terminal")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut()
            .ok_or("[terminal] is not a table")?;

        if let Some(family) = &update.font_family {
            terminal.insert(
                "font-family".to_string(),
                toml::Value::String(family.clone()),
            );
        }
        if let Some(weight) = update.font_weight {
            terminal.insert(
                "font-weight".to_string(),
                toml::Value::Integer(weight as i64),
            );
        }
    }

    let output = toml::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, output).map_err(|e| e.to_string())?;
    Ok(())
}
