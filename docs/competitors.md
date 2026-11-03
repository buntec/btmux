# Comparison with other projects

Data collected on November 2, 2026.

**GUI** = desktop/mobile app with an integrated terminal emulator;
**browser** = terminal emulator in a web page; **TUI** = client running inside
another terminal emulator. An automation CLI alone does not count as a TUI client.

**—** = not included; **?** = not established by the linked documentation.
Named clients and integrations may require extra installation or setup.

## Access and sessions

| Project                                  | App type      | Browser client                                     | Phone/tablet access                                                    | Detached live sessions[^detached]                      | Multiple clients on the same live session | Native Windows app/server |
| ---------------------------------------- | ------------- | -------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- | ------------------------- |
| **btmux**                                | GUI + browser | Yes                                                | Browser                                                                | Yes                                                    | Yes                                       | Experimental              |
| [herdr TUI][herdr]                       | TUI           | —                                                  | SSH client                                                             | Yes                                                    | Yes                                       | Yes                       |
| [herdr app][herdr-app][^herdr-app]       | GUI           | —                                                  | SSH via `hc`                                                           | Yes                                                    | Yes                                       | Yes                       |
| [cmux][cmux][^cmux]                      | GUI + TUI     | —                                                  | iOS beta                                                               | TUI server                                             | TUI daemon                                | TUI                       |
| [Muxy][muxy]                             | GUI + TUI     | —                                                  | iOS / Android                                                          | Yes                                                    | Yes                                       | —                         |
| [Paradev (formerly Superset)][paradev]   | GUI           | ?                                                  | [iOS / iPadOS (Pro)](https://docs.paradev.com/install#iphone-and-ipad) | Yes                                                    | ?                                         | —                         |
| [TUIOS][tuios]                           | Browser + TUI | [Separate `tuios-web`](https://tuios.dev/docs/web) | Browser                                                                | Yes                                                    | Yes                                       | Yes                       |
| [Emdash][emdash]                         | GUI           | —                                                  | —                                                                      | [Remote daemon][emdash-daemon]                         | Remote daemon                             | Yes                       |
| [herdr-gpui][herdr-gpui][^herdr-clients] | GUI           | —                                                  | —                                                                      | Via Herdr                                              | Yes                                       | Yes                       |
| [Ovis][ovis][^herdr-clients]             | GUI + browser | Yes                                                | Browser / iOS beta                                                     | Via Herdr                                              | Yes                                       | —                         |
| [Rune][rune]                             | GUI           | —                                                  | —                                                                      | ?                                                      | ?                                         | —                         |
| [tty7][tty7]                             | GUI           | —                                                  | —                                                                      | Yes                                                    | ?                                         | Yes                       |
| [Wave][wave]                             | GUI           | —                                                  | —                                                                      | [SSH only](https://docs.waveterm.dev/durable-sessions) | —                                         | Yes                       |
| [Warp][warp]                             | GUI           | Agent sessions[^warp-sharing]                      | Browser[^warp-sharing]                                                 | —                                                      | Agent sessions[^warp-sharing]             | Yes                       |

## Development tools and automation

| Project                  | Agent status                                                               | Git integration                                        | Graphical code editor                                                                                        | Embedded web browser                  | Terminal automation                                                                                                | License                                                                                     |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **btmux**                | [Detection / hooks](automation.md#semantic-agent-status)                   | GUI, worktrees                                         | [Neovim / VS Code](../README.md#editor)[^editors]                                                            | [macOS / Linux](browser.md)[^browser] | [CLI, REST, MCP](automation.md)                                                                                    | [MIT](../LICENSE)                                                                           |
| [herdr TUI][herdr]       | Detection / hooks                                                          | Worktree tracking                                      | —                                                                                                            | —                                     | [CLI, socket API](https://herdr.dev/tui/docs/socket-api/)                                                          | [Apache-2.0](https://github.com/herdrdev/herdr/blob/master/LICENSE)                         |
| [herdr app][herdr-app]   | OSC 7501[^herdr-app]                                                       | Worktrees, repo status                                 | Mod API only[^herdr-app]                                                                                     | —                                     | [CLI, core API](https://herdr.dev/core/)                                                                           | [Apache-2.0](https://github.com/herdrdev/herdr-app/blob/master/LICENSE)                     |
| [cmux][cmux]             | [Agent hooks](https://cmux.com/docs/notifications)                         | Branch/PR metadata                                     | [Text editor (macOS)](https://cmux.com/docs/changelog/0.64.23)                                               | Yes                                   | [CLI, socket API](https://cmux.com/docs/api)                                                                       | [GPL-3.0-or-later / BUSL-1.1](https://github.com/manaflow-ai/cmux/blob/main/LICENSE)[^cmux] |
| [Muxy][muxy]             | [Agent detection](https://muxy.app/docs/2.x/features/ai-agents)            | GUI, worktrees                                         | [Files extension](https://muxy.app/store/files)                                                              | Yes                                   | [CLI, socket API](https://muxy.app/docs/2.x/features/muxy-cli)                                                     | [MIT](https://github.com/muxy-app/muxy/blob/main/LICENSE)                                   |
| [Paradev][paradev]       | [Agent integration](https://docs.paradev.com/agent-integration)            | GUI, worktrees                                         | [Built in](https://docs.paradev.com/editor)                                                                  | Yes                                   | [CLI, API, MCP](https://docs.paradev.com/mcp-server)                                                               | [ELv2](https://github.com/ParadevAI/Paradev/blob/main/LICENSE.md)                           |
| [TUIOS][tuios]           | [Hooks / OSC 7501](https://tuios.dev/docs/agents)                          | [Worktrees](https://tuios.dev/docs/worktrees)          | —                                                                                                            | —                                     | [CLI, JSON protocol](https://tuios.dev/docs/control-protocol)                                                      | [MIT](https://github.com/Gaurav-Gosain/tuios/blob/main/LICENSE)                             |
| [Emdash][emdash]         | Agent lifecycle hooks                                                      | GUI, worktrees                                         | Built in                                                                                                     | Yes                                   | [Workspace API](https://github.com/generalaction/emdash/blob/main/apps/workspace-server/docs/client-connection.md) | [Apache-2.0](https://github.com/generalaction/emdash/blob/main/LICENSE.md)                  |
| [herdr-gpui][herdr-gpui] | Herdr backend                                                              | GUI, worktrees                                         | [VS Code](https://github.com/penso/herdr-gpui/blob/main/crates/herdr-gpui/README.md#vs-code)[^herdr-clients] | macOS / Windows                       | CLI, Herdr API                                                                                                     | [Apache-2.0](https://github.com/penso/herdr-gpui/blob/main/LICENSE)                         |
| [Ovis][ovis]             | Herdr backend                                                              | Read-only diffs                                        | Preview only                                                                                                 | —                                     | Herdr API                                                                                                          | [MIT](https://github.com/devswha/ovis/blob/main/LICENSE)                                    |
| [Rune][rune]             | [OSC 7501](https://docs.rune.build/learn/terminal/program-status/)         | Worktrees, diffs                                       | Built in                                                                                                     | ?                                     | `runectl` CLI                                                                                                      | [GPL-3.0](https://github.com/unstablebuild/rune/blob/main/LICENSE)                          |
| [tty7][tty7]             | Agent detection / status                                                   | Diffs, worktrees                                       | ?                                                                                                            | ?                                     | CLI                                                                                                                | [Apache-2.0](https://github.com/l0ng-ai/tty7/blob/main/LICENSE)                             |
| [Wave][wave]             | [Claude Code hooks](https://docs.waveterm.dev/claude-code)[^wave-status]   | —                                                      | Built in                                                                                                     | Yes                                   | [`wsh` CLI](https://docs.waveterm.dev/wsh)                                                                         | [Apache-2.0](https://github.com/wavetermdev/waveterm/blob/main/LICENSE)                     |
| [Warp][warp]             | [CLI agent integration](https://docs.warp.dev/agents/cli-agents/overview/) | [Code review](https://docs.warp.dev/code/code-review/) | Built in                                                                                                     | ?                                     | [`warpctrl` CLI](https://docs.warp.dev/changelog/2026/)                                                            | [AGPL-3.0 / MIT](https://github.com/warpdotdev/warp#licensing)                              |

[^detached]:
    Running shells and programs survive the client disconnecting or exiting
    while their server stays running. Restoring layouts, scrollback, or an
    agent conversation after a restart is a separate feature.

[^herdr-app]:
    herdr-app uses herdr-core, separate from herdr TUI's server. Agent status
    requires programs to report OSC 7501. Its mod API exposes editor widgets;
    the published [Code layout](https://herdr.dev/layouts/herdrdev/code/) is a
    read-only example.

[^cmux]:
    cmux has a macOS app and a separate [cross-platform TUI](https://cmux.com/docs/tui).
    Detached sessions, multiple clients, and native Windows support here refer
    to the TUI and its [daemon](https://github.com/manaflow-ai/cmux/blob/main/cmux-tui/docs/remote.md).
    Apps and the TUI use GPL-3.0-or-later; the server components listed in cmux's
    license use BUSL-1.1.

[^herdr-clients]:
    herdr-gpui and Ovis are separate clients of Herdr backends. herdr-gpui also
    supports herdr-core terminals. Its VS Code tab embeds a separate VS Code
    server; its embedded web views are available on macOS and Windows.
    [Ovis's guide](https://github.com/devswha/ovis/blob/main/docs/guide.md)
    describes its shared terminal views and pane splitting.

[^editors]:
    btmux renders a Neovim GUI or embeds VS Code; the corresponding editor must
    be installed separately. Terminal editors can run in every project listed.

[^browser]:
    btmux shows a Chrome or Chromium running headless on its server, so the page
    works in every client and `localhost` means the server. The browser must be
    installed separately.

[^wave-status]:
    Wave's official Claude Code integration uses `wsh badge` and configured
    lifecycle hooks to show permission requests, questions, and completed turns.

[^warp-sharing]:
    Warp's [agent session sharing](https://docs.warp.dev/agents/local-agents/session-sharing/)
    and [Remote Control](https://docs.warp.dev/agents/cli-agents/remote-control)
    let browser and mobile clients view and steer agent sessions through Warp's
    cloud service. The desktop app must remain running for local execution.

[herdr]: https://github.com/herdrdev/herdr
[herdr-app]: https://github.com/herdrdev/herdr-app
[cmux]: https://github.com/manaflow-ai/cmux
[muxy]: https://github.com/muxy-app/muxy
[paradev]: https://github.com/ParadevAI/Paradev
[tuios]: https://github.com/Gaurav-Gosain/tuios
[emdash]: https://github.com/generalaction/emdash
[emdash-daemon]: https://github.com/generalaction/emdash/blob/main/apps/workspace-server/docs/daemon.md
[herdr-gpui]: https://github.com/penso/herdr-gpui
[ovis]: https://github.com/devswha/ovis
[rune]: https://github.com/unstablebuild/rune
[tty7]: https://github.com/l0ng-ai/tty7
[wave]: https://github.com/wavetermdev/waveterm
[warp]: https://github.com/warpdotdev/warp
