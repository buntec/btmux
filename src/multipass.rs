//! Sandboxed sessions: shells in one shared Multipass instance, with host
//! directories mounted at the same paths so cwds mean the same on both sides.
//! A pane runs `btmux guest-shell`, which creates, starts, and sets up the
//! instance, printing progress in the pane, then execs `multipass exec`.
//! Guests reach the server through a listener on the bridge address, with a
//! token scoped to guest panes (`auth::guest_route`).

use std::{
    collections::HashSet,
    net::IpAddr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
};

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

use crate::config::MultipassConfig;

/// Where the guest's btmux lives, for hooks and `btmux` commands.
pub const GUEST_BIN: &str = "/usr/local/bin/btmux";

#[derive(
    Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, Hash, clap::ValueEnum,
)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum GuestShell {
    #[default]
    Bash,
    Zsh,
    Fish,
}

impl GuestShell {
    /// The guest shell named like the shell `program`.
    pub fn of(program: &str) -> Option<Self> {
        let argv = crate::shell::argv(program);
        let name = Path::new(argv.first()?).file_name()?.to_str()?;
        match name.trim_end_matches(".exe") {
            "bash" => Some(Self::Bash),
            "zsh" => Some(Self::Zsh),
            "fish" => Some(Self::Fish),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Zsh => "zsh",
            Self::Fish => "fish",
        }
    }
}

pub fn program() -> Option<PathBuf> {
    crate::vscode::find_on_path("multipass").or_else(|| {
        // A service's PATH lacks /usr/local/bin and /snap/bin.
        [
            "/usr/local/bin/multipass",
            "/snap/bin/multipass",
            "/opt/homebrew/bin/multipass",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
    })
}

/// Whether sandboxed sessions can run here.
pub fn available() -> bool {
    cfg!(unix) && program().is_some()
}

static PROFILE: OnceLock<Option<String>> = OnceLock::new();

pub fn set_profile(profile: Option<String>) {
    let _ = PROFILE.set(profile);
}

/// The shared instance: `instance`, else `btmux-sandbox` with the profile.
pub fn instance_name(config: &MultipassConfig) -> String {
    if let Some(name) = &config.instance {
        return name.clone();
    }
    match PROFILE.get().cloned().flatten() {
        Some(profile) => format!("btmux-sandbox-{profile}"),
        None => "btmux-sandbox".into(),
    }
}

/// A directory to mount, canonical. Refuses the home directory and its
/// ancestors, which would hand the guest everything isolation hides.
pub fn check_mount(path: &str) -> Result<String, String> {
    let expanded = expand_tilde(path);
    if !expanded.is_absolute() {
        return Err(format!("{path}: use an absolute path"));
    }
    let canonical = expanded
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("{path}: not a directory"));
    }
    let home = dirs::home_dir().and_then(|home| home.canonicalize().ok());
    if canonical.parent().is_none() || home.is_some_and(|home| home.starts_with(&canonical)) {
        return Err(format!(
            "{}: mount a project directory, not your home directory or above it",
            canonical.display()
        ));
    }
    let canonical = canonical.to_string_lossy().into_owned();
    if canonical.contains(':') {
        return Err(format!("{canonical}: Multipass can't mount paths with ':'"));
    }
    Ok(canonical)
}

fn expand_tilde(path: &str) -> PathBuf {
    match (path.strip_prefix('~'), dirs::home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
            home.join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(path),
    }
}

/// A pane's guest.
#[derive(Clone, Debug)]
pub struct Guest {
    pub instance: String,
    pub mounts: Vec<String>,
    pub shell: GuestShell,
    pub config: MultipassConfig,
}

impl Guest {
    /// Whether an OSC 7 host names the guest.
    pub fn is_host(&self, host: &str) -> bool {
        let label = |name: &str| {
            name.split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        };
        host.is_empty()
            || host.eq_ignore_ascii_case("localhost")
            || label(host) == label(&self.instance)
    }

    /// Whether a guest path is a mounted host path.
    pub fn mounted(&self, path: &str) -> bool {
        self.mounts
            .iter()
            .any(|mount| Path::new(path).starts_with(mount))
    }

