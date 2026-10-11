// VT Query Interceptor — a lightweight escape sequence state machine that
// recognizes terminal query sequences (those expecting a response) and
// dispatches them appropriately.
//
// Modeled after tmux's input.c state machine topology, but only parses
// sequence *structure* — it doesn't track screen state. Handles sequences
// split across read() chunk boundaries.

use super::colors::{parse_spec, x11_spec, Overrides, SharedPalette, Slot};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// What to do with a recognized sequence.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Emit bytes to both scrollback and broadcast (normal output).
    Pass,
    /// Strip from both scrollback and broadcast, write a canned response
    /// back to the PTY master.
    Answer(Vec<u8>),
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
    OscEscape,
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
    pub responses: Vec<Vec<u8>>,
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
    /// Theme colors for OSC 4/10/11/12 replies; queries are swallowed without one.
    palette: SharedPalette,
    /// Mode 2031: the program wants `CSI ? 997 ; Ps n` on theme changes.
    color_reports: Arc<AtomicBool>,
    /// Colors the program set, so replies match what the emulator renders.
    overrides: Overrides,
    /// Whether the OSC being dispatched ended with ST rather than BEL.
    osc_st: bool,
}

impl VtQueryInterceptor {
    pub fn new() -> Self {
        Self::with_colors(SharedPalette::default(), Arc::default())
    }

    pub fn with_colors(palette: SharedPalette, color_reports: Arc<AtomicBool>) -> Self {
        Self {
            state: State::Ground,
            param_buf: Vec::with_capacity(64),
            interm_buf: Vec::with_capacity(4),
            payload_buf: Vec::with_capacity(256),
            raw_seq: Vec::with_capacity(64),
            palette,
            color_reports,
            overrides: Overrides::default(),
            osc_st: false,
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
        if byte == 0x1b
            && !matches!(
                self.state,
                State::Ground | State::OscString | State::DcsPassthrough
            )
        {
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
            State::OscEscape => self.osc_escape(byte, result),
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
            // RIS: the emulator resets its colors and modes.
            b'c' => {
                self.color_reports.store(false, Ordering::Relaxed);
                self.overrides.clear();
                self.emit_raw(result);
                self.enter_ground();
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
                Action::Answer(b"\x1b[?62;22c".to_vec())
            }

            // ── DA2: CSI > c  or  CSI > 0 c ──
            (Some(b'>'), b'c', []) if param_body.is_empty() || param_body == b"0" => {
                Action::Answer(b"\x1b[>1;0;0c".to_vec())
            }

            // ── DA3: CSI = c  or  CSI = 0 c ──
            (Some(b'='), b'c', []) if param_body.is_empty() || param_body == b"0" => {
                // DCS ! | <hex-encoded unit ID> ST — we use all zeros like tmux.
                Action::Answer(b"\x1bP!|00000000\x1b\\".to_vec())
            }

            // ── DSR 5 (device status): CSI 5 n → "OK" ──
            (None, b'n', []) if param_body == b"5" => Action::Answer(b"\x1b[0n".to_vec()),

            // ── DSR 6 (cursor position): CSI 6 n → forward to emulator ──
            (None, b'n', []) if param_body == b"6" => Action::Forward,

            // ── DECXCPR: CSI ? 6 n → forward to emulator ──
            (Some(b'?'), b'n', []) if param_body == b"6" => Action::Forward,

            // ── XTVERSION: CSI > 0 q ──
            (Some(b'>'), b'q', []) if param_body.is_empty() || param_body == b"0" => {
                Action::Answer(b"\x1bP>|btmux(0)\x1b\\".to_vec())
            }

            // ── DECRPM: CSI ? <Ps> $ p (request mode) ──
            // Answer with "mode not recognized" (Ps;0$y) for everything.
            // This is safe — it tells the app "I don't track that mode" rather than
            // hanging forever or letting N emulators answer.
            (Some(b'?'), b'p', [b'$']) if param_body == b"2031" => {
                let state = if self.color_reports.load(Ordering::Relaxed) {
                    1
                } else {
                    2
                };
                Action::Answer(format!("\x1b[?2031;{state}$y").into_bytes())
            }
            (Some(b'?'), b'p', [b'$']) => {
                // For now, swallow. A proper implementation would answer with
                // the mode status, but that requires tracking mode state.
                Action::Swallow
            }

            // ── Mode 2031 (color-scheme notifications): CSI ? 2031 h / l ──
            // Tracked here; reports come from the backend on theme changes.
            (Some(b'?'), b'h' | b'l', []) if has_param(param_body, b"2031") => {
                self.color_reports
                    .store(final_byte == b'h', Ordering::Relaxed);
                if param_body == b"2031" {
                    Action::Swallow
                } else {
                    Action::Pass
                }
            }

            // ── Color-scheme query: CSI ? 996 n ──
            (Some(b'?'), b'n', []) if param_body == b"996" => match self.palette.get() {
                Some(palette) => Action::Answer(palette.scheme_report()),
                None => Action::Swallow,
            },

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
                self.osc_st = false;
                self.dispatch_osc(result);
                self.enter_ground();
            }
            // C1 ST (0x9C) terminates OSC
            0x9c => {
                self.osc_st = true;
                self.dispatch_osc(result);
                self.enter_ground();
            }
            // ESC: ST (ESC \) or an aborted OSC
            0x1b => {
                self.state = State::OscEscape;
            }
            _ => {
                self.payload_buf.push(byte);
            }
        }
    }

