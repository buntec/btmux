//! Bounded output journal with a VT checkpoint at its head. Eviction advances
//! the checkpoint instead of leaving a new client in the middle of terminal
//! state. Resize events live in the same ordered stream as output.
use axum::body::Bytes;
use std::collections::VecDeque;
use std::num::NonZeroU16;
use std::sync::atomic::{AtomicUsize, Ordering};

const PER_PANE_BYTES: usize = 8 * 1024 * 1024;
const GLOBAL_BYTES: usize = 128 * 1024 * 1024;
static JOURNAL_BYTES: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Debug)]
pub enum Output {
    Data(Bytes),
    Size(u16, u16),
}

impl Output {
    fn cost(&self) -> usize {
        match self {
            Self::Data(bytes) => bytes.len() + 64,
            Self::Size(..) => 64,
        }
    }
}

/// vt100's `(rows, cols)`; it rejects empty sizes.
pub(super) fn vt_size(cols: u16, rows: u16) -> (NonZeroU16, NonZeroU16) {
    let size = |n| NonZeroU16::new(n).unwrap_or(NonZeroU16::MIN);
    (size(rows), size(cols))
}

pub(super) fn set_size(screen: &mut vt100::Screen, cols: u16, rows: u16) {
    let (rows, cols) = vt_size(cols, rows);
    screen.set_size(rows, cols);
}

pub struct Replay {
    head: vt100::Parser,
    /// Present only while agent detection reads this pane.
    live: Option<super::screen::LiveScreen>,
    revision: u64,
    events: VecDeque<Output>,
    bytes: usize,
    cap: usize,
    // The interceptor emits complete control sequences, but UTF-8 can cross
    // reader chunks. Restore the incomplete code point after the checkpoint.
    utf8_tail: Vec<u8>,
    /// Keyboard flags after the newest event; eviction can drop their pushes.
    kitty: super::kitty_keyboard::KittyKeyboard,
}

impl Replay {
    pub fn new(cols: u16, rows: u16, cap: usize) -> Self {
        Self {
            head: {
                let (rows, cols) = vt_size(cols, rows);
                vt100::Parser::new(rows, cols, 0)
            },
            live: None,
            revision: 0,
            events: VecDeque::new(),
            bytes: 0,
            cap: cap.min(PER_PANE_BYTES),
            utf8_tail: Vec::new(),
            kitty: Default::default(),
        }
    }

    /// Rebuilds a journal from `snapshot()` events.
    #[cfg(unix)]
    pub fn restore(cols: u16, rows: u16, cap: usize, events: Vec<Output>) -> Self {
        let mut replay = Self::new(cols, rows, cap);
        let mut events = events.into_iter();
        // The checkpoint's size and contents become the head again.
        for event in events.by_ref().take(2) {
            replay.advance(&event);
        }
        for event in events {
            replay.push(event);
        }
        replay
    }