    /// `btmux guest-shell` arguments for a shell in `cwd`.
    pub fn wrapper_args(&self, cwd: Option<&str>) -> Vec<String> {
        let mut args = vec![
            "guest-shell".to_string(),
            "--instance".into(),
            self.instance.clone(),
            "--shell".into(),
            self.shell.name().into(),
            "--image".into(),
            self.config.image.clone(),
            "--cpus".into(),
            self.config.cpus.to_string(),
            "--memory".into(),
            self.config.memory.clone(),
            "--disk".into(),
            self.config.disk.clone(),
        ];
        if let Some(cloud_init) = &self.config.cloud_init {
            args.extend(["--cloud-init".into(), cloud_init.clone()]);
        }
        for mount in &self.mounts {
            args.extend(["--mount".into(), mount.clone()]);
        }
        let cwd = cwd
            .filter(|cwd| self.mounted(cwd))
            .or(self.mounts.first().map(String::as_str));
        if let Some(cwd) = cwd {
            args.extend(["--cwd".into(), cwd.to_string()]);
        }
        args
    }
}

#[derive(clap::Args, Clone, Debug)]
pub struct GuestShellArgs {
    #[arg(long)]
    instance: String,
    #[arg(long, value_enum)]
    shell: GuestShell,
    #[arg(long = "mount")]
    mounts: Vec<String>,
    #[arg(long)]
    cwd: Option<String>,
    #[arg(long)]
    image: String,
    #[arg(long)]
    cpus: u32,
    #[arg(long)]
    memory: String,
    #[arg(long)]
    disk: String,
    #[arg(long)]
    cloud_init: Option<String>,
}

/// The default cloud-init: tools agents expect, the shells, and the agents.
const CLOUD_INIT: &str = r#"#cloud-config
package_update: true
packages:
  - build-essential
  - ca-certificates
  - curl
  - fish
  - git
  - jq
  - nodejs
  - npm
  - ripgrep
  - unzip
  - zsh
write_files:
  # DNS can fail early in the first boot, so retry.
  - path: /usr/local/lib/btmux/install-agents.sh
    permissions: "0755"
    content: |
      #!/bin/bash
      set -o pipefail
      retry() { for _ in 1 2 3 4 5 6; do "$@" && return; sleep 10; done; return 1; }
      retry su - ubuntu -c 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'
      retry npm install -g @openai/codex
runcmd:
  - /usr/local/lib/btmux/install-agents.sh
"#;

/// Shell integration: OSC 7 with the guest's hostname, which the server maps
/// back to host paths under mounts, and OSC 133 marks, from which it tells
/// the shell's prompt from a running program (`Probe`).
const BASH_INTEGRATION: &str = r#"# btmux: cwd and prompt marks in btmux panes.
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
if [ -n "$BASH_VERSION" ] && [ "$TERM_PROGRAM" = btmux ]; then
  __btmux_prompt() {
    local s=$? p=${PWD//%/%25}
    printf '\e]7;file://%s%s\a\e]133;A\a' "$HOSTNAME" "${p// /%20}"
    return $s
  }
  PROMPT_COMMAND="__btmux_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  PS0='\e]133;C\a'"${PS0:-}"
fi
"#;

const ZSH_INTEGRATION: &str = r#"# btmux: cwd and prompt marks in btmux panes.
if [[ $TERM_PROGRAM == btmux ]]; then
  path=(~/.local/bin $path)
  __btmux_precmd() {
    local p=${PWD//\%/%25}
    printf '\e]7;file://%s%s\a\e]133;A\a' "$HOST" "${p// /%20}"
  }
  __btmux_preexec() { printf '\e]133;C\a' }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __btmux_precmd
  add-zsh-hook preexec __btmux_preexec
fi
"#;

const FISH_INTEGRATION: &str = r#"# btmux: cwd and prompt marks in btmux panes.
if test "$TERM_PROGRAM" = btmux
    fish_add_path -g ~/.local/bin
    function __btmux_prompt --on-event fish_prompt
        set -l p (string replace -a % %25 -- $PWD | string replace -a ' ' %20)
        printf '\e]7;file://%s%s\a\e]133;A\a' $hostname "$p"
    end
    function __btmux_preexec --on-event fish_preexec
        printf '\e]133;C\a'
    end
end
"#;

/// Installs the shell integration and makes sure `shell` exists. Idempotent.
fn integration_script(shell: GuestShell) -> String {
    format!(
        r#"set -e
mkdir -p /etc/btmux /etc/fish/conf.d
cat > /etc/profile.d/btmux.sh <<'BTMUX_EOF'
{BASH_INTEGRATION}BTMUX_EOF
cat > /etc/btmux/btmux.zsh <<'BTMUX_EOF'
{ZSH_INTEGRATION}BTMUX_EOF
cat > /etc/fish/conf.d/btmux-guest.fish <<'BTMUX_EOF'
{FISH_INTEGRATION}BTMUX_EOF
if [ -f /etc/zsh/zshrc ] && ! grep -q btmux.zsh /etc/zsh/zshrc; then
  echo '[ -r /etc/btmux/btmux.zsh ] && . /etc/btmux/btmux.zsh' >> /etc/zsh/zshrc
fi
if ! command -v {shell} >/dev/null; then
  echo "btmux: installing {shell}"
  apt-get install -y -qq {shell} >/dev/null
  if [ -f /etc/zsh/zshrc ] && ! grep -q btmux.zsh /etc/zsh/zshrc; then
    echo '[ -r /etc/btmux/btmux.zsh ] && . /etc/btmux/btmux.zsh' >> /etc/zsh/zshrc
  fi
fi
# Skip zsh's new-user wizard.
[ -e /home/ubuntu/.zshrc ] || install -o ubuntu -g ubuntu -m 644 /dev/null /home/ubuntu/.zshrc
"#,
        shell = shell.name()
    )
}

fn multipass() -> Result<Command, String> {
    let program = program().ok_or("Multipass is not installed (https://multipass.run)")?;
    Ok(Command::new(program))
}

fn run(args: &[&str]) -> Result<String, String> {
    let output = multipass()?
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run multipass: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("multipass {}: {}", args[0], stderr.trim()))
    }
}

