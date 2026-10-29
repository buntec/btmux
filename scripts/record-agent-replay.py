#!/usr/bin/env python3
# Record an agent session in a 120x40 PTY as a detection replay fixture.
#
#   scripts/record-agent-replay.py OUT.jsonl [--prompt TEXT] [--dialog TEXT]
#       [--answer KEYS] [--hold SECONDS] [-- COMMAND...]
#
# Runs COMMAND (default `claude`) in a new temporary folder, accepts Claude's
# trust dialog, types --prompt, submits it, waits for --dialog (lowercase text
# on screen, default "esc to cancel"), holds it for --hold seconds (default 8),
# sends --answer (Python escapes, default "\r"), waits for quiet output, and
# sends Ctrl-D twice. The defaults record an AskUserQuestion dialog; pass e.g.
# `-- claude -n demo --model haiku` for a named session.
#
# Each line is `[seconds, kind, base64]`, kind `out` (PTY output), `in`, or
# `note`. The replay tests in src/session/agent.rs find steps by their notes:
# "submit", "dialog wait: hit", "approve". The user name in home paths,
# emails, and the plan name are replaced by same-length placeholders; it fails
# if any remain.
# Check the decoded output for other private text before committing it.
import argparse
import base64
import fcntl
import getpass
import json
import os
import pty
import re
import select
import shutil
import struct
import sys
import tempfile
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument("out")
parser.add_argument(
    "--prompt",
    default="Use the AskUserQuestion tool to ask me one question: red or blue? "
    "Then reply with my answer only.",
)
parser.add_argument("--dialog", default="esc to cancel")
parser.add_argument("--answer", default=r"\r")
parser.add_argument("--hold", type=float, default=8.0)
parser.add_argument("command", nargs="*", default=["claude"])
args = parser.parse_args()
answer = args.answer.encode().decode("unicode_escape").encode()

workdir = tempfile.mkdtemp(prefix="btmux-replay-")
# Don't report to the btmux or Claude Code session this runs in.
env = {
    k: v
    for k, v in os.environ.items()
    if not k.startswith(("CLAUDE", "BTMUX", "TMUX"))
}
env.update(TERM="xterm-256color", COLORTERM="truecolor")

pid, fd = pty.fork()
if pid == 0:
    os.chdir(workdir)
    os.execvpe(args.command[0], args.command, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

start = time.monotonic()
events = []
text = ""
ansi = re.compile(
    r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"
    r"|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]"
)


def log(note):
    print(f"{time.monotonic() - start:8.3f} {note}", file=sys.stderr)


def event(kind, data):
    events.append([round(time.monotonic() - start, 4), kind, data])


def pump(timeout):
    """Records one read; False when nothing arrived in time."""
    global text
    if not select.select([fd], [], [], timeout)[0]:
        return False
    try:
        data = os.read(fd, 65536)
    except OSError:
        data = b""
    if not data:
        raise EOFError
    event("out", data)
    plain = ansi.sub(" ", data.decode("utf-8", "replace"))
    text = re.sub(r"\s+", " ", text + " " + plain)[-20000:]
    return True


def screen():
    return text.lower()


def quiet(seconds, limit):
    """Reads until `seconds` pass without output, at most `limit`."""
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline and pump(seconds):
        pass


def wait_for(needle, timeout, since):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if needle in screen()[since:]:
            return True
        pump(0.05)
    sys.exit(f"timed out waiting for {needle!r}; screen: {screen()[-600:]!r}")


def send(data, note):
    os.write(fd, data)
    event("in", data)
    mark(note)


def mark(note):
    event("note", note.encode())
    log(note)


try:
    quiet(1.5, 20)
    if "trust" in screen():
        if "❯ no, exit" in screen():
            send(b"\x1b[B", "down")
            quiet(0.5, 2)
        send(b"\r", "accept trust")
        quiet(1.5, 20)
    send(args.prompt.encode(), "type prompt")
    quiet(1.0, 5)
    since = len(screen())
    send(b"\r", "submit")
    wait_for(args.dialog, 120, since)
    mark("dialog wait: hit")
    quiet(args.hold, args.hold)
    send(answer, "approve")
    quiet(5.0, 120)
    for _ in range(2):
        send(b"\x04", "ctrl-d")
        quiet(1.0, 5)
except EOFError:
    pass
finally:
    shutil.rmtree(workdir, ignore_errors=True)

user = getpass.getuser().encode()
home = b"|".join(rb"(?<=%s)" % re.escape(p) for p in (b"/Users/", b"-Users-", b"/home/", b"-home-"))
scrubs = [
    (rb"(?:%s)%s" % (home, re.escape(user)), b"developer"),
    (rb"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", b"x"),
    (rb"(?<=Claude )(?:Max|Pro|Team|Enterprise)\b", b"---"),
]


def scrub(data):
    for pattern, fill in scrubs:
        data = re.sub(
            pattern, lambda m: (fill * len(m[0]))[: len(m[0])], data
        )
    return data


events = [[at, kind, scrub(data)] for at, kind, data in events]
# A match split across reads survives the per-read scrub.
blob = b"".join(data for _, _, data in events)
if any(re.search(pattern, blob) for pattern, _ in scrubs):
    sys.exit("private text split across reads; record again")
with open(args.out, "w") as f:
    for at, kind, data in events:
        f.write(f"[{at}, {json.dumps(kind)}, \"{base64.b64encode(data).decode()}\"]\n")
log(f"wrote {len(events)} events to {args.out}")
