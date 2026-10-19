-- Drives the btmux desktop app for scripts/record-desktop-demo.sh.
--
--   osascript desktop-demo.applescript connect
--   osascript desktop-demo.applescript line <text>
--   osascript desktop-demo.applescript park
--   osascript desktop-demo.applescript play <demo> <prefix> [delay scale] [sync test]
--
-- `connect` expects the demo server to be the picker's only, focused entry,
-- fills the primary screen's visible area, and prints the window bounds as
-- x,y,w,h. `park` moves the mouse onto the menu bar, out of the recording.
-- `play` runs one demo (panes, files, nvim, agents, latex, or shaders), multiplying its
-- pauses, typing, and mouse movement by the delay scale (default 1). It waits
-- for marker files in the server's sync dir: lsp-ready once rust-analyzer has
-- loaded, and the demo agents' progress. The sync test is a shell command
-- that, followed by "/<marker>", checks for one, e.g. "test -e <sync dir>".
-- Every keystroke first checks that btmux is frontmost, so typing never lands
-- in another app.

use AppleScript version "2.4"
use framework "AppKit"
use scripting additions

property bundleId : "com.btmux.desktop"
property mouseScript : ""
property delayScale : 1
property syncTest : ""

on run argv
	set mouseScript to (do shell script "dirname " & quoted form of POSIX path of (path to me)) & "/desktop-demo-mouse.js"
	set command to item 1 of argv
	if command is "connect" then
		return connect()
	else if command is "line" then
		typeText(item 2 of argv, 0)
		enter()
	else if command is "park" then
		park()
	else if command is "play" then
		if (count of argv) > 3 then
			-- NSString parsing ignores the locale's decimal separator.
			set delayScale to (current application's NSString's stringWithString:(item 4 of argv))'s doubleValue()
		end if
		if (count of argv) > 4 then set syncTest to item 5 of argv
		play(item 2 of argv, item 3 of argv)
	else
		error "Unknown command: " & command
	end if
end run

on connect()
	tell application id bundleId to activate
	tell application "System Events"
		tell (first process whose bundle identifier is bundleId)
			repeat 60 times
				if (count of windows) > 0 then exit repeat
				delay 0.5
			end repeat
			if (count of windows) is 0 then error "The btmux window did not appear"
		end tell
	end tell
	-- Let discovery finish; the picker then focuses its first server.
	delay 3
	enter()
	delay 3
	set {x, y, w, h} to visibleBounds()
	tell application "System Events"
		tell (first process whose bundle identifier is bundleId)
			set position of window 1 to {x, y}
			set size of window 1 to {w, h}
			delay 1
			set {px, py} to position of window 1
			set {sw, sh} to size of window 1
		end tell
	end tell
	return (px as text) & "," & (py as text) & "," & (sw as text) & "," & (sh as text)
end connect

on play(demo, prefixSpec)
	if demo is "panes" then
		playPanes(prefixSpec)
	else if demo is "files" then
		playFiles(prefixSpec)
	else if demo is "nvim" then
		playNvim(prefixSpec)
	else if demo is "agents" then
		playAgents(prefixSpec)
	else if demo is "latex" then
		playLatex(prefixSpec)
	else if demo is "shaders" then
		playShaders(prefixSpec)
	else
		error "Unknown demo: " & demo
	end if
end play

