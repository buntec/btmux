// VT Query Interceptor — a lightweight escape sequence state machine that
// recognizes terminal query sequences (those expecting a response) and
// dispatches them appropriately.
//
// Modeled after tmux's input.c state machine topology, but only parses
// sequence *structure* — it doesn't track screen state. Handles sequences
// split across read() chunk boundaries.

/// What to do with a recognized sequence.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Emit bytes to both scrollback and broadcast (normal output).
    Pass,
    /// Strip from both scrollback and broadcast, write a canned response
    /// back to the PTY master.
    Answer(&'static [u8]),
    /// Strip from scrollback, keep in broadcast (emulator answers — e.g. DSR 6).
    Forward,
    /// Strip from both outputs, no response (swallow unknown queries).
    Swallow,
}

/// Parser state — mirrors tmux's state machine topology but simplified.
#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    Ground,
    Escape,
    EscapeIntermediate,
    CsiEntry,
    CsiParam,
    CsiIntermediate,
    CsiIgnore,
    OscString,
    DcsEntry,
    DcsParam,
    DcsIntermediate,
    DcsPassthrough,
    DcsEscape,
    DcsIgnore,
}

/// Output produced by the parser for each chunk of input.
pub struct FilterResult {
    /// Bytes safe for scrollback replay (all queries stripped).
    pub scrollback: Vec<u8>,
    /// Bytes to broadcast to live emulators (stateful queries like DSR 6 kept).
    pub broadcast: Vec<u8>,
    /// Responses to write back to the PTY master.
    pub responses: Vec<&'static [u8]>,
    /// DSR 6 / DECXCPR queries that were forwarded — caller should record the
    /// foreground pgrp for each so stale CPR responses can be filtered.
    pub forwarded_cpr_queries: u32,
}

pub struct VtQueryInterceptor {
    state: State,
    /// Accumulates the parameter bytes of the current CSI/DCS sequence.
    param_buf: Vec<u8>,
    /// Accumulates intermediate bytes (0x20–0x2F) between params and final byte.
    interm_buf: Vec<u8>,
    /// Accumulates DCS/OSC payload.
    payload_buf: Vec<u8>,
    /// Raw bytes of the current escape sequence being parsed, so we can emit
    /// them verbatim if the sequence turns out to be passthrough.
    raw_seq: Vec<u8>,
}

impl VtQueryInterceptor {
    pub fn new() -> Self {
        Self {
            state: State::Ground,
            param_buf: Vec::with_capacity(64),
            interm_buf: Vec::with_capacity(4),
            payload_buf: Vec::with_capacity(256),
            raw_seq: Vec::with_capacity(64),
        }
    }

    /// Feed a chunk of PTY output through the interceptor.
    pub fn feed(&mut self, data: &[u8]) -> FilterResult {
        let mut result = FilterResult {
            scrollback: Vec::with_capacity(data.len()),
            broadcast: Vec::with_capacity(data.len()),
            responses: Vec::new(),
            forwarded_cpr_queries: 0,
        };

        for &byte in data {
            self.process_byte(byte, &mut result);
        }

        result
    }

    fn process_byte(&mut self, byte: u8, result: &mut FilterResult) {
        // CAN (0x18) and SUB (0x1A) abort any sequence and return to ground.
        if byte == 0x18 || byte == 0x1A {
            if self.state != State::Ground {
                self.emit_raw(result);
            }
            result.scrollback.push(byte);
            result.broadcast.push(byte);
            self.enter_ground();
            return;
        }

        // ESC in any non-ground state aborts the current sequence and starts a new one.
        if byte == 0x1b && self.state != State::Ground && self.state != State::DcsPassthrough {
            self.emit_raw(result);
            self.enter_ground();
            // Fall through to handle ESC in ground state below.
        }

        match self.state {
            State::Ground => self.ground(byte, result),
            State::Escape => self.escape(byte, result),
            State::EscapeIntermediate => self.escape_intermediate(byte, result),
            State::CsiEntry => self.csi_entry(byte, result),
            State::CsiParam => self.csi_param(byte, result),
            State::CsiIntermediate => self.csi_intermediate(byte, result),
            State::CsiIgnore => self.csi_ignore(byte, result),
            State::OscString => self.osc_string(byte, result),
            State::DcsEntry => self.dcs_entry(byte, result),
            State::DcsParam => self.dcs_param(byte, result),
            State::DcsIntermediate => self.dcs_intermediate(byte, result),
            State::DcsPassthrough => self.dcs_passthrough(byte, result),
            State::DcsEscape => self.dcs_escape(byte, result),
            State::DcsIgnore => self.dcs_ignore(byte, result),
        }
    }