/// Copy a host file into the instance.
pub fn copy_in(instance: &str, host: &Path, guest: &str) -> Result<(), String> {
    run(&[
        "transfer",
        &host.to_string_lossy(),
        &format!("{instance}:{guest}"),
    ])
    .map(drop)
}

/// Run with the pane's terminal, so progress shows.
fn run_visible(args: &[&str]) -> Result<(), String> {
    let status = multipass()?
        .args(args)
        .status()
        .map_err(|e| format!("cannot run multipass: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("multipass {} failed ({status})", args[0]))
    }
}

#[derive(Deserialize)]
struct Info {
    info: std::collections::HashMap<String, InstanceInfo>,
}

#[derive(Deserialize)]
struct InstanceInfo {
    state: String,
    #[serde(default)]
    mounts: std::collections::HashMap<String, MountInfo>,
}

#[derive(Deserialize)]
struct MountInfo {
    source_path: String,
}

/// The instance's state and mounts, or `None` if it doesn't exist.
fn info(instance: &str) -> Result<Option<InstanceInfo>, String> {
    let output = multipass()?
        .args(["info", instance, "--format", "json"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run multipass: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not exist") {
            return Ok(None);
        }
        return Err(format!("multipass info: {}", stderr.trim()));
    }
    let mut info: Info = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("cannot read multipass info: {e}"))?;
    Ok(info.info.remove(instance))
}

/// The host's address on the instance's network: its default gateway.
fn gateway(instance: &str) -> Result<IpAddr, String> {
    let route = run(&[
        "exec", instance, "-n", "--", "ip", "-4", "route", "show", "default",
    ])?;
    route
        .split_whitespace()
        .skip_while(|word| *word != "via")
        .nth(1)
        .and_then(|ip| ip.parse().ok())
        .ok_or_else(|| format!("no default route in {instance}: {}", route.trim()))
}

/// Serializes setup across panes starting at once.
fn lock(instance: &str) -> Result<std::fs::File, String> {
    let dir = dirs::cache_dir()
        .ok_or("cannot resolve the cache directory")?
        .join("btmux");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = std::fs::File::create(dir.join(format!("multipass-{instance}.lock")))
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(file)
}

fn say(message: &str) {
    eprintln!("\x1b[2mbtmux: {message}\x1b[0m");
}

