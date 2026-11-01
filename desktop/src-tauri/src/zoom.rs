// Page zoom, as in browsers, kept across restarts.
use std::path::Path;
use std::sync::Mutex;

use tauri::WebviewWindow;

const FILE: &str = "zoom";
// Chromium's levels.
const LEVELS: [f64; 15] = [
    0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];
const ACTUAL_SIZE: usize = 7;

// An index into LEVELS.
pub struct Zoom(Mutex<usize>);

impl Zoom {
    pub fn load(dir: &Path) -> Self {
        let index = std::fs::read_to_string(dir.join(FILE))
            .ok()
            .and_then(|text| text.trim().parse::<f64>().ok())
            .and_then(|level| LEVELS.iter().position(|l| *l == level))
            .unwrap_or(ACTUAL_SIZE);
        Self(Mutex::new(index))
    }

    pub fn apply(&self, window: &WebviewWindow) {
        let _ = window.set_zoom(LEVELS[*self.0.lock().unwrap()]);
    }

    pub fn step(&self, window: &WebviewWindow, dir: Option<&Path>, step: &str) {
        let mut index = self.0.lock().unwrap();
        *index = match step {
            "in" => (*index + 1).min(LEVELS.len() - 1),
            "out" => index.saturating_sub(1),
            _ => ACTUAL_SIZE,
        };
        let level = LEVELS[*index];
        let _ = window.set_zoom(level);
        if let Some(dir) = dir {
            let _ = std::fs::create_dir_all(dir)
                .and_then(|()| std::fs::write(dir.join(FILE), level.to_string()));
        }
    }
}
