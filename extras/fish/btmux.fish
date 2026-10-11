# Installed by `btmux install-fish-theme`: use the btmux theme in btmux panes.
if status is-interactive; and set -q BTMUX_PANE_ID
    fish_config theme choose btmux
end
