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

    fn slot(&self, slot: Slot) -> Rgb {
        match slot {
            Slot::Indexed(index) => self.indexed(index),
            Slot::Foreground => self.foreground,
            Slot::Background => self.background,
            Slot::Cursor => self.cursor,
        }
    }
}

/// A color programs can set and query: OSC 4 indexed or OSC 10/11/12.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    Indexed(u8),
    Foreground,
    Background,
    Cursor,
}

impl Slot {
    pub fn dynamic(code: u32) -> Option<Self> {
        match code {
            10 => Some(Self::Foreground),
            11 => Some(Self::Background),
            12 => Some(Self::Cursor),
            _ => None,
        }
    }

    /// OSC parameters naming this slot, e.g. `4;1` or `11`.
    pub fn osc_prefix(self) -> String {
        match self {
            Self::Indexed(index) => format!("4;{index}"),
            Self::Foreground => "10".into(),
            Self::Background => "11".into(),
            Self::Cursor => "12".into(),
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Indexed(index) => index as usize,
            Self::Foreground => 256,
            Self::Background => 257,
            Self::Cursor => 258,
        }
    }
}

/// Colors a program set in one pane, layered over the theme.
pub struct Overrides([Option<Rgb>; 259]);

impl Default for Overrides {
    fn default() -> Self {
        Self([None; 259])
    }
}

impl Overrides {
    pub fn get(&self, palette: &Palette, slot: Slot) -> Rgb {
        self.0[slot.index()].unwrap_or_else(|| palette.slot(slot))
    }

    pub fn set(&mut self, slot: Slot, rgb: Option<Rgb>) {
        self.0[slot.index()] = rgb;
    }

    pub fn reset_indexed(&mut self) {
        self.0[..256].fill(None);
    }

    pub fn clear(&mut self) {
        self.0.fill(None);
    }
}

/// An OSC color spec: `#` followed by 1–4 hex digits per channel, or
/// `rgb:r/g/b`. X11 color names are not supported.
pub fn parse_spec(spec: &[u8]) -> Option<Rgb> {
    let spec = std::str::from_utf8(spec).ok()?;
    let channels: Vec<&str> = if let Some(hex) = spec.strip_prefix('#') {
        if !hex.is_ascii() || hex.is_empty() || hex.len() % 3 != 0 || hex.len() > 12 {
            return None;
        }
        let n = hex.len() / 3;
        vec![&hex[..n], &hex[n..2 * n], &hex[2 * n..]]
    } else {
        spec.strip_prefix("rgb:")?.split('/').collect()
    };
    let [r, g, b] = channels.as_slice() else {
        return None;
    };
    Some([scale(r)?, scale(g)?, scale(b)?])
}

/// Scale 1–4 hex digits to 8 bits.
fn scale(hex: &str) -> Option<u8> {
    if !(1..=4).contains(&hex.len()) {
        return None;
    }
    let value = u32::from_str_radix(hex, 16).ok()?;
    let max = (1u32 << (4 * hex.len())) - 1;
    Some((value * 255 / max) as u8)
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
    fn parses_osc_specs() {
        assert_eq!(parse_spec(b"#123456"), Some([0x12, 0x34, 0x56]));
        assert_eq!(parse_spec(b"#f00"), Some([255, 0, 0]));
        assert_eq!(parse_spec(b"#fff000000"), Some([255, 0, 0]));
        assert_eq!(parse_spec(b"#ffff00008000"), Some([255, 0, 127]));
        assert_eq!(parse_spec(b"rgb:12/34/56"), Some([0x12, 0x34, 0x56]));
        assert_eq!(parse_spec(b"rgb:f/0/ffff"), Some([255, 0, 255]));
        assert_eq!(parse_spec(b"rgb:1/2"), None);
        assert_eq!(parse_spec(b"rgb:12345/0/0"), None);
        assert_eq!(parse_spec(b"#12345"), None);
        assert_eq!(parse_spec(b"red"), None);
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
