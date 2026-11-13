//! Writes settings from the browser into config.toml, keeping its comments,
//! formatting, and the settings the browser doesn't edit.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;
use toml_edit::{Array, ArrayOfTables, DocumentMut, InlineTable, Item, Table, TableLike, Value};

use super::{ConfigUpdate, FileConfig, ShaderLayers, ShaderValue, MAX_FONT_SIZE, MIN_FONT_SIZE};

/// A merged config.toml, checked but not yet written.
pub struct Saved {
    path: PathBuf,
    target: PathBuf,
    pub text: String,
    pub config: FileConfig,
}

/// Merge `update` into the config file at `path`. A symlinked file is written
/// through the link, so a link into a dotfiles repo stays one; a read-only
/// file (Nix, Home Manager) is an error.
pub fn render(path: &Path, update: &ConfigUpdate) -> Result<Saved, String> {
    let target = target(path)?;
    let text = match std::fs::read_to_string(&target) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
        Err(e) => return Err(io_error(path, &target, &e)),
    };
    let mut doc: DocumentMut = text
        .parse()
        .map_err(|_| format!("{} isn't valid TOML; fix it first", path.display()))?;
    apply(&mut doc, update);
    let text = doc.to_string();
    // Never write a file the next reload would reject.
    let config = toml::from_str(&text).map_err(|e| format!("Couldn't save settings: {e}"))?;
    Ok(Saved {
        path: path.to_path_buf(),
        target,
        text,
        config,
    })
}

impl Saved {
    pub fn write(&self) -> Result<(), String> {
        write(&self.target, &self.text).map_err(|e| io_error(&self.path, &self.target, &e))
    }
}