/// Create or start the instance, mount, and install btmux and the shell
/// integration.
fn prepare(args: &GuestShellArgs) -> Result<(), String> {
    let instance = args.instance.as_str();
    let _lock = lock(instance)?;
    let mut created = false;
    let current = match info(instance)? {
        Some(current) => current,
        None => {
            say(&format!(
                "creating the Multipass instance {instance}; the first one downloads an image and takes a few minutes"
            ));
            let cloud_init = match &args.cloud_init {
                Some(path) => expand_tilde(path),
                None => {
                    let path =
                        std::env::temp_dir().join(format!("btmux-{instance}-cloud-init.yaml"));
                    std::fs::write(&path, CLOUD_INIT).map_err(|e| e.to_string())?;
                    path
                }
            };
            let cloud_init = cloud_init.to_string_lossy().into_owned();
            let cpus = args.cpus.to_string();
            run_visible(&[
                "launch",
                &args.image,
                "--name",
                instance,
                "--cpus",
                &cpus,
                "--memory",
                &args.memory,
                "--disk",
                &args.disk,
                "--cloud-init",
                &cloud_init,
                "--timeout",
                "1800",
            ])?;
            created = true;
            info(instance)?.ok_or("the new instance is missing")?
        }
    };
    if current.state != "Running" {
        say(&format!("starting {instance}"));
        run_visible(&["start", instance])?;
    }
    // SSH can briefly fail right after a start.
    for attempt in 0.. {
        match run(&["exec", instance, "-n", "--", "true"]) {
            Ok(_) => break,
            Err(error) if attempt == 30 => return Err(error),
            Err(_) => std::thread::sleep(std::time::Duration::from_secs(2)),
        }
    }
    if created {
        say("waiting for cloud-init to install packages and agents");
    }
    if let Err(error) = run(&[
        "exec",
        instance,
        "-n",
        "--",
        "cloud-init",
        "status",
        "--wait",
    ]) {
        say(&format!(
            "cloud-init reported a problem; see /var/log/cloud-init-output.log in {instance} ({error})"
        ));
    }
    let mounted: HashSet<(&str, &str)> = current
        .mounts
        .iter()
        .map(|(target, mount)| (target.as_str(), mount.source_path.as_str()))
        .collect();
    for mount in &args.mounts {
        if !mounted.contains(&(mount.as_str(), mount.as_str())) {
            say(&format!("mounting {mount}"));
            run(&["mount", mount, &format!("{instance}:{mount}")])?;
        }
    }
    install_btmux(instance)?;
    let script = integration_script(args.shell);
    let status = multipass()?
        .args(["exec", instance, "-n", "--", "sudo", "bash", "-c", &script])
        .stdin(Stdio::null())
        .status()
        .map_err(|e| format!("cannot run multipass: {e}"))?;
    if !status.success() {
        return Err(format!("setting up {instance} failed ({status})"));
    }
    if created {
        say("log in to Claude Code or Codex once in a sandboxed pane; the login stays in the instance");
    }
    Ok(())
}

/// Put this btmux version at `GUEST_BIN`, then install its agent hooks.
fn install_btmux(instance: &str) -> Result<(), String> {
    let version = run(&["exec", instance, "-n", "--", GUEST_BIN, "version"]).unwrap_or_default();
    if version.split_whitespace().last() == Some(crate::config::VERSION) {
        return Ok(());
    }
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        arch => return Err(format!("no btmux release for {arch} guests")),
    };
    let staged = "/tmp/btmux-install";
    // Guests share the host's architecture, so a Linux host's binary runs there.
    let local = cfg!(target_os = "linux")
        .then(crate::pty::server_exe)
        .flatten()
        .map(|exe| exe.to_string_lossy().into_owned());
    if let Some(exe) = local {
        say(&format!(
            "copying btmux {} into {instance}",
            crate::config::VERSION
        ));
        run(&["transfer", &exe, &format!("{instance}:{staged}")])?;
    } else {
        say(&format!(
            "downloading btmux {} into {instance}",
            crate::config::VERSION
        ));
        let asset = format!("btmux-{arch}-unknown-linux-gnu");
        let base = "https://github.com/buntec/btmux/releases";
        let script = format!(
            "curl -fsSL -o {staged} {base}/download/v{version}/{asset} \
             || {{ echo 'btmux: no release for this version; using the latest' >&2; \
             curl -fsSL -o {staged} {base}/latest/download/{asset}; }}",
            version = crate::config::VERSION
        );
        run(&["exec", instance, "-n", "--", "sh", "-c", &script])?;
    }
    run(&[
        "exec", instance, "-n", "--", "sudo", "install", "-m", "755", staged, GUEST_BIN,
    ])?;
    let hooks = format!(
        "{GUEST_BIN} install-claude-code-hooks >/dev/null; {GUEST_BIN} install-codex-hooks >/dev/null; \
         command -v fish >/dev/null && {GUEST_BIN} install-fish-integration >/dev/null; true"
    );
    run(&["exec", instance, "-n", "--", "sh", "-c", &hooks])?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct BridgeRequest {
    address: IpAddr,
}

