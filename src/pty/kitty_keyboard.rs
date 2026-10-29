//! Kitty keyboard protocol flags, kept as libghostty keeps them: a stack of
//! eight per screen. The backend answers `CSI ? u` from them, so the reply
//! precedes its own DA1 reply (the usual detection fence) and arrives once.
use serde::{Deserialize, Serialize};

const DEPTH: usize = 8;
/// Private modes that switch screens.
const SCREEN_MODES: [u16; 3] = [47, 1047, 1049];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct KittyKeyboard {
    /// The normal and alternate screens' stacks, current flags first. Pushing
    /// past the depth drops the oldest entry.
    stacks: [[u8; DEPTH]; 2],
    alternate: bool,
    /// `SCREEN_MODES`' values and saved values, kept apart as libghostty does.
    modes: [bool; 3],
    saved: [bool; 3],
}

impl KittyKeyboard {
    /// Applies `CSI ? <modes> h/l/s/r` (set, reset, save, restore) to the
    /// modes that switch screens, and with them keyboard stacks.
    pub fn private_modes(&mut self, final_byte: u8, params: &[u16]) {
        for mode in params {
            let Some(i) = SCREEN_MODES.iter().position(|m| m == mode) else {
                continue;
            };
            let enabled = match final_byte {
                b'h' => true,
                b'l' => false,
                b's' => {
                    self.saved[i] = self.modes[i];
                    continue;
                }
                b'r' => self.saved[i],
                _ => return,
            };
            self.modes[i] = enabled;
            self.alternate = enabled;
        }
    }

    /// The current screen's stack.
    fn stack(&mut self) -> &mut [u8; DEPTH] {
        &mut self.stacks[usize::from(self.alternate)]
    }

