# Installed by `btmux install-fish-integration` or the Home Manager module.
if status is-interactive; and set -q BTMUX_PANE_ID
    fish_config theme choose btmux

    function __btmux_pick
        set -l bin btmux
        set -q BTMUX_BIN; and set bin $BTMUX_BIN
        $bin pick $argv 2>/dev/null
    end

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
        set -l choice (string join \n -- $candidates | __btmux_pick)
        switch $status
            case 0
                commandline -rt -- (string replace -a ' ' '\\ ' -- $choice)
            case 130
            case '*'
                commandline -f complete
        end
        commandline -f repaint
    end

    # Ctrl-R through `btmux pick`, over commands containing the line, as fish's pager.
    function __btmux_history
        # Vi's normal mode is also named default, and redoes with Ctrl-R.
        if test "$fish_bind_mode" = default; and string match -q '*_vi_*' -- $fish_key_bindings
            commandline -f redo
            return
        end
        if commandline --paging-mode
            commandline -f history-pager
            return
        end
        # An empty line passes no query, as searching for "" is an error.
        set -l entries (history search --null --contains -- (commandline | string collect) | string split0)
        if not set -q entries[1]
            commandline -f history-pager
            return
        end
        # Items are lines, and a tab would start a description.
        set -l choice (string replace -a \n ␤ -- $entries | string replace -a \t ␉ | __btmux_pick --prompt History)
        switch $status
            case 0
                commandline -r -- (string replace -a ␤ \n -- $choice | string replace -a ␉ \t | string collect)
            case 130
            case '*'
                commandline -f history-pager
        end
        commandline -f repaint
    end

    # cdh through `btmux pick`, falling back to fish's with an argument, nothing to
    # choose, or no tab to show the menu.
    function __btmux_cdh
        set -l dirs
        set -l visited $dirprev $dirnext
        for dir in $visited[-1..1]
            test "$dir" != "$PWD"; and not contains -- $dir $dirs; and set -a dirs $dir
        end
        if set -q argv[1]; or not set -q dirs[1]
            __btmux_fish_cdh $argv
            return
        end
        set -l choice (string join \n -- $dirs | __btmux_pick --prompt Directory)
        switch $status
            case 0
                cd $choice
            case 130
            case '*'
                __btmux_fish_cdh
        end
    end

    # At the first prompt, since conf.d runs before config.fish.
    function __btmux_pick_menus --on-event fish_prompt
        functions -e __btmux_pick_menus
        if test "$btmux_pick_menus" = 1
            bind tab __btmux_complete
            bind -M insert tab __btmux_complete
            bind ctrl-r __btmux_history
            bind -M insert ctrl-r __btmux_history
            functions --copy cdh __btmux_fish_cdh
            function cdh --description 'Menu based cd command'
                __btmux_cdh $argv
            end
        end
    end
end