    fn osc_escape(&mut self, byte: u8, result: &mut FilterResult) {
        if byte == b'\\' {
            self.raw_seq.push(byte);
            self.osc_st = true;
            self.dispatch_osc(result);
            self.enter_ground();
        } else {
            // ESC aborts the OSC and starts a new sequence.
            self.raw_seq.pop();
            self.emit_raw(result);
            self.enter_ground();
            self.ground(0x1b, result);
            self.process_byte(byte, result);
        }
    }

    fn dispatch_osc(&mut self, result: &mut FilterResult) {
        // OSC payload format: "<code>;<data>"
        let payload = std::mem::take(&mut self.payload_buf);
        let (code_bytes, data) = match payload.iter().position(|&b| b == b';') {
            Some(pos) => (&payload[..pos], &payload[pos + 1..]),
            None => (payload.as_slice(), &[] as &[u8]),
        };
        let code: u32 = std::str::from_utf8(code_bytes)
            .ok()
            .and_then(|code| code.parse().ok())
            .unwrap_or(u32::MAX);

        match code {
            4 | 10..=12 => self.color_osc(code, data, result),

            // OSC 104 [; index…] / 110–112 — reset colors
            104 => {
                let items = data.split(|&b| b == b';');
                if items.clone().all(|item| item.is_empty()) {
                    self.overrides.reset_indexed();
                }
                for index in items.filter_map(parse_index) {
                    self.overrides.set(Slot::Indexed(index), None);
                }
                self.emit_raw(result);
            }
            110..=112 => {
                if let Some(slot) = Slot::dynamic(code - 100) {
                    self.overrides.set(slot, None);
                }
                self.emit_raw(result);
            }

            // OSC 52 ; <clipboard> ; ? — swallow clipboard queries
            52 if data
                .iter()
                .position(|&b| b == b';')
                .is_some_and(|pos| &data[pos + 1..] == b"?") => {}

            // Everything else passes through (OSC 0/2 title, OSC 7 cwd, etc.)
            _ => self.emit_raw(result),
        }
        self.payload_buf = payload;
    }

    /// OSC 4 ; index ; spec … and OSC 10–12 ; spec …, where each extra
    /// spec targets the next code, as in xterm. Sets are tracked; queries
    /// are answered here and the sets are forwarded to the emulator.
    fn color_osc(&mut self, code: u32, data: &[u8], result: &mut FilterResult) {
        let items: Vec<&[u8]> = data.split(|&b| b == b';').collect();
        let requests: Vec<(Option<Slot>, &[u8])> = if code == 4 {
            items
                .chunks(2)
                .map(|pair| {
                    (
                        parse_index(pair[0]).map(Slot::Indexed),
                        pair.get(1).copied().unwrap_or_default(),
                    )
                })
                .collect()
        } else {
            (code..)
                .zip(items)
                .map(|(c, spec)| (Slot::dynamic(c), spec))
                .collect()
        };
        let queried = requests.iter().any(|(_, spec)| *spec == b"?");
        let palette = self.palette.get();
        let mut sets = Vec::new();
        let mut reply = Vec::new();
        for (slot, spec) in requests {
            let Some(slot) = slot else { continue };
            if spec == b"?" {
                if let Some(palette) = &palette {
                    let rgb = self.overrides.get(palette, slot);
                    self.push_osc(&mut reply, slot, x11_spec(rgb).as_bytes());
                }
                continue;
            }
            // X11 color names reach the emulator but are not tracked.
            if let Some(rgb) = parse_spec(spec) {
                self.overrides.set(slot, Some(rgb));
            }
            self.push_osc(&mut sets, slot, spec);
        }
        if !queried {
            self.emit_raw(result);
            return;
        }
        result.scrollback.extend_from_slice(&sets);
        result.broadcast.extend_from_slice(&sets);
        if !reply.is_empty() {
            result.responses.push(reply);
        }
    }

