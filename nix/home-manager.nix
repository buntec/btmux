{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.btmux;
  isLinux = pkgs.stdenv.hostPlatform.isLinux;
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
  supportedPackageSystems = [
    "aarch64-darwin"
    "aarch64-linux"
    "x86_64-linux"
  ];

  settingsFormat = pkgs.formats.toml { };

  programArguments =
    exe:
    [
      exe
    ]
    ++ lib.optional (!cfg.service.openBrowser) "--no-browser"
    ++ [
      "--host"
      cfg.service.host
      "--port"
      (toString cfg.service.port)
    ]
    ++ lib.optional (cfg.service.profile != null) "--profile"
    ++ lib.optional (cfg.service.profile != null) cfg.service.profile
    ++ lib.optional (cfg.service.shell != null) "--shell"
    ++ lib.optional (cfg.service.shell != null) (toString cfg.service.shell)
    ++ cfg.service.extraArgs;

  configuredShell = config.home.sessionVariables.SHELL or null;

  defaultEnvironment = {
    HOME = config.home.homeDirectory;
    # Panes inherit this PATH, so include the usual Nix profiles.
    PATH = lib.concatStringsSep ":" (
      lib.optional isLinux "/run/wrappers/bin"
      ++ [
        "${config.home.profileDirectory}/bin"
        "/etc/profiles/per-user/${config.home.username}/bin"
        "/run/current-system/sw/bin"
        "/nix/var/nix/profiles/default/bin"
        (lib.makeBinPath [ pkgs.coreutils ])
        "/usr/local/bin"
        "/opt/homebrew/bin"
        "/usr/bin"
        "/bin"
        "/usr/sbin"
        "/sbin"
      ]
    );
    XDG_CONFIG_HOME = config.xdg.configHome;
    XDG_STATE_HOME = config.xdg.stateHome;
  }
  // lib.optionalAttrs (configuredShell != null) {
    SHELL = toString configuredShell;
  };

  serviceEnvironment = defaultEnvironment // cfg.service.environment;
  environmentList = lib.mapAttrsToList (name: value: "${name}=${value}") serviceEnvironment;

  configFile = settingsFormat.generate "btmux-config.toml" cfg.settings;

  # Everything an in-place upgrade can't change, since it keeps the running
  # server's arguments and environment.
  serviceDefinition = builtins.hashString "sha256" (
    builtins.toJSON {
      arguments = programArguments "btmux";
      environment = serviceEnvironment;
    }
  );

  restartService =
    if isDarwin then
      ''run /bin/launchctl kickstart -k "gui/$UID/com.btmux.server" || warnEcho "Failed to restart btmux"''
    else
      ''run systemctl --user try-restart btmux.service || warnEcho "Failed to restart btmux"'';

  # Home Manager already reloads a changed launchd agent.
  restartOnDefinitionChange = if isDarwin then ":" else restartService;

  completionPackage = pkgs.runCommand "btmux-shell-completions" { } ''
    mkdir -p "$out/share/bash-completion/completions" \
      "$out/share/fish/vendor_completions.d" \
      "$out/share/zsh/site-functions"

    if ${lib.getExe cfg.package} completions bash > "$out/share/bash-completion/completions/btmux" 2>/dev/null; then
      ${lib.getExe cfg.package} completions fish > "$out/share/fish/vendor_completions.d/btmux.fish"
      ${lib.getExe cfg.package} completions zsh > "$out/share/zsh/site-functions/_btmux"
    else
      rm "$out/share/bash-completion/completions/btmux"
    fi
  '';
