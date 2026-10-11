use std::fs;
use std::path::PathBuf;

/// A fish theme in named ANSI colors, which btmux maps to its color scheme.
pub fn theme() -> &'static str {
    include_str!("../extras/fish/btmux.theme")
}

/// conf.d snippet that selects the theme inside btmux panes only.
fn conf_snippet() -> &'static str {
    include_str!("../extras/fish/btmux.fish")
}

/// Write `themes/btmux.theme` and `conf.d/btmux.fish` into fish's config
/// directory, replacing earlier copies.
pub fn install() -> Result<Vec<PathBuf>, String> {
    let fish_dir = crate::config::config_path()
        .and_then(|path| Some(path.parent()?.parent()?.join("fish")))
        .ok_or("cannot resolve the fish config directory")?;
    let files = [
        (fish_dir.join("themes").join("btmux.theme"), theme()),
        (fish_dir.join("conf.d").join("btmux.fish"), conf_snippet()),
    ];
    for (path, contents) in &files {
        let dir = path.parent().unwrap();
        fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        fs::write(path, contents).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    Ok(files.into_iter().map(|(path, _)| path).collect())
}