    /// Uses the query's terminator, as xterm does.
    fn push_osc(&self, out: &mut Vec<u8>, slot: Slot, spec: &[u8]) {
        out.extend_from_slice(b"\x1b]");
        out.extend_from_slice(slot.osc_prefix().as_bytes());
        out.push(b';');
        out.extend_from_slice(spec);
        let terminator: &[u8] = if self.osc_st { b"\x1b\\" } else { b"\x07" };
        out.extend_from_slice(terminator);
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

fn parse_index(index: &[u8]) -> Option<u8> {
    std::str::from_utf8(index).ok()?.parse().ok()
}

fn has_param(params: &[u8], param: &[u8]) -> bool {
    params.split(|&b| b == b';').any(|p| p == param)
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

    fn themed() -> (VtQueryInterceptor, Arc<AtomicBool>) {
        let palette = SharedPalette::default();
        palette.set(super::super::colors::Palette::from_theme(
            &crate::config::default_theme(),
        ));
        let reports = Arc::new(AtomicBool::new(false));
        (
            VtQueryInterceptor::with_colors(palette, reports.clone()),
            reports,
        )
    }

    #[test]
    fn answers_background_query_with_matching_terminator() {
        let (mut interceptor, _) = themed();
        let result = interceptor.feed(b"a\x1b]11;?\x1b\\b\x1b]11;?\x07");
        assert_eq!(result.scrollback, b"ab");
        assert_eq!(result.broadcast, b"ab");
        assert_eq!(
            result.responses,
            vec![
                b"\x1b]11;rgb:1414/1111/0b0b\x1b\\" as &[u8],
                b"\x1b]11;rgb:1414/1111/0b0b\x07",
            ]
        );
    }

    #[test]
    fn answers_chained_and_indexed_color_queries() {
        let (mut interceptor, _) = themed();
        let result = interceptor.feed(b"\x1b]10;?;?\x07\x1b]4;1;?;196;?\x07");
        let replies: Vec<String> = result
            .responses
            .iter()
            .map(|r| String::from_utf8_lossy(r).into_owned())
            .collect();
        assert!(replies[0].starts_with("\x1b]10;rgb:"));
        assert!(replies[0].contains("\x07\x1b]11;rgb:1414/1111/0b0b\x07"));
        assert!(replies[1].starts_with("\x1b]4;1;rgb:"));
        assert!(replies[1].ends_with("\x1b]4;196;rgb:ffff/0000/0000\x07"));
    }

    #[test]
    fn color_queries_answer_before_da1_fence() {
        let (mut interceptor, _) = themed();
        let result = interceptor.feed(b"\x1b]11;?\x1b\\\x1b[c");
        assert_eq!(result.responses.len(), 2);
        assert!(result.responses[0].starts_with(b"\x1b]11;"));
        assert_eq!(result.responses[1], b"\x1b[?62;22c");
    }

    #[test]
    fn color_sets_pass_through() {
        let (mut interceptor, _) = themed();
        let result = interceptor.feed(b"\x1b]11;#000000\x1b\\\x1b]4;1;#ff0000\x07");
        assert_eq!(
            result.broadcast,
            b"\x1b]11;#000000\x1b\\\x1b]4;1;#ff0000\x07"
        );
        assert!(result.responses.is_empty());
    }

    fn theme() -> super::super::colors::Palette {
        super::super::colors::Palette::from_theme(&crate::config::default_theme()).unwrap()
    }

    #[test]
    fn mixed_osc4_forwards_sets_and_answers_queries() {
        let (mut interceptor, _) = themed();
        let result = interceptor.feed(b"\x1b]4;1;#123456;2;?;1;?\x1b\\");
        assert_eq!(result.scrollback, b"\x1b]4;1;#123456\x1b\\");
        assert_eq!(result.broadcast, b"\x1b]4;1;#123456\x1b\\");
        let expected = format!(
            "\x1b]4;2;{}\x1b\\\x1b]4;1;rgb:1212/3434/5656\x1b\\",
            x11_spec(theme().ansi[2])
        );
        assert_eq!(result.responses, vec![expected.into_bytes()]);
    }

    #[test]
    fn replies_reflect_pane_color_changes() {
        let (mut interceptor, _) = themed();
        let result = interceptor.feed(
            b"\x1b]4;1;#123456\x07\x1b]4;1;?\x07\x1b]104;1\x07\x1b]4;1;?\x07\
              \x1b]11;rgb:0/0/0\x07\x1b]11;?\x07\x1b]111\x07\x1b]11;?\x07",
        );
        assert_eq!(
            result.broadcast,
            b"\x1b]4;1;#123456\x07\x1b]104;1\x07\x1b]11;rgb:0/0/0\x07\x1b]111\x07"
        );
        let theme = theme();
        assert_eq!(
            result.responses,
            vec![
                b"\x1b]4;1;rgb:1212/3434/5656\x07".to_vec(),
                format!("\x1b]4;1;{}\x07", x11_spec(theme.ansi[1])).into_bytes(),
                b"\x1b]11;rgb:0000/0000/0000\x07".to_vec(),
                format!("\x1b]11;{}\x07", x11_spec(theme.background)).into_bytes(),
            ]
        );
    }

    #[test]
    fn mixed_dynamic_colors_forward_sets() {
        let (mut interceptor, _) = themed();
        let result = interceptor.feed(b"\x1b]10;?;#ffffff\x07\x1b]11;?\x07");
        assert_eq!(result.broadcast, b"\x1b]11;#ffffff\x07");
        assert_eq!(
            result.responses,
            vec![
                format!("\x1b]10;{}\x07", x11_spec(theme().foreground)).into_bytes(),
                b"\x1b]11;rgb:ffff/ffff/ffff\x07".to_vec(),
            ]
        );
    }

    #[test]
    fn untracked_color_names_still_reach_the_emulator() {
        let (mut interceptor, _) = themed();
        let result = interceptor.feed(b"\x1b]4;1;red;1;?\x07");
        assert_eq!(result.broadcast, b"\x1b]4;1;red\x07");
        assert_eq!(
            result.responses,
            vec![format!("\x1b]4;1;{}\x07", x11_spec(theme().ansi[1])).into_bytes()]
        );
    }

    #[test]
    fn reset_clears_color_state() {
        let (mut interceptor, reports) = themed();
        interceptor.feed(b"\x1b[?2031h\x1b]4;1;#123456\x07");
        assert!(reports.load(Ordering::Relaxed));
        let result = interceptor.feed(b"\x1bc\x1b[?2031$p\x1b]4;1;?\x07");
        assert!(!reports.load(Ordering::Relaxed));
        assert_eq!(result.broadcast, b"\x1bc");
        assert_eq!(
            result.responses,
            vec![
                b"\x1b[?2031;2$y".to_vec(),
                format!("\x1b]4;1;{}\x07", x11_spec(theme().ansi[1])).into_bytes(),
            ]
        );
    }

    #[test]
    fn esc_aborts_osc() {
        let mut interceptor = VtQueryInterceptor::new();
        let result = interceptor.feed(b"\x1b]0;ti\x1b[1mx");
        assert_eq!(result.broadcast, b"\x1b]0;ti\x1b[1mx");
    }

    #[test]
    fn tracks_color_scheme_mode() {
        let (mut interceptor, reports) = themed();
        let result = interceptor.feed(b"\x1b[?2031$p\x1b[?2031h\x1b[?2031$p\x1b[?996n");
        assert!(reports.load(Ordering::Relaxed));
        assert_eq!(result.broadcast, b"");
        assert_eq!(
            result.responses,
            vec![
                b"\x1b[?2031;2$y" as &[u8],
                b"\x1b[?2031;1$y",
                b"\x1b[?997;1n",
            ]
        );
        let result = interceptor.feed(b"\x1b[?1049;2031l");
        assert!(!reports.load(Ordering::Relaxed));
        assert_eq!(result.broadcast, b"\x1b[?1049;2031l");
    }
}