-- Sessions, windows, and panes
on playPanes(prefixSpec)
	typeSlowly("echo \"hello from btmux\"")
	enter()
	pace(1)
	chord(prefixSpec, "%")
	pace(1.2)
	typeSlowly("ls")
	enter()
	pace(1)
	chord(prefixSpec, "\"")
	pace(1.2)
	typeSlowly("git log --oneline -8")
	enter()
	pace(1.5)
	chordKey(prefixSpec, 123) -- left
	pace(0.8)
	repeat 2 times
		sendPrefix(prefixSpec)
		optionKey(124) -- right, resize by 5
		pace(0.5)
	end repeat
	pace(0.5)
	chord(prefixSpec, "z")
	pace(1.2)
	chord(prefixSpec, "z")
	pace(1)
	-- Every layout preset
	repeat 5 times
		chord(prefixSpec, " ")
		pace(1)
	end repeat
	pace(0.5)

	-- Rename this window, then open another
	chord(prefixSpec, ",")
	pace(0.8)
	repeat 16 times
		keyCode(51) -- backspace
	end repeat
	typeSlowly("code")
	pace(0.5)
	enter()
	pace(1)
	-- New windows open in HOME, the playground
	chord(prefixSpec, "c")
	pace(1.2)
	typeSlowly("ls")
	enter()
	pace(1)
	typeSlowly("cd wterm")
	enter()
	pace(0.6)
	typeSlowly("git status")
	enter()
	pace(1.5)
	chord(prefixSpec, "p")
	pace(1.2)
	chord(prefixSpec, "n")
	pace(1.2)

	-- Window grid: back to the first window
	chord(prefixSpec, "w")
	pace(2)
	press("l")
	pace(1)
	enter()
	pace(1.5)

	-- Session picker: unfold both sessions and switch to wterm
	chord(prefixSpec, "s")
	pace(1.2)
	press("l")
	pace(1.2)
	repeat 3 times
		press("j")
		pace(0.6)
	end repeat
	press("l")
	pace(1)
	press("j")
	pace(1)
	enter()
	pace(1.2)
	typeSlowly("ls")
	enter()
	pace(1.5)
	chord(prefixSpec, "L") -- last session
	pace(1.5)

	-- Key bindings: Ctrl-D to the bottom (4 half pages cover small screens),
	-- then Ctrl-U back to the top
	chord(prefixSpec, "?")
	pace(1.5)
	repeat 4 times
		ctrl("d")
		pace(0.7)
	end repeat
	pace(0.8)
	repeat 4 times
		ctrl("u")
		pace(0.5)
	end repeat
	pace(1)
	escape()
	pace(1.5)
end playPanes

-- File browser (smooth preview scrolling, file and content search), Git
-- mode, and process viewer
on playFiles(prefixSpec)
	-- Filter down to README.md and scroll its preview with smooth Ctrl-D/U
	chord(prefixSpec, "f")
	pace(1.5)
	press("g")
	press("/")
	pace(0.4)
	typeSlowly("readme")
	pace(1.5)
	repeat 3 times
		ctrl("d")
		pace(1)
	end repeat
	pace(0.5)
	repeat 3 times
		ctrl("u")
		pace(0.8)
	end repeat
	pace(0.5)
	escape() -- leave the filter
	pace(0.8)

	-- File search, then content search, each previewing the focused result
	press("f")
	pace(0.6)
	typeSlowly("layout")
	pace(1.5)
	repeat 3 times
		ctrl("n")
		pace(1)
	end repeat
	pace(0.5)
	escape() -- leave search
	pace(0.6)
	press("s")
	pace(0.6)
	typeSlowly("broadcast_state")
	pace(1.5)
	repeat 4 times
		ctrl("n")
		pace(1)
	end repeat
	pace(0.5)
	escape() -- leave search
	pace(0.3)
	escape() -- close
	pace(0.8)

	-- Git mode (the first Escape leaves Git mode, the second closes)
	chord(prefixSpec, "g")
	pace(2)
	repeat 3 times
		press("j")
		pace(0.4)
	end repeat
	pace(1.5)
	escape()
	pace(0.3)
	escape()
	pace(0.8)

	-- Process viewer: sort by memory, tree view, the ports view, then filter
	-- down to the pane shells
	chord(prefixSpec, "t")
	pace(2)
	repeat 4 times
		press("j")
		pace(0.4)
	end repeat
	pace(0.5)
	press("s")
	pace(1.5)
	press("V")
	pace(1.5)
	ctrl("d")
	pace(1.2)
	press("p")
	pace(1.5)
	press("j")
	pace(0.5)
	enter()
	pace(1.5)
	press("p")
	pace(1)
	press("/")
	pace(0.5)
	typeSlowly("fish")
	pace(0.5)
	enter()
	pace(1.5)
	repeat 2 times
		press("j")
		pace(0.6)
	end repeat
	pace(1)
	press("q")
	pace(1.5)