    pub fn push(&mut self, event: Output) {
        self.revision = self.revision.wrapping_add(1);
        if let Some(live) = &mut self.live {
            live.push(&event, self.revision);
        }
        let cost = event.cost();
        while !self.events.is_empty()
            && (self.bytes + cost > self.cap
                || JOURNAL_BYTES.load(Ordering::Relaxed) + cost > GLOBAL_BYTES)
        {
            let old = self.events.pop_front().unwrap();
            self.bytes -= old.cost();
            JOURNAL_BYTES.fetch_sub(old.cost(), Ordering::Relaxed);
            self.advance(&old);
        }
        let reserved = cost <= self.cap
            && JOURNAL_BYTES
                .try_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                    (used + cost <= GLOBAL_BYTES).then_some(used + cost)
                })
                .is_ok();
        if reserved {
            self.bytes += cost;
            self.events.push_back(event);
        } else {
            // Other panes can exhaust the shared history budget. Keep a valid
            // screen even when this pane cannot retain additional history.
            while let Some(old) = self.events.pop_front() {
                self.bytes -= old.cost();
                JOURNAL_BYTES.fetch_sub(old.cost(), Ordering::Relaxed);
                self.advance(&old);
            }
            self.advance(&event);
        }
    }

    fn advance(&mut self, event: &Output) {
        match event {
            Output::Size(cols, rows) => set_size(self.head.screen_mut(), *cols, *rows),
            Output::Data(bytes) => {
                self.head.process(bytes);
                for &byte in bytes {
                    if byte & 0xc0 != 0x80 {
                        self.utf8_tail.clear();
                    }
                    if byte >= 0x80 {
                        self.utf8_tail.push(byte);
                    }
                    if std::str::from_utf8(&self.utf8_tail).is_ok() || self.utf8_tail.len() >= 4 {
                        self.utf8_tail.clear();
                    }
                }
            }
        }
    }

    pub fn set_kitty(&mut self, kitty: super::kitty_keyboard::KittyKeyboard) {
        self.kitty = kitty;
    }

    pub fn screen_revision(&self) -> u64 {
        self.revision
    }

    pub fn screen_snapshot(&self) -> Option<super::screen::ScreenSnapshot> {
        self.live.as_ref().map(|live| live.snapshot())
    }

    /// Starts or stops the live screen. A started screen is rebuilt from the
    /// checkpoint and journal; replayed titles carry the current revision.
    pub fn track_screen(&mut self, enabled: bool) {
        if !enabled {
            self.live = None;
            return;
        }
        if self.live.is_some() {
            return;
        }
        let (rows, cols) = self.head.screen().size();
        let mut live = super::screen::LiveScreen::new(cols.get(), rows.get());
        for event in self.snapshot() {
            live.push(&event, self.revision);
        }
        self.live = Some(live);
    }

    pub fn snapshot(&self) -> Vec<Output> {
        let (rows, cols) = self.head.screen().size();
        let mut reset = b"\x1bc\x1b[3J".to_vec();
        // Restore the normal buffer too: leaving an alternate-screen program
        // after reconnect must reveal the shell that was underneath it.
        if self.head.screen().alternate_screen() {
            let mut normal = vt100::Parser::new(rows, cols, 0);
            *normal.screen_mut() = self.head.screen().clone();
            normal.process(b"\x1b[?1049l");
            reset.extend_from_slice(normal.screen().state_formatted().as_bytes());
            reset.extend_from_slice(b"\x1b[?1049h");
        }
        reset.extend_from_slice(self.head.screen().state_formatted().as_bytes());
        reset.extend(&self.utf8_tail);
        let mut result = vec![
            Output::Size(cols.get(), rows.get()),
            Output::Data(reset.into()),
        ];
        result.extend(self.events.iter().cloned());
        result
    }

    /// `snapshot()`, then the current keyboard flags, for an emulator.
    pub fn viewer_snapshot(&self) -> Vec<Output> {
        let mut result = self.snapshot();
        let restore = self.kitty.restore();
        if restore.is_empty() {
            return result;
        }
        // Keep a code point the next chunk completes after the flags. Its
        // bytes can span events, and sizes or empty data can follow them.
        let mut end: Vec<u8> = result
            .iter()
            .rev()
            .filter_map(|event| match event {
                Output::Data(bytes) => Some(bytes),
                Output::Size(..) => None,
            })
            .flat_map(|bytes| bytes.iter().rev())
            .take(3)
            .copied()
            .collect();
        end.reverse();
        let tail = end.split_off(end.len() - incomplete_utf8(&end));
        let mut cut = tail.len();
        for event in result.iter_mut().rev() {
            if let Output::Data(bytes) = event {
                let n = cut.min(bytes.len());
                bytes.truncate(bytes.len() - n);
                cut -= n;
            }
            if cut == 0 {
                break;
            }
        }
        result.push(Output::Data(restore.into()));
        if !tail.is_empty() {
            result.push(Output::Data(tail.into()));
        }
        result
    }
}

/// Length of the incomplete UTF-8 sequence that ends `bytes`.
fn incomplete_utf8(bytes: &[u8]) -> usize {
    for (back, &byte) in bytes.iter().rev().take(3).enumerate() {
        if byte & 0xc0 != 0x80 {
            let len = match byte {
                0xc0..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf7 => 4,
                _ => return 0,
            };
            return if back + 1 < len { back + 1 } else { 0 };
        }
    }
    0
}

