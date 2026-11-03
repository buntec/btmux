# Browser

`<prefix> + b` toggles a browser over the active pane, and from another pane
moves it there. The other panes stay visible. Pressing Esc twice quickly also
hides it; on touch screens, the key bar has a button for that.

It runs a headless Chrome or Chromium on the server, found on the server's
`PATH` or in `/Applications`, so it shows any site, and `localhost` means the
server. There is one browser with one page per btmux server, so every client
sees the same page, and links that would open a new tab open in that page.
JavaScript dialogs are answered automatically.

Requires macOS or Linux, and Chrome or Chromium installed on the server.

Its profile, with your logins, is kept apart from your everyday browser's. It
reopens your last page after a restart.

## Ads and autoplay

It blocks known ad servers (by host name, so not ads a site serves itself, and
the empty space they leave stays) and keeps video and audio from playing until
you click or press a key. Either can be turned off; changing them restarts the
browser and reopens your page:

```toml
[browser]
block-ads = false
block-autoplay = false
```

## Copying

To copy, select text and press Cmd+C (Ctrl+C elsewhere); a page's own copy
buttons don't reach your clipboard yet.

## Address bar

Text in its address bar that isn't a URL is searched with DuckDuckGo, or with
`search-url`, where `%s` is the text:

```toml
[browser]
search-url = "https://www.google.com/search?q=%s"
```