in
{
  # btmux is both a program and a long-running server. Keep the service-shaped
  # spelling available for users who discover it through Home Manager's service
  # modules, while documenting programs.btmux as the canonical interface.
  imports = [
    (lib.mkAliasOptionModule [ "services" "btmux" ] [ "programs" "btmux" ])
  ];

  options.programs.btmux = {
    enable = lib.mkEnableOption "btmux, a browser-based terminal manager";

    package = lib.mkOption {
      type = with lib.types; nullOr package;
      default =
        if builtins.hasAttr "btmux" pkgs then
          pkgs.btmux
        else if builtins.elem pkgs.stdenv.hostPlatform.system supportedPackageSystems then
          pkgs.callPackage ./package.nix { }
        else
          null;
      defaultText = lib.literalExpression "pkgs.btmux or ./nix/package.nix";
      example = lib.literalExpression "inputs.btmux.packages.\${pkgs.system}.default";
      description = ''
        The btmux package to install and run. If the selected nixpkgs already
        provides `btmux`, it is used automatically; otherwise set this to a
        package from an overlay or flake input. Set to `null` to manage btmux
        outside Home Manager; this requires `service.enable = false`.
      '';
    };

    enableFishIntegration = lib.hm.shell.mkFishIntegrationOption { inherit config; } // {
      description = ''
        Whether to install the btmux fish theme and select it in btmux panes,
        as `btmux install-fish-theme` does. Requires `programs.fish.enable`.
      '';
    };

    desktop = {
      enable = lib.mkEnableOption "the btmux desktop app with its bundled server";

      package = lib.mkOption {
        type = with lib.types; nullOr package;
        default =
          if builtins.elem pkgs.stdenv.hostPlatform.system supportedPackageSystems then
            pkgs.callPackage ./desktop-package.nix { }
          else
            null;
        defaultText = lib.literalExpression "pkgs.callPackage ./nix/desktop-package.nix { }";
        example = lib.literalExpression "inputs.btmux.packages.\${pkgs.system}.desktop";
        description = "Desktop app package to install when desktop.enable is set.";
      };
    };

    settings = lib.mkOption {
      inherit (settingsFormat) type;
      default = { };
      example = lib.literalExpression ''
        {
          prefix = "C-b";
          repeat-time = 500;
          terminal = {
            font-family = "JetBrains Mono";
            font-size = 16;
          };
        }
      '';
      description = ''
        btmux's `config.toml`, represented as a Nix attribute set. The
        attribute names and values use btmux's TOML schema; for example,
        `repeat-time` and `font-size` retain their kebab-case names. An empty set
        produces an empty configuration file, allowing btmux's built-in
        defaults to apply.

        See `btmux generate-config` for the complete list of settings.
      '';
    };

    service = {
      enable = lib.mkEnableOption "the btmux background service" // {
        default = true;
      };

      host = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        example = "0.0.0.0";
        description = "Address on which btmux listens.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 8004;
        example = 8080;
        description = "TCP port on which btmux listens.";
      };

      profile = lib.mkOption {
        type = with lib.types; nullOr str;
        default = null;
        example = "work";
        description = ''
          Optional isolated btmux state profile. Profiles are stored below
          `$XDG_STATE_HOME/btmux/`.
        '';
      };

      shell = lib.mkOption {
        type = with lib.types; nullOr (either str path);
        default = null;
        example = lib.literalExpression "\${pkgs.fish}/bin/fish";
        description = ''
          Shell to spawn in new panes. This is passed as btmux's `--shell`
          argument and therefore takes precedence over the `shell` setting in
          `settings`.
        '';
      };

      openBrowser = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Open a browser when the service starts. This is disabled by default
          because Home Manager services commonly start in the background.
        '';
      };

      extraArgs = lib.mkOption {
        type = with lib.types; listOf str;
        default = [ ];
        example = [ "--no-browser" ];
        description = "Additional command-line arguments passed to btmux.";
      };

      environment = lib.mkOption {
        type = with lib.types; attrsOf str;
        default = { };
        example = lib.literalExpression ''
          {
            BTMUX_CONSOLE_LOG = "info";
          }
        '';
        description = ''
          Environment variables for the btmux service. `HOME`, `PATH`,
          `XDG_CONFIG_HOME`, and `XDG_STATE_HOME` are set to values matching
          Home Manager and can be overridden here.
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.desktop.enable || cfg.desktop.package != null;
        message = "programs.btmux.desktop.package must be set on unsupported platforms";
      }
      {
        assertion = !cfg.service.enable || cfg.package != null;
        message = "programs.btmux.package must be set when programs.btmux.service.enable is true";
      }
      {
        assertion = !cfg.service.enable || isLinux || isDarwin;
        message = "programs.btmux.service is supported only on Linux and Darwin";
      }
    ];

    home.packages =
      lib.optionals (cfg.package != null) [
        cfg.package
        (lib.lowPrio completionPackage)
      ]
      ++ lib.optionals (cfg.desktop.enable && cfg.desktop.package != null) [ cfg.desktop.package ];

    xdg.configFile = lib.mkMerge [
      { "btmux/config.toml".source = configFile; }
      (lib.mkIf (cfg.enableFishIntegration && config.programs.fish.enable) {
        "fish/themes/btmux.theme".source = ../extras/fish/btmux.theme;
        "fish/conf.d/btmux.fish".source = ../extras/fish/btmux.fish;
      })
    ];

    systemd.user.services.btmux = lib.mkIf (cfg.service.enable && isLinux) {
      Unit = {
        Description = "btmux — browser-based terminal manager";
        After = [ "network.target" ];
        # Upgrades go through `btmux upgrade` (see below).
        X-SwitchMethod = "keep-old";
      };

      Service = {
        ExecStart = lib.escapeShellArgs (programArguments (lib.getExe cfg.package));
        Environment = environmentList;
        Restart = "on-failure";
      };

      Install.WantedBy = [ "default.target" ];
    };

    launchd.agents.btmux = lib.mkIf (cfg.service.enable && isDarwin) {
      enable = true;
      config = {
        # Same label as `btmux install`, so `btmux restart` and `uninstall` work.
        Label = "com.btmux.server";
        # The profile's btmux, so upgrades leave the plist unchanged: Home
        # Manager would bootout the agent, and when run from a btmux pane the
        # activation dies with it before bootstrapping the new one.
        ProgramArguments = programArguments "${config.home.profileDirectory}/bin/${
          cfg.package.meta.mainProgram or "btmux"
        }";
        EnvironmentVariables = serviceEnvironment;
        KeepAlive = {
          Crashed = true;
          SuccessfulExit = false;
        };
        # Like `btmux install`: shells inherit this, and Background clamps
        # them to background QoS on a few throttled cores.
        ProcessType = "Interactive";
        RunAtLoad = true;
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/btmux.error.log";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/btmux.log";
      };
    };

    # A new package moves the running server in place with `btmux upgrade`,
    # keeping its shells; a changed service definition restarts it. Either
    # survives this activation running in a btmux pane.
    home.activation.upgradeBtmux = lib.mkIf cfg.service.enable (
      lib.hm.dag.entryAfter
        [
          "installPackages"
          "linkGeneration"
          (if isDarwin then "setupLaunchAgents" else "reloadSystemd")
        ]
        ''
          btmuxDir=${lib.escapeShellArg "${serviceEnvironment.XDG_STATE_HOME}/btmux"}
          btmuxPrevPackage=$(cat "$btmuxDir/service-package" 2>/dev/null || true)
          btmuxPrevService=$(cat "$btmuxDir/service-definition" 2>/dev/null || true)
          run mkdir -p "$btmuxDir"
          if [[ ! -v DRY_RUN ]]; then
            echo ${cfg.package} > "$btmuxDir/service-package"
            echo ${serviceDefinition} > "$btmuxDir/service-definition"
          fi
          if [[ -n "$btmuxPrevService" && "$btmuxPrevService" != ${serviceDefinition} ]]; then
            ${restartOnDefinitionChange}
          elif [[ "$btmuxPrevPackage" != ${cfg.package} ${
            # Darwin's first activation (re)loaded the agent itself.
            lib.optionalString isDarwin ''&& -n "$btmuxPrevPackage"''
          } ]]; then
            btmuxUpgrade=0
            run env XDG_STATE_HOME=${lib.escapeShellArg serviceEnvironment.XDG_STATE_HOME} ${lib.getExe cfg.package} ${
              lib.escapeShellArgs (
                lib.optionals (cfg.service.profile != null) [
                  "--profile"
                  cfg.service.profile
                ]
                ++ [ "upgrade" ]
              )
            } || btmuxUpgrade=$?
            if [[ $btmuxUpgrade == 3 ]]; then
              # Still running, shells intact (e.g. unsaved Neovim buffers).
              warnEcho "btmux keeps running the old version; run 'btmux upgrade' to retry"
            elif [[ $btmuxUpgrade != 0 ]]; then
              warnEcho "In-place btmux upgrade failed; restarting it"
              ${restartService}
            fi
          fi
        ''
    );
  };
}
