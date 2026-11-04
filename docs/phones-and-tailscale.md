# Phones, tablets, and Tailscale

## Tailscale

To reach btmux from other devices on your
[tailnet](https://tailscale.com), including phones, start it with
`--tailscale`:

```sh
btmux --tailscale                        # https://<machine>.<tailnet>.ts.net:8004
btmux --tailscale install                # the same, as a background service
```

btmux runs `tailscale serve --bg --https=<port>`, which serves the machine's
tailnet name over HTTPS with a Tailscale certificate and proxies to btmux on
loopback, and prints the URL. btmux itself stays on `127.0.0.1`. It never
replaces another route on that port: if one exists, btmux serves locally and
reports it: remove that route or choose another `--port`. A route that already points at btmux is
used as is. Shutting down removes only a route btmux created (recorded in
`state.tailscale` beside the profile's state); an upgrade keeps it. If Tailscale
isn't running yet, btmux keeps serving locally and retries every 10 seconds.
Once serving, it checks the route every 30 seconds and sets it up again if
it's gone, for example after Tailscale restarts.
The status bar's tailnet button shows the URL, with a copy button, or the
last error.

While its popover is open, it also shows a QR code of a sign-in link for that
URL. Scanning it on a phone or tablet signs that browser in without the access
token. Each code works once and expires after two minutes; the popover renews
it while open. The token never appears in the link.

This needs the `tailscale` CLI (on macOS, the app's bundled CLI also works),
[MagicDNS](https://tailscale.com/kb/1081/magicdns), and
[HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) enabled for
the tailnet. Sign in with the [access token](installation.md#first-sign-in); browsers keep the login for
400 days. HTTPS matters even though the tailnet is encrypted: browsers allow
the clipboard, notifications, and WebGPU shader wallpapers only on secure
origins.

In the desktop app, a desktop server kept running after the app quits can
also be shared this way: check **Share it on my tailnet** before starting it.
It then keeps its port across starts, so its tailnet URL stays the same.
The app can also [connect to btmux servers on other machines](../desktop/README.md).

## Phones and tablets

On touch devices, a key bar above the status bar supplies the keys on-screen
keyboards lack: Esc, Tab, arrows, the prefix, and Ctrl and Alt, which apply to
the next key typed or tapped. It also opens the command palette, cycles panes,
and hides the keyboard. Swipes scroll full-screen programs such as `less` the
way a mouse wheel does. On narrow screens, a window with several panes shows
only the active one, and the file browser fills the screen, showing its list or,
after a tap, the preview; its key hints can be tapped. Add btmux to the home screen to run it without browser
chrome; it needs HTTPS, so serve it with `--tailscale` or through a reverse proxy.