#[derive(Serialize, Deserialize)]
pub struct BridgeResponse {
    url: String,
    token: String,
}

/// Ask the server for its guest address and token.
async fn bridge(instance: &str) -> Result<BridgeResponse, String> {
    let instance = instance.to_string();
    let address = tokio::task::spawn_blocking(move || gateway(&instance))
        .await
        .map_err(|e| e.to_string())??;
    let body = crate::api_client::request(
        None,
        reqwest::Method::POST,
        "/api/multipass/bridge",
        Some(serde_json::json!(BridgeRequest { address })),
        std::time::Duration::from_secs(10),
    )
    .await?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

/// `btmux guest-shell`: prepare the instance, then become the guest's shell.
pub async fn guest_shell(args: GuestShellArgs) -> i32 {
    let prepared = {
        let args = args.clone();
        tokio::task::spawn_blocking(move || prepare(&args))
            .await
            .unwrap_or_else(|e| Err(e.to_string()))
    };
    let result = match prepared {
        Ok(()) => bridge(&args.instance).await,
        Err(error) => Err(error),
    };
    let bridge = match result {
        Ok(bridge) => bridge,
        Err(error) => return fail(&error),
    };
    let Ok(pane) = std::env::var("BTMUX_PANE_ID") else {
        return fail("BTMUX_PANE_ID is unset");
    };
    let mut command = match multipass() {
        Ok(command) => command,
        Err(error) => return fail(&error),
    };
    command.args(["exec", &args.instance]);
    match &args.cwd {
        Some(cwd) => command.args(["-d", cwd]),
        None => command.arg("-n"),
    };
    command.args(["--", "env"]);
    for var in [
        "TERM",
        "COLORTERM",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "LANG",
    ] {
        if let Ok(value) = std::env::var(var) {
            command.arg(format!("{var}={value}"));
        }
    }
    command.args([
        format!("BTMUX_PANE_ID={pane}"),
        format!("BTMUX_API_URL={}", bridge.url),
        format!("BTMUX_AUTH_TOKEN={}", bridge.token),
        format!(
            "BTMUX_OTEL_ENDPOINT={}/api/panes/{pane}/telemetry",
            bridge.url
        ),
        format!("BTMUX_BIN={GUEST_BIN}"),
    ]);
    command.args([args.shell.name(), "-l"]);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        fail(&format!("cannot run multipass: {error}"))
    }
    #[cfg(not(unix))]
    fail("sandboxed sessions need a Unix host")
}

/// Show the error until a key is pressed, then exit, closing the pane.
fn fail(error: &str) -> i32 {
    eprintln!("\x1b[31mbtmux: {error}\x1b[0m\r\nPress Enter to close this pane.");
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    1
}

/// The server's half: a listener on each bridge address guests asked for.
struct Bridge {
    auth: std::sync::Arc<crate::auth::Auth>,
    port: u16,
    /// The main listener takes every address.
    unspecified: bool,
    app: Mutex<Option<axum::Router>>,
    bound: Mutex<HashSet<IpAddr>>,
}

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

pub fn configure_bridge(auth: std::sync::Arc<crate::auth::Auth>, host: &str, port: u16) {
    let unspecified = host
        .trim_matches(['[', ']'])
        .parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_unspecified());
    let _ = BRIDGE.set(Bridge {
        auth,
        port,
        unspecified,
        app: Mutex::new(None),
        bound: Mutex::default(),
    });
}

/// The app the bridge listeners serve, with its auth layer.
pub fn set_app(app: axum::Router) {
    if let Some(bridge) = BRIDGE.get() {
        *bridge.app.lock().unwrap() = Some(app);
    }
}

