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

  programArguments = [
    (lib.getExe cfg.package)
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
    PATH = lib.concatStringsSep ":" [
      "${config.home.profileDirectory}/bin"
      (lib.makeBinPath [ pkgs.coreutils ])
      "/usr/local/bin"
      "/opt/homebrew/bin"
      "/usr/bin"
      "/bin"
      "/usr/sbin"
      "/sbin"
    ];
    XDG_CONFIG_HOME = config.xdg.configHome;
    XDG_STATE_HOME = config.xdg.stateHome;
  }
  // lib.optionalAttrs (configuredShell != null) {
    SHELL = toString configuredShell;
  };

  serviceEnvironment = defaultEnvironment // cfg.service.environment;
  environmentList = lib.mapAttrsToList (name: value: "${name}=${value}") serviceEnvironment;

  configFile = settingsFormat.generate "btmux-config.toml" cfg.settings;
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
        package from an overlay or flake input.
      '';
    };

    settings = lib.mkOption {
      inherit (settingsFormat) type;
      default = { };
      example = lib.literalExpression ''
        {
          prefix = "C-a";
          vi-mode = true;
          terminal = {
            font-family = "JetBrains Mono";
            font-size = 16;
          };
        }
      '';
      description = ''
        btmux's `config.toml`, represented as a Nix attribute set. The
        attribute names and values use btmux's TOML schema; for example,
        `vi-mode` and `font-size` retain their kebab-case names. An empty set
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
        assertion = cfg.package != null;
        message = "programs.btmux.package must be set because this nixpkgs does not provide a btmux package";
      }
      {
        assertion = !cfg.service.enable || isLinux || isDarwin;
        message = "programs.btmux.service is supported only on Linux and Darwin";
      }
    ];

    home.packages = lib.optional (cfg.package != null) cfg.package;

    xdg.configFile."btmux/config.toml" = {
      source = configFile;
    };

    systemd.user.services.btmux = lib.mkIf (cfg.service.enable && isLinux) {
      Unit = {
        Description = "btmux — browser-based terminal manager";
        After = [ "network.target" ];
      };

      Service = {
        ExecStart = lib.escapeShellArgs programArguments;
        Environment = environmentList;
        Restart = "on-failure";
      };

      Install.WantedBy = [ "default.target" ];
    };

    launchd.agents.btmux = lib.mkIf (cfg.service.enable && isDarwin) {
      enable = true;
      config = {
        ProgramArguments = programArguments;
        EnvironmentVariables = serviceEnvironment;
        KeepAlive = {
          Crashed = true;
          SuccessfulExit = false;
        };
        ProcessType = "Background";
        RunAtLoad = true;
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/btmux.error.log";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/btmux.log";
      };
    };
  };
}
