-- Drives the btmux desktop app for scripts/record-desktop-demo.sh.
--
--   osascript desktop-demo.applescript connect
--   osascript desktop-demo.applescript line <text>
--   osascript desktop-demo.applescript park
--   osascript desktop-demo.applescript play <prefix> [delay scale] [lsp ready file]
--
-- `connect` expects the demo server to be the picker's only, focused entry,
-- fills the primary screen's visible area, and prints the window bounds as
-- x,y,w,h. `park` moves the mouse onto the menu bar, out of the recording.
-- `play` multiplies its pauses, typing, and mouse movement by the delay scale
-- (default 1), and waits for the ready file before using rust-analyzer.
-- Every keystroke first checks that btmux is frontmost, so typing never lands
-- in another app.

use AppleScript version "2.4"
use framework "AppKit"
use scripting additions

property bundleId : "com.btmux.desktop"
property mouseScript : ""
property delayScale : 1
property lspReady : ""

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
		if (count of argv) > 2 then
			-- NSString parsing ignores the locale's decimal separator.
			set delayScale to (current application's NSString's stringWithString:(item 3 of argv))'s doubleValue()
		end if
		if (count of argv) > 3 then set lspReady to item 4 of argv
		play(item 2 of argv)
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

on play(prefixSpec)
	-- Splits
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
	chord(prefixSpec, "z")
	pace(1.2)
	chord(prefixSpec, "z")
	pace(1)

	-- File browser: README.md is second to last, then scroll its preview and
	-- walk up through more files.
	chord(prefixSpec, "f")
	pace(1.5)
	press("G")
	pace(1)
	press("k")
	pace(2)
	repeat 3 times
		ctrl("d")
		pace(0.7)
	end repeat
	pace(0.5)
	repeat 2 times
		ctrl("u")
		pace(0.7)
	end repeat
	pace(0.8)
	repeat 5 times
		press("k")
		pace(1)
	end repeat
	pace(1)
	escape()
	pace(0.8)

	-- Git UI (the first Escape leaves Git mode, the second closes)
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

	-- Built-in Neovim: open a Rust source, wait for rust-analyzer, then
	-- retype a line with completion, docs, and signature help.
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
	waitForLsp()
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
	pace(1.2)

	-- Session picker: unfold both sessions
	chord(prefixSpec, "s")
	pace(1.2)
	press("l")
	pace(1.2)
	repeat 2 times
		press("j")
		pace(0.6)
	end repeat
	press("l")
	pace(1.5)
	escape()
	pace(0.8)

	-- Settings, through the command palette
	chord(prefixSpec, ":")
	pace(0.8)
	typeSlowly("set")
	pace(0.8)
	enter()
	pace(1.5)
	-- The app's webview tabs through every control (wry enables
	-- tabFocusesLinks): the title is focused first, then Close, then the
	-- selected tab. Arrows move between tabs and Enter opens one. The Tab
	-- counts below match the Wallpaper tab's controls with Ink Flow selected.
	tabs(2)
	pace(0.5)
	repeat 6 times
		keyCode(124) -- right
		pace(0.2)
		enter()
		pace(0.7)
	end repeat
	repeat 2 times
		keyCode(123) -- left, back to Wallpaper
		pace(0.2)
	end repeat
	enter()
	pace(1)
	tabs(1) -- the procedural shader selector
	pace(0.5)
	enter()
	pace(0.8)
	typeSlowly("ink")
	pace(0.8)
	enter()
	pace(1.5)
	tabs(2) -- wallpaper opacity, raised from 0.1 to 0.25
	pace(0.5)
	keyCode(116) -- page up, +0.1
	pace(0.4)
	repeat 5 times
		keyCode(124) -- right, +0.01
		pace(0.15)
	end repeat
	pace(0.8)
	tabs(26) -- Apply
	pace(0.5)
	enter()
	pace(1.5)
	set {cx, cy, cw, ch} to contentBounds()
	mouse("swirl " & int(cx + cw / 2) & " " & int(cy + ch / 2) & " " & int(cw * 0.3) & " " & int(ch * 0.3) & " " & int(8000 * delayScale))
	pace(0.5)
	park()
	pace(1)

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
	pace(1)

	-- End on the About dialog
	chord(prefixSpec, ":")
	pace(0.8)
	typeSlowly("about")
	pace(0.8)
	enter()
	pace(3)
end play

-- The primary screen's area outside the menu bar and Dock, in the top-left
-- origin coordinates System Events uses.
on visibleBounds()
	set primary to current application's NSScreen's screens()'s firstObject()
	set {{sx, sy}, {sw, sh}} to primary's frame()
	set {{vx, vy}, {vw, vh}} to primary's visibleFrame()
	return {vx as integer, (sh - vy - vh) as integer, vw as integer, vh as integer}
end visibleBounds

-- The window's web content area, falling back to a standard title bar.
on contentBounds()
	tell application "System Events"
		tell (first process whose bundle identifier is bundleId)
			set {wx, wy} to position of window 1
			set {ww, wh} to size of window 1
			set best to {wx, wy + 28, ww, wh - 28}
			set bestArea to 0
			repeat with el in UI elements of window 1
				try
					if role of el is not "AXButton" then
						set {ex, ey} to position of el
						set {ew, eh} to size of el
						if ew * eh > bestArea then
							set bestArea to ew * eh
							set best to {ex, ey, ew, eh}
						end if
					end if
				end try
			end repeat
		end tell
	end tell
	return best
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

on ensureFront()
	tell application "System Events"
		if not (frontmost of (first process whose bundle identifier is bundleId)) then
			error "btmux is no longer frontmost; stopping so keystrokes go nowhere else" number 1001
		end if
	end tell
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
	delay 0.15
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
		delay 0.05
	end repeat
end tabs

on ctrl(k)
	ensureFront()
	tell application "System Events" to keystroke k using control down
end ctrl

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
		if pause > 0 then delay pause
	end repeat
end typeText

on typeSlowly(s)
	typeText(s, 0.06 * delayScale)
end typeSlowly

-- Unscaled: rust-analyzer loads at its own pace.
on waitForLsp()
	if lspReady is "" then return
	do shell script "for i in $(seq 240); do [ -e " & quoted form of lspReady & " ] && exit 0; sleep 0.25; done; echo 'rust-analyzer did not load within 60s' >&2; exit 1"
end waitForLsp

on pace(duration)
	delay duration * delayScale
end pace
