//! Theme colors reported to PTY programs: OSC 4/10/11/12 replies and
//! mode 2031 color-scheme notifications (`CSI ? 997 ; Ps n`).

use crate::config::Theme;
use std::sync::{Arc, RwLock};

pub type Rgb = [u8; 3];

/// The resolved theme in RGB, as reported to programs in the PTY.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Palette {
    pub foreground: Rgb,
    pub background: Rgb,
    pub cursor: Rgb,
    pub ansi: [Rgb; 16],
}

impl Palette {
    /// `None` if any color is not a `#rgb`/`#rrggbb` hex value.
    pub fn from_theme(theme: &Theme) -> Option<Self> {
        let ansi = [
            &theme.black,
            &theme.red,
            &theme.green,
            &theme.yellow,
            &theme.blue,
            &theme.magenta,
            &theme.cyan,
            &theme.white,
            &theme.bright_black,
            &theme.bright_red,
            &theme.bright_green,
            &theme.bright_yellow,
            &theme.bright_blue,
            &theme.bright_magenta,
            &theme.bright_cyan,
            &theme.bright_white,
        ];
        let mut colors = [[0; 3]; 16];
        for (slot, hex) in colors.iter_mut().zip(ansi) {
            *slot = parse_hex(hex)?;
        }
        Some(Self {
            foreground: parse_hex(&theme.foreground)?,
            background: parse_hex(&theme.background)?,
            cursor: parse_hex(&theme.cursor)?,
            ansi: colors,
        })
    }

    pub fn is_dark(&self) -> bool {
        let [r, g, b] = self.background.map(u32::from);
        299 * r + 587 * g + 114 * b < 128_000
    }

    /// xterm 256-color palette: themed ANSI colors, then the default
    /// 6×6×6 cube and grayscale ramp.
    pub fn indexed(&self, index: u8) -> Rgb {
        const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
        match index {
            0..=15 => self.ansi[index as usize],
            16..=231 => {
                let i = index - 16;
                [
                    LEVELS[(i / 36) as usize],
                    LEVELS[(i / 6 % 6) as usize],
                    LEVELS[(i % 6) as usize],
                ]
            }
            _ => [8 + 10 * (index - 232); 3],
        }
    }

    /// `CSI ? 997 ; Ps n`: 1 = dark, 2 = light.
    pub fn scheme_report(&self) -> Vec<u8> {
        format!("\x1b[?997;{}n", if self.is_dark() { 1 } else { 2 }).into_bytes()
    }
}

/// X11 color spec as xterm reports it, e.g. `rgb:1414/1111/0b0b`.
pub fn x11_spec([r, g, b]: Rgb) -> String {
    format!("rgb:{r:02x}{r:02x}/{g:02x}{g:02x}/{b:02x}{b:02x}")
}

fn parse_hex(value: &str) -> Option<Rgb> {
    let hex = value.trim().trim_start_matches('#');
    if !hex.is_ascii() {
        return None;
    }
    let channel = |s: &str| u8::from_str_radix(s, 16).ok();
    match hex.len() {
        6 => Some([
            channel(&hex[0..2])?,
            channel(&hex[2..4])?,
            channel(&hex[4..6])?,
        ]),
        3 => {
            let mut rgb = [0; 3];
            for (slot, i) in rgb.iter_mut().zip(0..3) {
                *slot = channel(&hex[i..i + 1])? * 17;
            }
            Some(rgb)
        }
        _ => None,
    }
}

/// The current palette, shared by the session manager and every pane's
/// reader thread.
#[derive(Clone, Default)]
pub struct SharedPalette(Arc<RwLock<Option<Palette>>>);

impl SharedPalette {
    pub fn get(&self) -> Option<Palette> {
        self.0.read().unwrap().clone()
    }

    /// Returns whether the palette changed.
    pub fn set(&self, palette: Option<Palette>) -> bool {
        let mut current = self.0.write().unwrap();
        if *current == palette {
            return false;
        }
        *current = palette;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hex_forms() {
        assert_eq!(parse_hex("#14110b"), Some([0x14, 0x11, 0x0b]));
        assert_eq!(parse_hex("FfF"), Some([255, 255, 255]));
        assert_eq!(parse_hex("red"), None);
        assert_eq!(parse_hex("#12345"), None);
    }

    #[test]
    fn default_theme_is_dark_and_reports() {
        let palette = Palette::from_theme(&crate::config::default_theme()).unwrap();
        assert!(palette.is_dark());
        assert_eq!(palette.scheme_report(), b"\x1b[?997;1n");
        assert_eq!(x11_spec(palette.background), "rgb:1414/1111/0b0b");
    }

    #[test]
    fn indexed_colors_follow_xterm() {
        let palette = Palette::from_theme(&crate::config::default_theme()).unwrap();
        assert_eq!(palette.indexed(1), palette.ansi[1]);
        assert_eq!(palette.indexed(16), [0, 0, 0]);
        assert_eq!(palette.indexed(231), [255, 255, 255]);
        assert_eq!(palette.indexed(196), [255, 0, 0]);
        assert_eq!(palette.indexed(232), [8, 8, 8]);
        assert_eq!(palette.indexed(255), [238, 238, 238]);
    }
}
