# btmux desktop

`just desktop-dev` builds the frontend and server, then opens the Tauri app. `just desktop-build` creates a bundle under `desktop/src-tauri/target/release/bundle/` (`macos/btmux.app` on macOS). To create a macOS disk image as well, run `cd desktop && bun run build -- --bundles dmg` after building the sidecar.

On every startup, the desktop app looks for running local btmux servers and offers to connect to one. Connecting reuses that server's sessions, shells, and scrollback, including sessions opened in a browser. Closing the desktop app leaves the connected server running, so its PTY sessions survive desktop app restarts as long as that server stays running. If the connected server stops responding for several seconds, the app returns to the picker. On macOS, **File → Switch Server…** (⇧⌘O) also returns to it.

If no server is found, the app starts its bundled server on an available loopback port with the `desktop` profile. The picker also offers **Start desktop server** and **Refresh**. This private server still stops when the desktop app quits: its session tree is saved, but running shells are not restored on the next launch. It does not publish a registration, so only the app that started it lists it. For persistent sessions, start `btmux --no-browser` separately or install its service, then choose it in the desktop app.

Standalone servers publish an owner-only `state.server` registration beside their profile's `state.json` in `$XDG_STATE_HOME/btmux` (or `~/.local/state/btmux`). The registration contains the local endpoint and access credential, including credentials supplied through `BTMUX_AUTH_TOKEN`, and is removed on normal shutdown. The app checks each candidate through the authenticated API and ignores stale or inaccessible registrations. Wildcard listeners are reached through loopback; listeners bound only to a non-loopback address are not discovered. Desktop and server launches must share the same state directory. Older servers (v0.0.106 or later) using the default profile and port 8004 can also be found through their owner-only `state.token`; restart older custom-port or named-profile servers with the updated binary to register them.

Credentials stay in Rust and are installed as HTTP-only cookies before opening the server UI. They are never passed to the picker or placed in URLs. Connecting to an existing server never starts or takes ownership of that server.

`just desktop-check` compiles the launcher and its bundled server. `cargo test --manifest-path desktop/src-tauri/Cargo.toml` checks registration privacy and authenticated discovery. `just test-desktop-launcher` exercises the startup picker with Playwright, including connection choices, refresh, and startup failures, without starting a server.

The desktop app and a server it connects to can be different versions. When they differ, the app shows a warning toast on connect, and **About btmux** lists the app version beside the server version and repeats the warning.

While the window is hidden, attention and error notifications from connected loopback servers appear as OS notifications. Clicking one focuses the app and its pane.

On macOS, the window is transparent with a theme-colored tint, defaulting to 95% opacity. Set `desktop-background-opacity = 0.95` in `config.toml` to adjust the tint from clear (`0`) to opaque (`1`); changes reload live. The Linux window remains opaque. macOS transparency requires Tauri's `macos-private-api` feature, so this build cannot be distributed through the Mac App Store.

Each target architecture needs its own bundled `btmux` binary. On macOS, sign and notarize the bundle before distributing it to other users.

`app-icon.svg` is the desktop icon source. After editing it, run `cd desktop && bunx tauri icon app-icon.svg` to regenerate the bundled icons.

Release CI uploads a zipped macOS app and Linux `.deb` packages alongside the server binaries. The macOS CI app uses an ad-hoc signature; users may need to allow it in Privacy & Security until a Developer ID signature and notarization are configured.