end playFiles

-- Built-in Neovim: open a Rust source, wait for rust-analyzer, then retype a
-- line with completion, docs, and signature help.
on playNvim(prefixSpec)
	chord(prefixSpec, "e")
	pace(1.5)
	typeSlowly(":e src/ses")
	keyCode(48) -- tab
	pace(0.6)
	typeSlowly("lay")
	keyCode(48)
	pace(0.8)
	enter()
	pace(2.5)
	typeSlowly("/ids\\.extend")
	pace(0.5)
	enter()
	pace(1)
	waitFor("lsp-ready", 60)
	press("S")
	pace(0.5)
	typeSlowly("ids.")
	pace(1.2)
	typeSlowly("ext")
	pace(1)
	-- extract_if, extend_from_slice, extend_from_within, extend
	repeat 4 times
		ctrl("n")
		pace(1)
	end repeat
	ctrl("y")
	pace(0.5)
	typeSlowly("(")
	pace(1.5)
	typeSlowly("right.")
	pace(1.2)
	typeSlowly("pane_ids")
	pace(0.6)
	ctrl("y") -- close the menu so "(" doesn't refresh it
	typeSlowly("())")
	pace(0.5)
	typeSlowly(";")
	pace(1)
	escape()
	pace(0.8)
	-- Hover docs for extend
	typeSlowly("^ww")
	pace(0.5)
	press("K")
	pace(2.5)
	typeSlowly(":q!")
	pace(0.5)
	enter()
	pace(1.5)
end playNvim

-- Agents (scripts/desktop-demo-agent.sh): three panes, then the agent grid
-- once Claude waits for permission and Codex is done
on playAgents(prefixSpec)
	typeSlowly("claude")
	enter()
	pace(1.5)
	typeSlowly("add a --json flag to btmux list")
	enter()
	pace(1.5)
	chord(prefixSpec, "%")
	pace(1.2)
	typeSlowly("codex")
	enter()
	pace(1.5)
	typeSlowly("why is pane replay slow?")
	enter()
	pace(1.5)
	chord(prefixSpec, "\"")
	pace(1.2)
	typeSlowly("gemini")
	enter()
	pace(1.5)
	typeSlowly("explain the session tree")
	enter()
	waitFor("claude-blocked", 30)
	waitFor("codex-done", 30)
	pace(2.5)

	-- Jump to Claude and approve
	chord(prefixSpec, "a")
	pace(2.5)
	press("1")
	pace(1)
	enter()
	pace(1.5)
	press("y")
	waitFor("claude-done", 30)
	pace(1.5)
	waitFor("gemini-done", 60)
	pace(2.5)

	-- Everyone is done; jump to Gemini's answer
	chord(prefixSpec, "a")
	pace(2.5)
	press("3")
	pace(1)
	enter()
	pace(2.5)
end playAgents

-- LaTeX in agent output (scripts/desktop-demo-agent.sh), rendered in the
-- side panel; hovering a formula highlights its source
on playLatex(prefixSpec)
	typeSlowly("codex")
	enter()
	pace(1.5)
	typeSlowly("why is the Gaussian integral sqrt(pi)?")
	enter()
	waitFor("codex-done", 30)
	pace(1.5)
	chord(prefixSpec, "m")
	pace(2)
	-- The panel's formulas, top to bottom, at its horizontal center
	set {cx, cy, cw, ch} to contentBounds()
	set x to int(cx + cw - 240)
	repeat with i from 0 to 7
		mouse("glide " & x & " " & int(cy + 80 + i * 60) & " " & int(500 * delayScale))
		pace(1)
	end repeat
	park()
	pace(1)
	chord(prefixSpec, "m")
	pace(1.5)
end playLatex