/// Listen on `address`, a private address of this host, for guests.
async fn listen(address: IpAddr) -> Result<String, String> {
    let bridge = BRIDGE.get().ok_or("the bridge isn't configured")?;
    let private = match address {
        IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => ip.is_unique_local() || ip.is_unicast_link_local(),
    };
    if !private {
        return Err(format!("{address} isn't a private address"));
    }
    let authority = match address {
        IpAddr::V4(ip) => format!("{ip}:{}", bridge.port),
        IpAddr::V6(ip) => format!("[{ip}]:{}", bridge.port),
    };
    let url = format!("http://{authority}");
    bridge.auth.allow(&url)?;
    if bridge.unspecified || bridge.bound.lock().unwrap().contains(&address) {
        return Ok(url);
    }
    let app = bridge
        .app
        .lock()
        .unwrap()
        .clone()
        .ok_or("the server is starting")?;
    let listener = match tokio::net::TcpListener::bind(&authority).await {
        Ok(listener) => listener,
        Err(e) => return Err(format!("cannot listen on {authority}: {e}")),
    };
    if !bridge.bound.lock().unwrap().insert(address) {
        return Ok(url);
    }
    tracing::info!("listening for Multipass guests on {authority}");
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::warn!("guest listener on {authority} stopped: {error}");
        }
    });
    Ok(url)
}

/// `POST /api/multipass/bridge`, from `btmux guest-shell` with the host token.
pub async fn api_bridge(Json(request): Json<BridgeRequest>) -> axum::response::Response {
    let Some(token) = crate::auth::guest_token() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "no guest token").into_response();
    };
    match listen(request.address).await {
        Ok(url) => Json(BridgeResponse {
            url,
            token: token.to_string(),
        })
        .into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

/// Listen again for running guests after a restart or upgrade, whose shells
/// keep the address they were given.
pub fn restore_bridge(instance: String) {
    tokio::spawn(async move {
        let address = tokio::task::spawn_blocking(move || {
            let running = info(&instance).ok().flatten()?.state == "Running";
            running.then(|| gateway(&instance).ok()).flatten()
        })
        .await
        .ok()
        .flatten();
        if let Some(address) = address {
            if let Err(error) = listen(address).await {
                tracing::warn!("cannot listen for Multipass guests: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guest(mounts: &[&str]) -> Guest {
        Guest {
            instance: "btmux-sandbox".into(),
            mounts: mounts.iter().map(|m| m.to_string()).collect(),
            shell: GuestShell::Fish,
            config: MultipassConfig::default(),
        }
    }

    #[test]
    fn names_guest_shells() {
        assert_eq!(GuestShell::of("/usr/bin/fish"), Some(GuestShell::Fish));
        assert_eq!(GuestShell::of("/bin/zsh"), Some(GuestShell::Zsh));
        assert_eq!(GuestShell::of("/bin/bash"), Some(GuestShell::Bash));
        assert_eq!(GuestShell::of("nu"), None);
    }

    #[test]
    fn maps_guest_cwds_under_mounts() {
        let guest = guest(&["/src/app"]);
        assert!(guest.is_host("btmux-sandbox"));
        assert!(guest.is_host("BTMUX-SANDBOX.localdomain"));
        assert!(!guest.is_host("elsewhere"));
        assert!(guest.mounted("/src/app/lib"));
        assert!(!guest.mounted("/src/application"));
        assert!(!guest.mounted("/home/ubuntu"));
    }

    #[test]
    fn wrapper_starts_in_a_mount() {
        let guest = guest(&["/src/app"]);
        let args = guest.wrapper_args(Some("/src/app/lib"));
        assert!(args.ends_with(&["--cwd".into(), "/src/app/lib".into()]));
        let args = guest.wrapper_args(Some("/etc"));
        assert!(args.ends_with(&["--cwd".into(), "/src/app".into()]));
        assert!(args.windows(2).any(|w| w == ["--shell", "fish"]));
    }

    #[test]
    fn refuses_home_and_its_ancestors() {
        let home = dirs::home_dir().unwrap();
        assert!(check_mount(&home.to_string_lossy()).is_err());
        assert!(check_mount("~").is_err());
        assert!(check_mount("/").is_err());
        assert!(check_mount("relative").is_err());
        let dir = std::env::temp_dir().join(format!("btmux-mount-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        assert!(check_mount(&dir.to_string_lossy()).is_ok());
        std::fs::remove_dir(dir).unwrap();
    }
}
