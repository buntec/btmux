use super::replay::Output;

#[derive(Default)]
struct Signals {
    title: String,
    progress: String,
    title_revision: u64,
    progress_revision: u64,
    revision: u64,
}

impl vt100::Callbacks for Signals {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.title = String::from_utf8_lossy(title).chars().take(4096).collect();
        self.title_revision = self.revision;
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        if params.first() == Some(&b"9".as_slice()) && params.get(1) == Some(&b"4".as_slice()) {
            self.progress = params[1..]
                .iter()
                .map(|p| String::from_utf8_lossy(p))
                .collect::<Vec<_>>()
                .join(";");
            self.progress_revision = self.revision;
        }
    }
}

#[derive(Clone, Default)]
pub struct ScreenSnapshot {
    pub text: String,
    pub title: String,
    pub progress: String,
    pub revision: u64,
    pub title_revision: u64,
    pub progress_revision: u64,
}

pub struct LiveScreen {
    parser: vt100::Parser<Signals>,
    revision: u64,
}

impl LiveScreen {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(rows, cols, 0, Signals::default()),
            revision: 0,
        }
    }

    /// `revision` orders this event among all of the pane's output.
    pub fn push(&mut self, event: &Output, revision: u64) {
        self.revision = revision;
        self.parser.callbacks_mut().revision = revision;
        match event {
            Output::Data(bytes) => self.parser.process(bytes),
            Output::Size(cols, rows) => self.parser.screen_mut().set_size(*rows, *cols),
        }
    }

    pub fn snapshot(&self) -> ScreenSnapshot {
        let screen = self.parser.screen();
        let (_, cols) = screen.size();
        let mut text = String::new();
        for (row, contents) in screen.rows(0, cols).enumerate() {
            text.push_str(&contents);
            if !screen.row_wrapped(row as u16) {
                text.push('\n');
            }
        }
        let signals = self.parser.callbacks();
        ScreenSnapshot {
            text,
            title: signals.title.clone(),
            progress: signals.progress.clone(),
            revision: self.revision,
            title_revision: signals.title_revision,
            progress_revision: signals.progress_revision,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;

    #[test]
    fn reconstructs_redraws_wrapping_and_split_osc_sequences() {
        let mut screen = LiveScreen::new(12, 5);
        screen.push(
            &Output::Data(Bytes::from_static(
                b"Waiting for approval\r\x1b[2K\x1b[H\x1b[2JWorking",
            )),
            1,
        );
        assert_eq!(screen.snapshot().text.trim(), "Working");
        screen.push(&Output::Data(Bytes::from_static(b"\x1b]2;\xe2\xa0")), 2);
        screen.push(
            &Output::Data(Bytes::from_static(b"\x8b Codex\x1b\\\x1b]9;4;0\x07")),
            3,
        );
        let snapshot = screen.snapshot();
        assert_eq!(snapshot.title, "⠋ Codex");
        assert_eq!(snapshot.progress, "4;0");
        screen.push(
            &Output::Data(Bytes::from_static(b"\x1b[H\x1b[2Jabcdefghijklmnop")),
            4,
        );
        assert_eq!(screen.snapshot().text.trim(), "abcdefghijklmnop");
        screen.push(&Output::Size(40, 10), 5);
        assert!(screen.snapshot().revision > snapshot.revision);
    }

    #[test]
    fn alternate_screen_exit_restores_shell() {
        let mut screen = LiveScreen::new(80, 24);
        screen.push(
            &Output::Data(Bytes::from_static(b"shell\x1b[?1049happroval")),
            1,
        );
        assert!(screen.snapshot().text.contains("approval"));
        screen.push(&Output::Data(Bytes::from_static(b"\x1b[?1049l")), 2);
        assert_eq!(screen.snapshot().text.trim(), "shell");
    }
}
