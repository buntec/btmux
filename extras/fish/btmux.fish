# Installed by `btmux install-fish-integration` or the Home Manager module.
if status is-interactive; and set -q BTMUX_PANE_ID
    fish_config theme choose btmux

    # Tab through `btmux pick`. fish completes on its own when its menu is open,
    # with at most one candidate, whose quoting and trailing space only it knows,
    # and when there's no tab to show the menu.
    function __btmux_complete
        if commandline --paging-mode
            commandline -f complete
            return
        end
        set -l candidates (complete -C (commandline -cp | string collect --allow-empty))
        if test (count $candidates) -lt 2
            commandline -f complete
            return
        end
        set -l bin btmux
        set -q BTMUX_BIN; and set bin $BTMUX_BIN
        set -l choice (string join \n -- $candidates | $bin pick 2>/dev/null)
        switch $status
            case 0
                commandline -rt -- (string replace -a ' ' '\\ ' -- $choice)
            case 130
            case '*'
                commandline -f complete
        end
        commandline -f repaint
    end

    # At the first prompt, since conf.d runs before config.fish.
    function __btmux_bind_tab --on-event fish_prompt
        functions -e __btmux_bind_tab
        if test "$btmux_pick_completion" = 1
            bind tab __btmux_complete
            bind -M insert tab __btmux_complete
        end
    end
end
