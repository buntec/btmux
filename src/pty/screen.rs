use super::replay::{set_size, vt_size, Output};

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
            parser: {
                let (rows, cols) = vt_size(cols, rows);
                vt100::Parser::new_with_callbacks(rows, cols, 0, Signals::default())
            },
            revision: 0,
        }
    }

    /// `revision` orders this event among all of the pane's output.
    pub fn push(&mut self, event: &Output, revision: u64) {
        self.revision = revision;
        self.parser.callbacks_mut().revision = revision;
        match event {
            Output::Data(bytes) => self.parser.process(bytes),
            Output::Size(cols, rows) => set_size(self.parser.screen_mut(), *cols, *rows),
        }
    }

    pub fn snapshot(&self) -> ScreenSnapshot {
        let screen = self.parser.screen();
        let mut text = String::new();
        push_rows(screen, usize::MAX, &mut text);
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

/// Appends the first `take` visible rows, joining wrapped ones. A wrapped
/// row ends in a non-blank cell (erasing that cell unwraps it), so `rows`
/// dropping trailing blanks loses nothing.
fn push_rows(screen: &vt100::Screen, take: usize, text: &mut String) {
    let cols = screen.size().1.get();
    for (row, contents) in screen.rows(0, cols).take(take).enumerate() {
        text.push_str(&contents);
        if !screen.row_wrapped(row as u16) {
            text.push('\n');
        }
    }
}

/// Most scrollback rows `capture` renders.
pub const MAX_CAPTURE_HISTORY: usize = 10_000;

/// Rendered text of a pane, like `tmux capture-pane -pJ`.
pub struct Capture {
    pub text: String,
    pub bracketed_paste: bool,
    /// DECCKM: cursor keys send `ESC O` instead of `ESC [`.
    pub application_cursor: bool,
}

/// Renders journal `events` with up to `history` rows of scrollback above the
/// screen. Wrapped rows are joined, and trailing blank lines dropped.
pub fn capture(events: &[Output], history: usize) -> Capture {
    let history = history.min(MAX_CAPTURE_HISTORY);
    let mut parser = vt100::Parser::new(
        vt100::Parser::DEFAULT_ROWS,
        vt100::Parser::DEFAULT_COLS,
        history,
    );
    for event in events {
        match event {
            Output::Data(bytes) => parser.process(bytes),
            Output::Size(cols, rows) => set_size(parser.screen_mut(), *cols, *rows),
        }
    }
    let screen = parser.screen_mut();
    let rows = usize::from(screen.size().0.get());
    screen.set_scrollback(usize::MAX);
    let mut offset = screen.scrollback();
    let mut text = String::new();
    loop {
        screen.set_scrollback(offset);
        // Above the screen, only the first `offset` visible rows are scrollback.
        let take = if offset == 0 { rows } else { offset.min(rows) };
        push_rows(screen, take, &mut text);
        if offset == 0 {
            break;
        }
        offset -= take;
    }
    text.truncate(text.trim_end().len());
    if !text.is_empty() {
        text.push('\n');
    }
    Capture {
        text,
        bracketed_paste: screen.bracketed_paste(),
        application_cursor: screen.application_cursor(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;

    #[test]
    fn capture_includes_history_and_joins_wrapped_rows() {
        let mut data = Vec::new();
        for line in 1..=30 {
            data.extend(format!("line {line}\r\n").into_bytes());
        }
        data.extend(b"abcdefghijklmnop\x1b[?2004h\x1b[?1h");
        let events = [Output::Size(12, 5), Output::Data(Bytes::from(data))];
        let screen = capture(&events, 0);
        assert_eq!(screen.text, "line 28\nline 29\nline 30\nabcdefghijklmnop\n");
        assert!(screen.bracketed_paste);
        assert!(screen.application_cursor);
        let all = capture(&events, 100).text;
        assert!(all.starts_with("line 1\nline 2\n"));
        assert_eq!(all.lines().count(), 31);
        assert!(all.ends_with("line 30\nabcdefghijklmnop\n"));
        assert_eq!(capture(&events, 3).text.lines().next(), Some("line 25"));

        // A gap at the wrap point survives the join.
        let events = [
            Output::Size(8, 3),
            Output::Data(Bytes::from_static(b"foo\x1b[9Cbar")),
        ];
        assert_eq!(capture(&events, 0).text, "foo    bar\n");
    }

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
