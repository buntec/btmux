//! Bounded output journal with a VT checkpoint at its head. Eviction advances
//! the checkpoint instead of leaving a new client in the middle of terminal
//! state. Resize events live in the same ordered stream as output.
use axum::body::Bytes;
use std::collections::VecDeque;
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

pub struct Replay {
    head: vt100::Parser,
    events: VecDeque<Output>,
    bytes: usize,
    cap: usize,
    // The interceptor emits complete control sequences, but UTF-8 can cross
    // reader chunks. Restore the incomplete code point after the checkpoint.
    utf8_tail: Vec<u8>,
}

impl Replay {
    pub fn new(cols: u16, rows: u16, cap: usize) -> Self {
        Self {
            head: vt100::Parser::new(rows, cols, 0),
            events: VecDeque::new(),
            bytes: 0,
            cap: cap.min(PER_PANE_BYTES),
            utf8_tail: Vec::new(),
        }
    }

    pub fn push(&mut self, event: Output) {
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
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
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
            Output::Size(cols, rows) => self.head.screen_mut().set_size(*rows, *cols),
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

    pub fn snapshot(&self) -> Vec<Output> {
        let (rows, cols) = self.head.screen().size();
        let mut reset = b"\x1bc\x1b[3J".to_vec();
        // Restore the normal buffer too: leaving an alternate-screen program
        // after reconnect must reveal the shell that was underneath it.
        if self.head.screen().alternate_screen() {
            let mut normal = vt100::Parser::new(rows, cols, 0);
            *normal.screen_mut() = self.head.screen().clone();
            normal.process(b"\x1b[?1049l");
            reset.extend(normal.screen().state_formatted());
            reset.extend_from_slice(b"\x1b[?1049h");
        }
        reset.extend(self.head.screen().state_formatted());
        reset.extend(&self.utf8_tail);
        let mut result = vec![Output::Size(cols, rows), Output::Data(reset.into())];
        result.extend(self.events.iter().cloned());
        result
    }
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
        let mut parser = vt100::Parser::new(24, 80, 0);
        for event in replay.snapshot() {
            match event {
                Output::Data(bytes) => parser.process(&bytes),
                Output::Size(cols, rows) => parser.screen_mut().set_size(rows, cols),
            }
        }
        parser
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
        assert_eq!(parser.screen().size(), (30, 100));
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