-- Cursor Trail (from config.toml) follows the terminal cursor across panes,
-- then the mouse; then a Pixelate effect, added in Settings, pixelates it
on playShaders(prefixSpec)
	typeSlowly("echo \"wallpaper-shader-follows-keyboard-input = true makes the shader effect follow the keyboard cursor\"")
	enter()
	pace(1)
	typeSlowly("git log --oneline -8")
	enter()
	pace(1.2)
	chord(prefixSpec, "%")
	pace(1.2)
	typeSlowly("ls")
	enter()
	pace(1)
	chord(prefixSpec, "\"")
	pace(1.2)
	typeSlowly("echo \"across panes\"")
	enter()
	pace(1)
	chordKey(prefixSpec, 123) -- left
	pace(0.8)
	typeSlowly("echo \"wallpaper-shader-follows-mouse-cursor = true makes it follow the mouse\"")
	enter()
	pace(1)
	mouseTour(4000)

	addPixelateLayer(prefixSpec)
	-- Focus comes back to the terminal late; click the active, left pane
	set {cx, cy, cw, ch} to contentBounds()
	mouse("click " & int(cx + cw * 0.25) & " " & int(cy + ch * 0.6) & " " & int(600 * delayScale))
	park()
	pace(0.8)
	typeSlowly("echo \"shader layer 2 = pixelate, an effect over the layers below it\"")
	enter()
	pace(1)
	chordKey(prefixSpec, 124) -- right
	pace(0.8)
	typeSlowly("git status")
	enter()
	pace(1.5)
	mouseTour(5000)
	pace(1.5)
end playShaders

-- Glides across the content, swirls around its center, and parks
on mouseTour(swirlMs)
	set {cx, cy, cw, ch} to contentBounds()
	mouse("glide " & int(cx + cw * 0.2) & " " & int(cy + ch * 0.3) & " " & int(900 * delayScale))
	pace(0.3)
	mouse("glide " & int(cx + cw * 0.8) & " " & int(cy + ch * 0.75) & " " & int(1500 * delayScale))
	pace(0.3)
	mouse("swirl " & int(cx + cw / 2) & " " & int(cy + ch / 2) & " " & int(cw * 0.3) & " " & int(ch * 0.3) & " " & int(swirlMs * delayScale))
	park()
	pace(1)
end mouseTour

-- Adds a Pixelate layer in Settings, shows the generated TOML, and applies
-- it, which also closes Settings; the terminal needs a click to get the
-- keyboard back
on addPixelateLayer(prefixSpec)
	chord(prefixSpec, ":")
	pace(0.8)
	typeSlowly("set")
	pace(0.6)
	enter()
	pace(1.2)
	-- The title is focused first, then Close, then the selected tab; arrows
	-- move between tabs and Enter opens one
	tabs(2)
	repeat 4 times
		keyCode(124) -- right, to Wallpaper
		sleepFor(0.25)
	end repeat
	enter()
	pace(1)
	-- Past the wallpaper URL, six sliders, two switches, and layer 1 (shader,
	-- switch, remove, and its settings, open for a single layer: the trigger,
	-- blend mode, opacity, interactive, eight parameters, randomize, and
	-- reset) to Add shader layer
	tabs(27)
	keyCode(49) -- space
	pace(0.8)
	typeSlowly("pixel")
	pace(0.6)
	keyCode(125) -- down
	sleepFor(0.25)
	enter()
	pace(1.2)
	-- The dialog is centered and 90% of the content's height; Show TOML
	-- widens it, which moves Apply
	set {cx, cy, cw, ch} to contentBounds()
	set midX to cx + cw / 2
	set dialogBottom to cy + ch * 0.95
	mouse("click " & int(midX - 207) & " " & int(dialogBottom - 37) & " " & int(800 * delayScale)) -- Show TOML
	pace(2.5)
	mouse("click " & int(midX - 47) & " " & int(dialogBottom - 32) & " " & int(800 * delayScale)) -- Apply
	pace(1)
end addPixelateLayer

-- The primary screen's area outside the menu bar and Dock, in the top-left
-- origin coordinates System Events uses.
on visibleBounds()
	set primary to current application's NSScreen's screens()'s firstObject()
	set {{sx, sy}, {sw, sh}} to primary's frame()
	set {{vx, vy}, {vw, vh}} to primary's visibleFrame()
	return {vx as integer, (sh - vy - vh) as integer, vw as integer, vh as integer}