    /// Applies `CSI <prefix> <params> u`; returns the reply to a query.
    /// Parameters follow libghostty, including its defaults.
    pub fn csi(&mut self, prefix: u8, params: &[u16]) -> Option<Vec<u8>> {
        let flags = |value: u16| u8::try_from(value).ok().filter(|&flags| flags < 32);
        let stack = self.stack();
        match prefix {
            b'?' => return Some(format!("\x1b[?{}u", stack[0]).into_bytes()),
            b'>' => {
                if let Some(value) = flags(if params.len() == 1 { params[0] } else { 0 }) {
                    stack.rotate_right(1);
                    stack[0] = value;
                }
            }
            b'<' => {
                let count = if params.len() == 1 { params[0] } else { 1 };
                for _ in 0..usize::from(count).min(DEPTH) {
                    stack[0] = 0;
                    stack.rotate_left(1);
                }
            }
            b'=' => {
                if let Some(value) = flags(params.first().copied().unwrap_or(0)) {
                    match params.get(1).copied().unwrap_or(1) {
                        1 => stack[0] = value,
                        2 => stack[0] |= value,
                        3 => stack[0] &= !value,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        None
    }

    /// Sets an emulator's current stack to this one, after a replay that may
    /// have lost the pushes. The other screen's stack isn't restored.
    pub fn restore(&self) -> Vec<u8> {
        if self.stacks == [[0; DEPTH]; 2] {
            return Vec::new();
        }
        let stack = &self.stacks[usize::from(self.alternate)];
        let depth = stack
            .iter()
            .rposition(|&flags| flags != 0)
            .map_or(0, |i| i + 1);
        let mut out = format!("\x1b[<{DEPTH}u").into_bytes();
        for flags in stack[..depth].iter().rev() {
            out.extend_from_slice(format!("\x1b[>{flags}u").as_bytes());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(kitty: &mut KittyKeyboard) -> String {
        String::from_utf8(kitty.csi(b'?', &[]).unwrap()).unwrap()
    }

    #[test]
    fn push_pop_and_set() {
        let mut kitty = KittyKeyboard::default();
        assert_eq!(query(&mut kitty), "\x1b[?0u");
        kitty.csi(b'>', &[1]);
        kitty.csi(b'>', &[31]);
        assert_eq!(query(&mut kitty), "\x1b[?31u");
        kitty.csi(b'<', &[]);
        assert_eq!(query(&mut kitty), "\x1b[?1u");
        kitty.csi(b'=', &[4, 2]);
        assert_eq!(query(&mut kitty), "\x1b[?5u");
        kitty.csi(b'=', &[1, 3]);
        assert_eq!(query(&mut kitty), "\x1b[?4u");
        kitty.csi(b'=', &[2]);
        assert_eq!(query(&mut kitty), "\x1b[?2u");
        // Out-of-range flags and modes are ignored, as in libghostty.
        kitty.csi(b'>', &[32]);
        kitty.csi(b'=', &[1, 4]);
        assert_eq!(query(&mut kitty), "\x1b[?2u");
        kitty.csi(b'<', &[100]);
        assert_eq!(kitty, KittyKeyboard::default());
    }

    #[test]
    fn overflow_drops_the_oldest_entry() {
        let mut kitty = KittyKeyboard::default();
        for flags in 1..=9 {
            kitty.csi(b'>', &[flags]);
        }
        kitty.csi(b'<', &[7]);
        assert_eq!(query(&mut kitty), "\x1b[?2u");
        // Popping past the bottom wraps to the dropped slot, now empty.
        kitty.csi(b'<', &[]);
        assert_eq!(query(&mut kitty), "\x1b[?0u");
    }

    #[test]
    fn screens_have_separate_stacks() {
        let mut kitty = KittyKeyboard::default();
        kitty.csi(b'>', &[1]);
        kitty.private_modes(b'h', &[1049]);
        assert_eq!(query(&mut kitty), "\x1b[?0u");
        kitty.csi(b'>', &[15]);
        kitty.private_modes(b'l', &[1049]);
        assert_eq!(query(&mut kitty), "\x1b[?1u");
        kitty.private_modes(b'h', &[47]);
        assert_eq!(query(&mut kitty), "\x1b[?15u");
    }

    #[test]
    fn restoring_saved_modes_switches_screens() {
        // Expected screens measured with the bundled libghostty.
        let alternate = |steps: &[(u8, u16)]| {
            let mut kitty = KittyKeyboard::default();
            for &(final_byte, mode) in steps {
                kitty.private_modes(final_byte, &[mode]);
            }
            kitty.alternate
        };
        assert!(!alternate(&[(b's', 1049), (b'h', 1049), (b'r', 1049)]));
        assert!(alternate(&[
            (b'h', 1049),
            (b's', 1049),
            (b'l', 1049),
            (b'r', 1049)
        ]));
        // Unsaved modes restore as reset.
        assert!(!alternate(&[(b'h', 1049), (b'r', 1049)]));
        // Each mode keeps its own value.
        assert!(alternate(&[
            (b'h', 1049),
            (b'l', 47),
            (b's', 1049),
            (b'r', 1049)
        ]));
        assert!(!alternate(&[
            (b'h', 47),
            (b's', 47),
            (b'l', 47),
            (b'r', 1049)
        ]));
        assert!(alternate(&[(b'h', 47), (b's', 47), (b'l', 47), (b'r', 47)]));
    }

    #[test]
    fn restore_rebuilds_the_current_stack() {
        let mut kitty = KittyKeyboard::default();
        assert!(kitty.restore().is_empty());
        kitty.csi(b'>', &[3]);
        kitty.csi(b'>', &[0]);
        kitty.csi(b'>', &[31]);
        let restore = kitty.restore();
        assert_eq!(restore, b"\x1b[<8u\x1b[>3u\x1b[>0u\x1b[>31u");
        // Replaying it over any stack gives the same one.
        let mut other = KittyKeyboard::default();
        other.csi(b'>', &[7]);
        for seq in restore.split(|&b| b == 0x1b).filter(|seq| !seq.is_empty()) {
            let param = std::str::from_utf8(&seq[2..seq.len() - 1]).unwrap();
            other.csi(seq[1], &[param.parse().unwrap()]);
        }
        assert_eq!(other, kitty);
    }
}
