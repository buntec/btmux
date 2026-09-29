# btmux desktop

`just desktop-dev` builds the frontend and server, then opens the Tauri app. `just desktop-build` creates a bundle under `desktop/src-tauri/target/release/bundle/` (`macos/btmux.app` on macOS). To create a macOS disk image as well, run `cd desktop && bun run build -- --bundles dmg` after building the sidecar.

The desktop app starts its bundled btmux server on an available loopback port with the `desktop` profile. It creates a fresh access token for each launch and installs it as an HTTP-only cookie in its webview before opening the server UI. The browser version and its default profile remain available separately. Closing the desktop app stops its server, which saves the session tree; running shells are not restored on the next launch.

On macOS, the window is transparent with a theme-colored tint. Set `desktop-background-opacity = 0.8` in `config.toml` to adjust the tint from clear (`0`) to opaque (`1`); changes reload live. The Linux window remains opaque. macOS transparency requires Tauri's `macos-private-api` feature, so this build cannot be distributed through the Mac App Store.

Each target architecture needs its own bundled `btmux` binary. On macOS, sign and notarize the bundle before distributing it to other users.

`app-icon.svg` is the desktop icon source. After editing it, run `cd desktop && bunx tauri icon app-icon.svg` to regenerate the bundled icons.

Release CI uploads a zipped macOS app and Linux `.deb` packages alongside the server binaries. The macOS CI app uses an ad-hoc signature; users may need to allow it in Privacy & Security until a Developer ID signature and notarization are configured.