end visibleBounds

-- The window's web content area: its frame below the title bar (32 points on
-- macOS 26). While recording, `window 1` can be the capture indicator.
on contentBounds()
	tell application "System Events"
		tell (first process whose bundle identifier is bundleId)
			set w to first window whose subrole is "AXStandardWindow"
			set {wx, wy} to position of w
			set {ww, wh} to size of w
		end tell
	end tell
	return {wx, wy + 32, ww, wh - 32}
end contentBounds

-- Mouse helpers

on mouse(args)
	ensureFront()
	do shell script "osascript -l JavaScript " & quoted form of mouseScript & " " & args
end mouse

-- Whole points, avoiding locale-specific decimal separators.
on int(x)
	return (round x) as integer as text
end int

on park()
	set {x, y, w, h} to visibleBounds()
	do shell script "osascript -l JavaScript " & quoted form of mouseScript & " glide " & int(x + w / 2) & " 1 " & int(500 * delayScale)
end park

-- Keyboard helpers

-- NSWorkspace, as asking System Events takes ~25 ms per keystroke.
on ensureFront()
	set frontApp to current application's NSWorkspace's sharedWorkspace()'s frontmostApplication()
	if frontApp is missing value or (frontApp's bundleIdentifier() as text) is not bundleId then
		error "btmux is no longer frontmost; stopping so keystrokes go nowhere else" number 1001
	end if
end ensureFront

on sendPrefix(prefixSpec)
	if prefixSpec starts with "C-" then
		set modifier to control down
	else if prefixSpec starts with "M-" then
		set modifier to option down
	else
		error "Unsupported prefix: " & prefixSpec
	end if
	set k to text 3 thru -1 of prefixSpec
	if length of k is not 1 then error "Unsupported prefix key: " & k
	ensureFront()
	tell application "System Events" to keystroke k using modifier
	sleepFor(0.15)
end sendPrefix

on chord(prefixSpec, k)
	sendPrefix(prefixSpec)
	press(k)
end chord

on chordKey(prefixSpec, code)
	sendPrefix(prefixSpec)
	keyCode(code)
end chordKey

on press(k)
	ensureFront()
	tell application "System Events" to keystroke k
end press

on tabs(n)
	repeat n times
		keyCode(48)
		sleepFor(0.05)
	end repeat
end tabs

on ctrl(k)
	ensureFront()
	tell application "System Events" to keystroke k using control down
end ctrl

on optionKey(code)
	ensureFront()
	tell application "System Events" to key code code using option down
end optionKey

on keyCode(code)
	ensureFront()
	tell application "System Events" to key code code
end keyCode

on enter()
	keyCode(36)
end enter

on escape()
	keyCode(53)
end escape

on typeText(s, pause)
	repeat with c in characters of s
		press(c as text)
		sleepFor(pause)
	end repeat
end typeText

on typeSlowly(s)
	typeText(s, 0.06 * delayScale)
end typeSlowly

-- Unscaled: rust-analyzer and the demo agents run at their own pace.
-- Not "seconds", an AppleScript constant.
on waitFor(marker, limit)
	if syncTest is "" then return
	set check to syncTest & "/" & marker
	do shell script "end=$(($(date +%s) + " & limit & ")); until " & check & "; do [ $(date +%s) -lt $end ] || { echo '" & marker & " did not appear within " & limit & "s' >&2; exit 1; }; sleep 0.25; done"
end waitFor

on pace(duration)
	sleepFor(duration * delayScale)
end pace

-- Timers of this background process are coalesced, so `delay` overshoots by
-- up to ~100 ms; spin for the rest.
on sleepFor(duration)
	if duration ≤ 0 then return
	set target to (current application's NSDate's timeIntervalSinceReferenceDate()) + duration
	if duration > 0.25 then delay (duration - 0.2)
	repeat while (current application's NSDate's timeIntervalSinceReferenceDate()) < target
	end repeat
end sleepFor