    // ─── Ground ────────────────────────────────────────────────────────────────

    fn ground(&mut self, byte: u8, result: &mut FilterResult) {
        if byte == 0x1b {
            self.state = State::Escape;
            self.raw_seq.clear();
            self.raw_seq.push(byte);
        } else if byte == 0x9b {
            // C1 CSI (8-bit)
            self.state = State::CsiEntry;
            self.raw_seq.clear();
            self.raw_seq.push(byte);
            self.param_buf.clear();
            self.interm_buf.clear();
        } else if byte == 0x9d {
            // C1 OSC (8-bit)
            self.state = State::OscString;
            self.raw_seq.clear();
            self.raw_seq.push(byte);
            self.payload_buf.clear();
        } else {
            result.scrollback.push(byte);
            result.broadcast.push(byte);
        }
    }

    // ─── ESC ───────────────────────────────────────────────────────────────────

    fn escape(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            b'[' => {
                self.state = State::CsiEntry;
                self.param_buf.clear();
                self.interm_buf.clear();
            }
            b']' => {
                self.state = State::OscString;
                self.payload_buf.clear();
            }
            b'P' => {
                self.state = State::DcsEntry;
                self.param_buf.clear();
                self.interm_buf.clear();
                self.payload_buf.clear();
            }
            // Intermediates (space through /)
            0x20..=0x2f => {
                self.state = State::EscapeIntermediate;
                self.interm_buf.clear();
                self.interm_buf.push(byte);
            }
            // ESC \ (ST) in ground context — just pass through
            // Final bytes for ESC sequences (not queries, pass through)
            0x30..=0x7e => {
                self.emit_raw(result);
                self.enter_ground();
            }
            _ => {
                // Unexpected byte after ESC — emit what we have and reset.
                self.emit_raw(result);
                self.enter_ground();
            }
        }
    }

    fn escape_intermediate(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            0x20..=0x2f => {
                self.interm_buf.push(byte);
            }
            0x30..=0x7e => {
                // ESC intermediate final — not a query, pass through.
                self.emit_raw(result);
                self.enter_ground();
            }
            _ => {
                self.emit_raw(result);
                self.enter_ground();
            }
        }
    }

    // ─── CSI ───────────────────────────────────────────────────────────────────

    fn csi_entry(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            // Parameter bytes: digits, semicolons, colons
            b'0'..=b'9' | b';' | b':' => {
                self.param_buf.push(byte);
                self.state = State::CsiParam;
            }
            // Private parameter prefix: < = > ?
            0x3c..=0x3f => {
                self.param_buf.push(byte);
                self.state = State::CsiParam;
            }
            // Intermediate bytes
            0x20..=0x2f => {
                self.interm_buf.push(byte);
                self.state = State::CsiIntermediate;
            }
            // Final byte immediately (no params)
            0x40..=0x7e => {
                self.dispatch_csi(byte, result);
                self.enter_ground();
            }
            _ => {
                self.emit_raw(result);
                self.enter_ground();
            }
        }
    }

    fn csi_param(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            // More parameter bytes
            b'0'..=b'9' | b';' | b':' => {
                self.param_buf.push(byte);
            }
            // Second private marker in wrong position → ignore mode
            0x3c..=0x3f => {
                self.state = State::CsiIgnore;
            }
            // Intermediate bytes
            0x20..=0x2f => {
                self.interm_buf.push(byte);
                self.state = State::CsiIntermediate;
            }
            // Final byte — dispatch
            0x40..=0x7e => {
                self.dispatch_csi(byte, result);
                self.enter_ground();
            }
            _ => {
                self.emit_raw(result);
                self.enter_ground();
            }
        }
    }

    fn csi_intermediate(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            0x20..=0x2f => {
                self.interm_buf.push(byte);
            }
            // Params in wrong position → ignore
            0x30..=0x3f => {
                self.state = State::CsiIgnore;
            }
            // Final byte
            0x40..=0x7e => {
                self.dispatch_csi(byte, result);
                self.enter_ground();
            }
            _ => {
                self.emit_raw(result);
                self.enter_ground();
            }
        }
    }

    fn csi_ignore(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            // Keep ignoring until final byte
            0x20..=0x3f => {}
            // Final byte — discard the whole malformed sequence
            0x40..=0x7e => {
                self.emit_raw(result);
                self.enter_ground();
            }
            _ => {
                self.emit_raw(result);
                self.enter_ground();
            }
        }
    }

    // ─── CSI dispatch — the heart of query detection ───────────────────────────

    fn dispatch_csi(&mut self, final_byte: u8, result: &mut FilterResult) {
        let action = self.classify_csi(final_byte);
        match action {
            Action::Pass => {
                self.emit_raw(result);
            }
            Action::Answer(response) => {
                result.responses.push(response);
                // Stripped from both scrollback and broadcast.
            }
            Action::Forward => {
                result.broadcast.extend_from_slice(&self.raw_seq);
                result.forwarded_cpr_queries += 1;
                // Stripped from scrollback.
            }
            Action::Swallow => {
                // Stripped from both.
            }
        }
    }

    /// Classify a CSI sequence by its parameter prefix, parameters, intermediate
    /// bytes, and final byte.
    fn classify_csi(&self, final_byte: u8) -> Action {
        let params = &self.param_buf;
        let interm = &self.interm_buf;

        // Extract the private prefix if any (first byte of params if it's < = > ?).
        let (prefix, param_body) = if params.first().is_some_and(|b| (0x3c..=0x3f).contains(b)) {
            (Some(params[0]), &params[1..])
        } else {
            (None, params.as_slice())
        };

        match (prefix, final_byte, interm.as_slice()) {
            // ── DA1: CSI c  or  CSI 0 c ──
            (None, b'c', []) if param_body.is_empty() || param_body == b"0" => {
                Action::Answer(b"\x1b[?62;22c")
            }

            // ── DA2: CSI > c  or  CSI > 0 c ──
            (Some(b'>'), b'c', []) if param_body.is_empty() || param_body == b"0" => {
                Action::Answer(b"\x1b[>1;0;0c")
            }

            // ── DA3: CSI = c  or  CSI = 0 c ──
            (Some(b'='), b'c', []) if param_body.is_empty() || param_body == b"0" => {
                // DCS ! | <hex-encoded unit ID> ST — we use all zeros like tmux.
                Action::Answer(b"\x1bP!|00000000\x1b\\")
            }

            // ── DSR 5 (device status): CSI 5 n → "OK" ──
            (None, b'n', []) if param_body == b"5" => Action::Answer(b"\x1b[0n"),

            // ── DSR 6 (cursor position): CSI 6 n → forward to emulator ──
            (None, b'n', []) if param_body == b"6" => Action::Forward,

            // ── DECXCPR: CSI ? 6 n → forward to emulator ──
            (Some(b'?'), b'n', []) if param_body == b"6" => Action::Forward,

            // ── XTVERSION: CSI > 0 q ──
            (Some(b'>'), b'q', []) if param_body.is_empty() || param_body == b"0" => {
                Action::Answer(b"\x1bP>|btmux(0)\x1b\\")
            }

            // ── DECRPM: CSI ? <Ps> $ p (request mode) ──
            // Answer with "mode not recognized" (Ps;0$y) for everything.
            // This is safe — it tells the app "I don't track that mode" rather than
            // hanging forever or letting N emulators answer.
            (Some(b'?'), b'p', [b'$']) => {
                // For now, swallow. A proper implementation would answer with
                // the mode status, but that requires tracking mode state.
                Action::Swallow
            }

            // ── DECRQSS: this arrives as DCS, not CSI — handled in DCS dispatch ──

            // ── DSR with other params (e.g. DSR 26 for keyboard locale) — swallow ──
            (None, b'n', []) => Action::Swallow,
            (Some(b'?'), b'n', []) => Action::Swallow,

            // ── Everything else is passthrough ──
            _ => Action::Pass,
        }
    }

    // ─── OSC ───────────────────────────────────────────────────────────────────

    fn osc_string(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            // BEL terminates OSC
            0x07 => {
                self.dispatch_osc(result);
                self.enter_ground();
            }
            // C1 ST (0x9C) terminates OSC
            0x9c => {
                self.dispatch_osc(result);
                self.enter_ground();
            }
            // ESC (potential start of ST = ESC \)
            0x1b => {
                // Peek: we need the next byte to know if it's ST.
                // Transition to a sub-state — we'll handle it via the
                // universal ESC handling at the top of process_byte.
                // But for OSC, ESC is ONLY valid as part of ST (ESC \).
                // We handle this by noting we got ESC and checking next byte.
                self.state = State::DcsEscape; // Reuse DCS escape state for ST detection
            }
            _ => {
                self.payload_buf.push(byte);
            }
        }
    }

    fn dispatch_osc(&mut self, result: &mut FilterResult) {
        let action = self.classify_osc();
        match action {
            Action::Pass => self.emit_raw(result),
            Action::Answer(response) => {
                result.responses.push(response);
            }
            Action::Swallow => {}
            Action::Forward => {
                result.broadcast.extend_from_slice(&self.raw_seq);
            }
        }
    }

    fn classify_osc(&self) -> Action {
        // OSC payload format: "<code>;<data>"
        // Query form: the data part is "?" for color queries.
        let payload = &self.payload_buf;

        // Find the semicolon separator
        let sep = payload.iter().position(|&b| b == b';');
        let (code_bytes, data) = match sep {
            Some(pos) => (&payload[..pos], &payload[pos + 1..]),
            None => (payload.as_slice(), &[] as &[u8]),
        };

        // Parse the OSC code
        let code_str = std::str::from_utf8(code_bytes).unwrap_or("");
        let code: u32 = code_str.parse().unwrap_or(u32::MAX);

        match code {
            // OSC 10 ; ? — query foreground color
            // OSC 11 ; ? — query background color
            // OSC 12 ; ? — query cursor color
            10..=12 if data == b"?" => Action::Swallow,

            // OSC 4 ; <index> ; ? — query palette color
            4 => {
                if data.ends_with(b"?") {
                    Action::Swallow
                } else {
                    Action::Pass
                }
            }

            // OSC 52 ; <clipboard> ; ? — query clipboard
            52 => {
                // Find second semicolon for the base64/? part
                if let Some(pos) = data.iter().position(|&b| b == b';') {
                    if &data[pos + 1..] == b"?" {
                        Action::Swallow
                    } else {
                        Action::Pass
                    }
                } else {
                    Action::Pass
                }
            }

            // Everything else passes through (OSC 0/2 title, OSC 7 cwd, etc.)
            _ => Action::Pass,
        }
    }

    // ─── DCS ───────────────────────────────────────────────────────────────────

    fn dcs_entry(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            b'0'..=b'9' | b';' => {
                self.param_buf.push(byte);
                self.state = State::DcsParam;
            }
            0x3c..=0x3f => {
                self.param_buf.push(byte);
                self.state = State::DcsParam;
            }
            0x20..=0x2f => {
                self.interm_buf.push(byte);
                self.state = State::DcsIntermediate;
            }
            // Final byte → enter passthrough immediately
            0x40..=0x7e => {
                self.state = State::DcsPassthrough;
            }
            b':' => {
                self.state = State::DcsIgnore;
            }
            _ => {
                self.emit_raw(result);
                self.enter_ground();
            }
        }
    }

    fn dcs_param(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            b'0'..=b'9' | b';' => {
                self.param_buf.push(byte);
            }
            0x20..=0x2f => {
                self.interm_buf.push(byte);
                self.state = State::DcsIntermediate;
            }
            0x40..=0x7e => {
                self.state = State::DcsPassthrough;
            }
            0x3c..=0x3f | b':' => {
                self.state = State::DcsIgnore;
            }
            _ => {
                self.emit_raw(result);
                self.enter_ground();
            }
        }
    }

    fn dcs_intermediate(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            0x20..=0x2f => {
                self.interm_buf.push(byte);
            }
            0x40..=0x7e => {
                self.state = State::DcsPassthrough;
            }
            0x30..=0x3f => {
                self.state = State::DcsIgnore;
            }
            _ => {
                self.emit_raw(result);
                self.enter_ground();
            }
        }
    }

    fn dcs_passthrough(&mut self, byte: u8, _result: &mut FilterResult) {
        self.raw_seq.push(byte);
        match byte {
            0x1b => {
                self.state = State::DcsEscape;
            }
            _ => {
                self.payload_buf.push(byte);
            }
        }
    }

    fn dcs_escape(&mut self, byte: u8, result: &mut FilterResult) {
        self.raw_seq.push(byte);
        if byte == b'\\' {
            // ST (ESC \) — terminate the DCS/OSC sequence
            self.dispatch_dcs(result);
            self.enter_ground();
        } else {
            // Not ST — the ESC was part of the payload. Back to passthrough.
            self.payload_buf.push(0x1b);
            self.payload_buf.push(byte);
            self.state = State::DcsPassthrough;
        }
    }

    fn dcs_ignore(&mut self, byte: u8, _result: &mut FilterResult) {
        self.raw_seq.push(byte);
        if byte == 0x1b {
            self.state = State::DcsEscape;
        }
    }

    fn dispatch_dcs(&mut self, result: &mut FilterResult) {
        let action = self.classify_dcs();
        match action {
            Action::Pass => self.emit_raw(result),
            Action::Answer(response) => {
                result.responses.push(response);
            }
            Action::Swallow => {}
            Action::Forward => {
                result.broadcast.extend_from_slice(&self.raw_seq);
            }
        }
    }

    fn classify_dcs(&self) -> Action {
        // DECRQSS: DCS $ q <payload> ST
        // interm_buf would have '$', final byte (at DCS entry) would be 'q'
        // Actually DECRQSS is: DCS $ q Pt ST where Pt is the request string.
        // The '$' is an intermediate and 'q' is the final byte that enters passthrough.
        if self.interm_buf == b"$" {
            // The final byte that triggered DcsPassthrough is not stored separately
            // in this design, but we can check the raw_seq.
            // DCS $ q ... ST — this is DECRQSS. Swallow it.
            return Action::Swallow;
        }

        // XTGETTCAP: DCS + q <hex-encoded cap name> ST
        if self.param_buf.is_empty() && self.interm_buf == b"+" {
            return Action::Swallow;
        }

        Action::Pass
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    fn enter_ground(&mut self) {
        self.state = State::Ground;
        self.param_buf.clear();
        self.interm_buf.clear();
        self.payload_buf.clear();
        self.raw_seq.clear();
    }

    /// Emit the accumulated raw_seq bytes as passthrough (to both outputs).
    fn emit_raw(&self, result: &mut FilterResult) {
        result.scrollback.extend_from_slice(&self.raw_seq);
        result.broadcast.extend_from_slice(&self.raw_seq);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_normal_text() {
        let mut interceptor = VtQueryInterceptor::new();
        let result = interceptor.feed(b"hello world");
        assert_eq!(result.scrollback, b"hello world");
        assert_eq!(result.broadcast, b"hello world");
        assert!(result.responses.is_empty());
    }

    #[test]
    fn passthrough_sgr_sequences() {
        let mut interceptor = VtQueryInterceptor::new();
        // SGR bold + red
        let result = interceptor.feed(b"\x1b[1;31mhello\x1b[0m");
        assert_eq!(result.scrollback, b"\x1b[1;31mhello\x1b[0m");
        assert_eq!(result.broadcast, b"\x1b[1;31mhello\x1b[0m");
        assert!(result.responses.is_empty());
    }

    #[test]
    fn intercept_da1() {
        let mut interceptor = VtQueryInterceptor::new();
        let result = interceptor.feed(b"before\x1b[cafter");
        assert_eq!(result.scrollback, b"beforeafter");
        assert_eq!(result.broadcast, b"beforeafter");
        assert_eq!(result.responses, vec![b"\x1b[?62;22c" as &[u8]]);
    }

    #[test]
    fn intercept_da1_with_zero_param() {
        let mut interceptor = VtQueryInterceptor::new();
        let result = interceptor.feed(b"\x1b[0c");
        assert_eq!(result.scrollback, b"");
        assert_eq!(result.broadcast, b"");
        assert_eq!(result.responses, vec![b"\x1b[?62;22c" as &[u8]]);
    }

    #[test]
    fn intercept_da2() {
        let mut interceptor = VtQueryInterceptor::new();
        let result = interceptor.feed(b"\x1b[>c");
        assert_eq!(result.scrollback, b"");
        assert_eq!(result.broadcast, b"");
        assert_eq!(result.responses, vec![b"\x1b[>1;0;0c" as &[u8]]);
    }

    #[test]
    fn intercept_da3() {
        let mut interceptor = VtQueryInterceptor::new();
        let result = interceptor.feed(b"\x1b[=c");
        assert_eq!(result.scrollback, b"");
        assert_eq!(result.broadcast, b"");
        assert_eq!(result.responses, vec![b"\x1bP!|00000000\x1b\\" as &[u8]]);
    }

    #[test]
    fn intercept_dsr5() {
        let mut interceptor = VtQueryInterceptor::new();
        let result = interceptor.feed(b"\x1b[5n");
        assert_eq!(result.scrollback, b"");
        assert_eq!(result.broadcast, b"");
        assert_eq!(result.responses, vec![b"\x1b[0n" as &[u8]]);
    }

    #[test]
    fn forward_dsr6() {
        let mut interceptor = VtQueryInterceptor::new();
        let result = interceptor.feed(b"\x1b[6n");
        assert_eq!(result.scrollback, b"");
        assert_eq!(result.broadcast, b"\x1b[6n");
        assert_eq!(result.forwarded_cpr_queries, 1);
        assert!(result.responses.is_empty());
    }

    #[test]
    fn forward_decxcpr() {
        let mut interceptor = VtQueryInterceptor::new();
        let result = interceptor.feed(b"\x1b[?6n");
        assert_eq!(result.scrollback, b"");
        assert_eq!(result.broadcast, b"\x1b[?6n");
        assert_eq!(result.forwarded_cpr_queries, 1);
    }

    #[test]
    fn intercept_xtversion() {
        let mut interceptor = VtQueryInterceptor::new();
        let result = interceptor.feed(b"\x1b[>0q");
        assert_eq!(result.scrollback, b"");
        assert_eq!(result.broadcast, b"");
        assert_eq!(result.responses, vec![b"\x1bP>|btmux(0)\x1b\\" as &[u8]]);
    }

    #[test]
    fn swallow_osc_color_query() {
        let mut interceptor = VtQueryInterceptor::new();
        // OSC 11 ; ? BEL — query background color
        let result = interceptor.feed(b"\x1b]11;?\x07");
        assert_eq!(result.scrollback, b"");
        assert_eq!(result.broadcast, b"");
        assert!(result.responses.is_empty());
    }

    #[test]
    fn passthrough_osc_title() {
        let mut interceptor = VtQueryInterceptor::new();
        // OSC 0 ; hello BEL — set title
        let result = interceptor.feed(b"\x1b]0;hello\x07");
        assert_eq!(result.scrollback, b"\x1b]0;hello\x07");
        assert_eq!(result.broadcast, b"\x1b]0;hello\x07");
    }

    #[test]
    fn split_across_chunks() {
        let mut interceptor = VtQueryInterceptor::new();

        // Send DA1 split across two reads: "\x1b[" then "c"
        let r1 = interceptor.feed(b"\x1b[");
        // Nothing emitted yet — sequence is incomplete
        assert_eq!(r1.scrollback, b"");
        assert_eq!(r1.broadcast, b"");
        assert!(r1.responses.is_empty());

        let r2 = interceptor.feed(b"c");
        assert_eq!(r2.scrollback, b"");
        assert_eq!(r2.broadcast, b"");
        assert_eq!(r2.responses, vec![b"\x1b[?62;22c" as &[u8]]);
    }

    #[test]
    fn multiple_queries_in_one_chunk() {
        let mut interceptor = VtQueryInterceptor::new();
        // DA1 + DA2 + normal text
        let result = interceptor.feed(b"\x1b[c\x1b[>chello");
        assert_eq!(result.scrollback, b"hello");
        assert_eq!(result.broadcast, b"hello");
        assert_eq!(result.responses.len(), 2);
    }

    #[test]
    fn passthrough_cursor_movement() {
        let mut interceptor = VtQueryInterceptor::new();
        // CUP (cursor position) — not a query
        let result = interceptor.feed(b"\x1b[10;20H");
        assert_eq!(result.scrollback, b"\x1b[10;20H");
        assert_eq!(result.broadcast, b"\x1b[10;20H");
        assert!(result.responses.is_empty());
    }

    #[test]
    fn osc_with_st_terminator() {
        let mut interceptor = VtQueryInterceptor::new();
        // OSC 0 ; title ESC \ — set title with ST terminator
        let result = interceptor.feed(b"\x1b]0;mytitle\x1b\\");
        assert_eq!(result.scrollback, b"\x1b]0;mytitle\x1b\\");
        assert_eq!(result.broadcast, b"\x1b]0;mytitle\x1b\\");
    }

    #[test]
    fn swallow_decrqss() {
        let mut interceptor = VtQueryInterceptor::new();
        // DCS $ q <space> q ST — DECRQSS for cursor style
        let result = interceptor.feed(b"\x1bP$q q\x1b\\");
        assert_eq!(result.scrollback, b"");
        assert_eq!(result.broadcast, b"");
    }

    #[test]
    fn can_aborts_sequence() {
        let mut interceptor = VtQueryInterceptor::new();
        // Start a CSI sequence then CAN aborts it
        let result = interceptor.feed(b"\x1b[1;2\x18hello");
        // The partial CSI is emitted (it's not a query), then "hello" passes
        assert_eq!(&result.scrollback[result.scrollback.len() - 5..], b"hello");
    }
}