/// The file to write: `path` with symlinks resolved.
fn target(path: &Path) -> Result<PathBuf, String> {
    let target = match std::fs::canonicalize(path) {
        Ok(target) => target,
        Err(e) if e.kind() == ErrorKind::NotFound && !is_symlink(path) => path.to_path_buf(),
        Err(e) => return Err(io_error(path, path, &e)),
    };
    if is_nix(&target) {
        return Err(read_only(path, &target));
    }
    match std::fs::metadata(&target) {
        Ok(meta) if meta.permissions().readonly() => Err(read_only(path, &target)),
        _ => Ok(target),
    }
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

fn is_nix(target: &Path) -> bool {
    target.starts_with("/nix/store")
}

/// Write beside the target and rename over it, so a reload never reads half a file.
fn write(target: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    let dir = target.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let (tmp, mut file) = loop {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!(".config.toml.{}.{n}.tmp", std::process::id()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => break (tmp, file),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    };
    let result = file
        .write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .and_then(|()| match std::fs::metadata(target) {
            Ok(meta) => std::fs::set_permissions(&tmp, meta.permissions()),
            Err(_) => Ok(()),
        })
        .and_then(|()| std::fs::rename(&tmp, target));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn read_only(path: &Path, target: &Path) -> String {
    let managed = if is_nix(target) {
        " (managed by Nix)"
    } else {
        ""
    };
    format!(
        "{} is read-only{managed}. Copy the settings from Show TOML into your config instead.",
        path.display()
    )
}

fn io_error(path: &Path, target: &Path, e: &std::io::Error) -> String {
    match e.kind() {
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => read_only(path, target),
        _ => format!("Couldn't save {}: {e}", path.display()),
    }
}

/// Edits for one table: a key with `None` is removed.
type Edits = Vec<(&'static str, Option<Value>)>;

fn apply(doc: &mut DocumentMut, u: &ConfigUpdate) {
    let mut root = Edits::new();
    let mut terminal = Edits::new();
    let mut log = Edits::new();
    let mut notifications = Edits::new();

    if let Some(prefix) = &u.prefix {
        push(&mut root, "prefix", text(prefix));
    }
    if let Some(shell) = &u.shell {
        push(&mut root, "shell", text(shell));
    }
    if let Some(v) = u.show_pane_titles {
        push(&mut root, "show-pane-titles", Some(v.into()));
    }
    if let Some(v) = &u.session_sort {
        push(&mut root, "session-sort", name(v));
    }
    if let Some(v) = &u.window_sort {
        push(&mut root, "window-sort", name(v));
    }
    if let Some(v) = &u.editor {
        push(&mut root, "editor", name(v));
    }
    if let Some(v) = u.window_grid_count {
        push(
            &mut root,
            "window-grid-count",
            Some(i64::from(v.clamp(1, 24)).into()),
        );
    }
    if let Some(v) = &u.appearance {
        push(&mut root, "appearance", name(v));
    }
    // An inline palette outranks `colors-*`, as in `resolve_with_overrides`.
    if let Some(v) = &u.colors_dark {
        push(&mut root, "colors-dark", text(v));
        doc.remove("theme-dark");
    }
    if let Some(v) = &u.colors_light {
        push(&mut root, "colors-light", text(v));
        doc.remove("theme-light");
    }
    if let Some(v) = u.animations {
        push(&mut root, "animations", Some(v.into()));
    }
    if let Some(v) = &u.wallpaper {
        push(&mut root, "wallpaper", text(v));
    }
    let floats = [
        ("wallpaper-opacity", u.wallpaper_opacity, 0.0, 1.0),
        (
            "desktop-background-opacity",
            u.desktop_background_opacity,
            0.0,
            1.0,
        ),
        ("wallpaper-blur", u.wallpaper_blur, 0.0, 50.0),
        ("wallpaper-saturate", u.wallpaper_saturate, 0.0, 1.0),
        ("wallpaper-speed", u.wallpaper_speed, 0.0, 10.0),
        ("wallpaper-resolution", u.wallpaper_resolution, 0.1, 1.0),
        ("backdrop-blur", u.backdrop_blur, 0.0, 50.0),
        ("backdrop-dim", u.backdrop_dim, 0.0, 1.0),
        (
            "pane-switch-border-speed",
            u.pane_switch_border_speed,
            0.05,
            1.0,
        ),
    ];
    for (key, v, min, max) in floats {
        if let Some(v) = v {
            push(&mut root, key, Some(float(v.clamp(min, max))));
        }
    }
    if let Some(v) = u.wallpaper_fps {
        push(
            &mut root,
            "wallpaper-fps",
            Some(i64::from(v.clamp(10, 60)).into()),
        );
    }
    if let Some(v) = u.wallpaper_shader_follows_mouse_cursor {
        push(
            &mut root,
            "wallpaper-shader-follows-mouse-cursor",
            Some(v.into()),
        );
    }
    if let Some(v) = u.wallpaper_shader_follows_keyboard_input {
        push(
            &mut root,
            "wallpaper-shader-follows-keyboard-input",
            Some(v.into()),
        );
    }
    if let Some(v) = &u.pane_switch_border {
        let style = if v.is_empty() { "none" } else { v };
        push(&mut root, "pane-switch-border", Some(style.into()));
    }

    if let Some(v) = &u.font_family {
        push(&mut terminal, "font-family", text(v));
    }
    if let Some(v) = u.font_weight {
        push(&mut terminal, "font-weight", Some(i64::from(v).into()));
    }
    if let Some(v) = u.font_size {
        let size = v.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
        push(&mut terminal, "font-size", Some(float(size)));
    }
    if let Some(v) = u.cursor_blink {
        push(&mut terminal, "cursor-blink", Some(v.into()));
    }
    if let Some(v) = u.scrollback {
        push(
            &mut terminal,
            "scrollback",
            Some(i64::from(v.max(1)).into()),
        );
    }
    if let Some(v) = u.allow_transparency {
        push(&mut terminal, "allow-transparency", Some(v.into()));
    }
    if let Some(v) = u.disable_stdin {
        push(&mut terminal, "disable-stdin", Some(v.into()));
    }
    if let Some(v) = u.macos_edit_keys {
        push(&mut terminal, "macos-edit-keys", Some(v.into()));
    }
    if let Some(v) = u.smooth_scroll_duration {
        push(
            &mut terminal,
            "smooth-scroll-duration",
            Some(float(v.max(0.0))),
        );
    }
    if let Some(v) = u.cursor_animation_duration {
        push(
            &mut terminal,
            "cursor-animation-duration",
            Some(float(v.max(0.0))),
        );
    }
    if let Some(v) = u.cell_background_opacity {
        push(
            &mut terminal,
            "cell-background-opacity",
            Some(float(v.clamp(0.0, 1.0))),
        );
    }

    if let Some(v) = &u.console_level {
        push(&mut log, "console-level", Some(v.as_str().into()));
    }
    if let Some(v) = &u.file_level {
        push(&mut log, "file-level", Some(v.as_str().into()));
    }
    if let Some(v) = u.os_notifications {
        push(&mut notifications, "os", Some(v.into()));
    }
    if let Some(v) = &u.os_notification_level {
        push(&mut notifications, "os-level", name(v));
    }

    edit(doc.as_table_mut(), root);
    for (name, edits) in [
        ("terminal", terminal),
        ("log", log),
        ("notifications", notifications),
    ] {
        if !edits.is_empty() {
            edit(section(doc, name), edits);
        }
    }
    if let Some(keys) = u.keys.as_ref().filter(|keys| !keys.is_empty()) {
        let table = section(doc, "keys");
        for (action, key) in keys {
            set(table, action, Some(key.as_str().into()));
        }
    }
    if let Some(layers) = &u.wallpaper_shaders {
        if layers.is_empty() {
            doc.remove("wallpaper-shader");
        } else {
            doc.insert(
                "wallpaper-shader",
                Item::ArrayOfTables(shader_tables(layers)),
            );
        }
    }
}

fn push(edits: &mut Edits, key: &'static str, value: Option<Value>) {
    edits.push((key, value));
}

fn edit(table: &mut dyn TableLike, edits: Edits) {
    for (key, value) in edits {
        set(table, key, value);
    }
}

/// Set or remove `key`, keeping a replaced value's comment.
fn set(table: &mut dyn TableLike, key: &str, value: Option<Value>) {
    let Some(mut value) = value else {
        table.remove(key);
        return;
    };
    match table.get_mut(key) {
        Some(Item::Value(old)) => {
            *value.decor_mut() = old.decor().clone();
            *old = value;
        }
        _ => {
            table.insert(key, Item::Value(value));
        }
    }
}

/// The table `name`, created when missing.
fn section<'a>(doc: &'a mut DocumentMut, name: &str) -> &'a mut dyn TableLike {
    if !doc.get(name).is_some_and(Item::is_table_like) {
        doc.insert(name, Item::Table(Table::new()));
    }
    doc[name].as_table_like_mut().expect("table")
}

/// A string setting; the empty string clears it.
fn text(value: &str) -> Option<Value> {
    (!value.trim().is_empty()).then(|| value.into())
}

/// An enum's config name.
fn name(value: &impl Serialize) -> Option<Value> {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(Value::from))
}

/// An `f32` as written (`0.1`, not `0.10000000149011612`).
fn float(value: f32) -> Value {
    value
        .to_string()
        .parse::<f64>()
        .unwrap_or(f64::from(value))
        .into()
}

fn shader_tables(layers: &ShaderLayers) -> ArrayOfTables {
    let mut tables = ArrayOfTables::new();
    for layer in layers.iter() {
        let mut table = Table::new();
        table.insert("shader", layer.shader.as_str().into());
        if !layer.enabled {
            table.insert("enabled", false.into());
        }
        if let Some(mode) = name(&layer.blend_mode).filter(|m| m.as_str() != Some("normal")) {
            table.insert("blend-mode", Item::Value(mode));
        }
        if layer.opacity != 1.0 {
            table.insert("opacity", Item::Value(float(layer.opacity)));
        }
        if !layer.interactive {
            table.insert("interactive", false.into());
        }
        let params: InlineTable = layer
            .params
            .iter()
            .filter_map(|(key, value)| Some((key.as_str(), shader_value(value)?)))
            .collect();
        if !params.is_empty() {
            table.insert("params", Item::Value(params.into()));
        }
        tables.push(table);
    }
    tables
}

/// TOML has no null, so a null parameter (unset) is left out.
fn shader_value(value: &ShaderValue) -> Option<Value> {
    Some(match value {
        ShaderValue::Null => return None,
        ShaderValue::Number(n) => (*n).into(),
        ShaderValue::Boolean(b) => (*b).into(),
        ShaderValue::Text(s) => s.as_str().into(),
        ShaderValue::Array(values) => values
            .iter()
            .filter_map(shader_value)
            .collect::<Array>()
            .into(),
        ShaderValue::Object(values) => values
            .iter()
            .filter_map(|(key, value)| Some((key.as_str(), shader_value(value)?)))
            .collect::<InlineTable>()
            .into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(existing: &str, update: ConfigUpdate) -> String {
        let mut doc: DocumentMut = existing.parse().unwrap();
        apply(&mut doc, &update);
        let text = doc.to_string();
        toml::from_str::<FileConfig>(&text).unwrap();
        text
    }

    #[test]
    fn keeps_comments_and_other_settings() {
        let text = saved(
            "# mine\nprefix = \"C-b\" # keep\n\n[github]\nenabled = false\n",
            ConfigUpdate {
                prefix: Some("C-a".into()),
                font_size: Some(14.5),
                wallpaper_opacity: Some(0.1),
                keys: Some([("split-vertical".into(), "v".into())].into()),
                ..ConfigUpdate::default()
            },
        );
        assert!(
            text.starts_with("# mine\nprefix = \"C-a\" # keep\n"),
            "{text}"
        );
        assert!(text.contains("wallpaper-opacity = 0.1\n"), "{text}");
        assert!(text.contains("[github]\nenabled = false\n"), "{text}");
        assert!(text.contains("[terminal]\nfont-size = 14.5\n"), "{text}");
        assert!(text.contains("[keys]\nsplit-vertical = \"v\"\n"), "{text}");
    }

    #[test]
    fn empty_strings_clear_and_schemes_drop_inline_palettes() {
        let text = saved(
            "wallpaper = \"a.png\"\n[theme-dark]\nbase00 = \"#000000\"\n",
            ConfigUpdate {
                wallpaper: Some(String::new()),
                colors_dark: Some("nord".into()),
                pane_switch_border: Some(String::new()),
                ..ConfigUpdate::default()
            },
        );
        assert!(!text.contains("wallpaper ="), "{text}");
        assert!(!text.contains("theme-dark"), "{text}");
        assert!(text.contains("colors-dark = \"nord\""), "{text}");
        assert!(text.contains("pane-switch-border = \"none\""), "{text}");
    }

    #[test]
    fn writes_shader_layers() {
        let layers: ShaderLayers = serde_json::from_value(serde_json::json!([
            {"shader": "aurora", "opacity": 0.3, "params": {"speed": 0.5, "colors": ["#fff"]}},
            {"shader": "film-grain", "enabled": false, "blend-mode": "screen"},
        ]))
        .unwrap();
        let text = saved(
            "",
            ConfigUpdate {
                wallpaper_shaders: Some(layers.clone()),
                ..ConfigUpdate::default()
            },
        );
        let file: FileConfig = toml::from_str(&text).unwrap();
        assert_eq!(file.wallpaper_shaders, layers, "{text}");
        assert!(text.contains("opacity = 0.3\n"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_symlinks_and_refuses_read_only_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("btmux-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.toml");
        let link = dir.join("config.toml");
        std::fs::write(&real, "animations = true\n").unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let update = ConfigUpdate {
            animations: Some(false),
            ..ConfigUpdate::default()
        };

        render(&link, &update).unwrap().write().unwrap();
        assert!(is_symlink(&link));
        assert_eq!(
            std::fs::read_to_string(&real).unwrap(),
            "animations = false\n"
        );

        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o444)).unwrap();
        let error = render(&link, &update).err().unwrap();
        assert!(error.contains("read-only"), "{error}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