impl Drop for Replay {
    fn drop(&mut self) {
        JOURNAL_BYTES.fetch_sub(self.bytes, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn restore(replay: &Replay) -> vt100::Parser {
        let mut parser = vt100::Parser::default();
        for event in replay.snapshot() {
            match event {
                Output::Data(bytes) => parser.process(&bytes),
                Output::Size(cols, rows) => set_size(parser.screen_mut(), cols, rows),
            }
        }
        parser
    }
    #[test]
    fn late_screen_tracking_rebuilds_from_the_journal() {
        let mut replay = Replay::new(20, 5, 60);
        replay.push(Output::Data(Bytes::from_static(b"\x1b]2;old\x07first ")));
        replay.push(Output::Data(Bytes::from_static(b"second")));
        assert!(replay.screen_snapshot().is_none());
        replay.track_screen(true);
        let screen = replay.screen_snapshot().unwrap();
        assert_eq!(screen.text.trim(), "first second");
        // Replayed signals are no newer than the moment tracking began.
        assert_eq!(screen.revision, 2);
        assert!(screen.title_revision <= 2);
        replay.push(Output::Data(Bytes::from_static(b"\x1b]2;new\x07")));
        let screen = replay.screen_snapshot().unwrap();
        assert_eq!((screen.title.as_str(), screen.title_revision), ("new", 3));
        replay.track_screen(false);
        assert!(replay.screen_snapshot().is_none());
        assert_eq!(replay.screen_revision(), 3);
    }
    #[test]
    fn eviction_preserves_screen_and_input_modes() {
        let mut replay = Replay::new(80, 24, 100);
        replay.push(Output::Data(Bytes::from_static(
            b"\x1b[?2004h\x1b[?1h\x1b[31mhello",
        )));
        replay.push(Output::Data(Bytes::from_static(b" world")));
        let parser = restore(&replay);
        assert_eq!(parser.screen().contents(), "hello world");
        assert!(parser.screen().bracketed_paste());
        assert!(parser.screen().application_cursor());
    }
    #[test]
    fn eviction_preserves_partial_utf8_and_resize_history() {
        let mut replay = Replay::new(80, 24, 70);
        replay.push(Output::Data(Bytes::from_static(b"a\xf0\x9f")));
        replay.push(Output::Data(Bytes::from_static(b"\x99\x82b")));
        assert_eq!(restore(&replay).screen().contents(), "a🙂b");
        replay.push(Output::Size(100, 30));
        let parser = restore(&replay);
        assert_eq!(parser.screen().contents(), "a🙂b");
        assert_eq!(parser.screen().size(), vt_size(100, 30));
    }
    #[test]
    #[cfg(unix)]
    fn restoring_a_snapshot_keeps_one_checkpoint() {
        let mut replay = Replay::new(80, 24, 3);
        replay.push(Output::Data(Bytes::from_static(b"evicted ")));
        replay.push(Output::Data(Bytes::from_static(b"kept")));
        for _ in 0..3 {
            replay = Replay::restore(80, 24, 1000, replay.snapshot());
        }
        let resets = |replay: &Replay| {
            replay
                .snapshot()
                .iter()
                .filter(|event| matches!(event, Output::Data(bytes) if bytes.starts_with(b"\x1bc")))
                .count()
        };
        assert_eq!(resets(&replay), 1);
        assert_eq!(restore(&replay).screen().contents(), "evicted kept");
    }
    #[test]
    fn viewers_get_keyboard_flags_whose_pushes_were_evicted() {
        // Room for the second event only.
        let mut replay = Replay::new(80, 24, 70);
        replay.push(Output::Data(Bytes::from_static(b"\x1b[>5u")));
        let mut kitty = crate::pty::kitty_keyboard::KittyKeyboard::default();
        kitty.csi(b'>', &[5]);
        replay.set_kitty(kitty);
        replay.push(Output::Data(Bytes::from_static(b"a\xf0\x9f")));
        let events = replay.viewer_snapshot();
        assert_eq!(events.len(), replay.snapshot().len() + 2);
        let data = |i: usize| match &events[events.len() - i] {
            Output::Data(bytes) => bytes.clone(),
            Output::Size(..) => panic!("expected data"),
        };
        assert_eq!(&data(3)[..], b"a");
        assert_eq!(&data(2)[..], b"\x1b[<8u\x1b[>5u");
        assert_eq!(&data(1)[..], b"\xf0\x9f");
        assert_eq!(incomplete_utf8("é🙂".as_bytes()), 0);
        assert_eq!(incomplete_utf8(b"\xc3"), 1);
        assert_eq!(incomplete_utf8(b"x\xe2\x82"), 2);
    }
    #[test]
    fn keyboard_flags_follow_a_code_point_split_across_events() {
        let joined = |events: Vec<Output>| -> Vec<u8> {
            events
                .into_iter()
                .filter_map(|event| match event {
                    Output::Data(bytes) => Some(bytes.to_vec()),
                    Output::Size(..) => None,
                })
                .flatten()
                .collect()
        };
        let mut kitty = crate::pty::kitty_keyboard::KittyKeyboard::default();
        kitty.csi(b'>', &[5]);
        let data = |bytes: &'static [u8]| Output::Data(Bytes::from_static(bytes));
        for (cap, events) in [
            (1024, vec![data(b"\x1b[>5u\xf0"), data(b"\x9f")]),
            (1024, vec![data(b"\xf0\x9f"), data(b"")]),
            (
                1024,
                vec![
                    data(b"\xf0"),
                    Output::Size(40, 10),
                    data(b"\x9f"),
                    Output::Size(80, 24),
                ],
            ),
            // Across the checkpoint: room for the second event only.
            (70, vec![data(b"\xf0"), data(b"\x9f")]),
        ] {
            let mut replay = Replay::new(80, 24, cap);
            for event in events {
                replay.push(event);
            }
            replay.set_kitty(kitty);
            let before = joined(replay.snapshot());
            let after = joined(replay.viewer_snapshot());
            assert_eq!(after[..after.len() - 12], before[..before.len() - 2]);
            assert!(after.ends_with(b"\x1b[<8u\x1b[>5u\xf0\x9f"));
        }
    }
    #[test]
    fn alternate_screen_survives_eviction() {
        let mut replay = Replay::new(80, 24, 0);
        replay.push(Output::Data(Bytes::from_static(b"shell\x1b[?1049hTUI")));
        let mut parser = restore(&replay);
        assert!(parser.screen().alternate_screen());
        assert!(parser.screen().contents().contains("TUI"));
        parser.process(b"\x1b[?1049l");
        assert_eq!(parser.screen().contents(), "shell");
    }
}
