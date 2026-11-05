//! `btmux fzf`: a btmux menu for the fzf calls one can honor, the real fzf for the rest.
//!
//! Anything not known to be safe to drop goes to the real fzf, so a script
//! never gets a menu that behaves differently from what it asked for.

use std::ffi::{OsStr, OsString};
use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::widget::{self, PickArgs};

const EXIT_FAILED: i32 = 2;

/// Appearance and matching details, which a menu has its own of. Previews are dropped too.
const IGNORED_SWITCHES: &[&str] = &[
    "-e",
    "+e",
    "--exact",
    "--no-exact",
    "-i",
    "+i",
    "--ignore-case",
    "--no-ignore-case",
    "--smart-case",
    "-x",
    "+x",
    "--extended",
    "--no-extended",
    "--cycle",
    "--no-cycle",
    "--keep-right",
    "--no-keep-right",
    "--reverse",
    "--no-reverse",
    "--mouse",
    "--no-mouse",
    "--hscroll",
    "--no-hscroll",
    "--bold",
    "--no-bold",
    "--black",
    "--no-black",
    "--no-color",
    "--unicode",
    "--no-unicode",
    "--ambidouble",
    "--no-ambidouble",
    "--highlight-line",
    "--no-highlight-line",
    "--inline-info",
    "--no-inline-info",
    "--no-info",
    "--no-separator",
    "--no-scrollbar",
    "--no-border",
    "--no-preview",
    "--wrap",
    "--no-wrap",
];

/// As above, with a value only after `=`.
const IGNORED_OPTIONAL_VALUES: &[&str] = &["--border", "--info", "--separator", "--scrollbar"];

/// As above, with a required value, after `=` or as the next argument.
const IGNORED_VALUES: &[&str] = &[
    "-d",
    "--delimiter",
    "-n",
    "--nth",
    "--height",
    "--min-height",
    "--layout",
    "--margin",
    "--padding",
    "--color",
    "--tabstop",
    "--border-label",
    "--border-label-pos",
    "--pointer",
    "--marker",
    "--ellipsis",
    "--scheme",
    "--tiebreak",
    "--jump-labels",
    "--hscroll-off",
    "--scroll-off",
    "--preview",
    "--preview-window",
    "--preview-label",
    "--preview-label-pos",
];

/// `--bind` actions that a menu's own keys cover.
const IGNORED_ACTIONS: &[&str] = &[
    "accept",
    "abort",
    "cancel",
    "ignore",
    "up",
    "down",
    "page-up",
    "page-down",
    "half-page-up",
    "half-page-down",
    "first",
    "last",
    "toggle",
    "toggle-up",
    "toggle-down",
    "toggle-out",
    "toggle-in",
    "toggle-all",
    "select",
    "deselect",
    "select-all",
    "deselect-all",
    "clear-query",
    "clear-selection",
    "toggle-preview",
    "preview-up",
    "preview-down",
    "preview-page-up",
    "preview-page-down",
    "preview-half-page-up",
    "preview-half-page-down",
    "preview-top",
    "preview-bottom",
];

/// `--bind` keys, after any modifiers, besides single characters. Anything else,
/// such as `load`, may be an event, which acts with no key pressed.
const BIND_KEYS: &[&str] = &[
    "tab",
    "btab",
    "enter",
    "return",
    "esc",
    "space",
    "bspace",
    "bs",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "insert",
    "delete",
    "del",
    "page-up",
    "pgup",
    "page-down",
    "pgdn",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
];

#[derive(Default)]
struct Options {
    pick: PickArgs,
    /// Reverse the input.
    tac: bool,
}

fn is_bind_key(name: &str) -> bool {
    let mut key = name;
    while let Some(rest) = ["ctrl-", "alt-", "shift-"]
        .iter()
        .find_map(|modifier| key.strip_prefix(modifier))
    {
        key = rest;
    }
    key.chars().count() == 1 || BIND_KEYS.contains(&key)
}

/// Whether a menu can stand in for this `--bind` value.
fn ignorable_binds(binds: &str) -> bool {
    if binds.contains(['(', '[', '{']) {
        return false;
    }
    binds.split(',').all(|bind| {
        let Some((key, actions)) = bind.split_once(':') else {
            return false;
        };
        let accepting = matches!(key, "enter" | "return" | "ctrl-m");
        is_bind_key(key)
            && actions.split('+').all(|action| {
                IGNORED_ACTIONS.contains(&action) && (!accepting || action == "accept")
            })
    })
}

/// Applies arguments in order, as fzf does; `None` if the real fzf has to honor one.
fn apply_args(options: &mut Options, args: &[String]) -> Option<()> {
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        let mut value = |inline: Option<String>| inline.or_else(|| args.next().cloned());
        let pick = &mut options.pick;
        match name {
            "-q" | "--query" => pick.query = Some(value(inline)?),
            "--prompt" => {
                let prompt = value(inline)?;
                let prompt = prompt.trim_end_matches([' ', '>', ':']);
                pick.prompt = (!prompt.is_empty()).then(|| prompt.to_owned());
            }
            // A limit on the marks is more than a menu can honor.
            "-m" | "--multi" if inline.is_none() => pick.multi = true,
            "+m" | "--no-multi" => pick.multi = false,
            "--read0" => pick.read0 = true,
            "--no-read0" => pick.read0 = false,
            "--print0" => pick.print0 = true,
            "--no-print0" => pick.print0 = false,
            "-1" | "--select-1" => pick.select_1 = true,
            "+1" | "--no-select-1" => pick.select_1 = false,
            "-0" | "--exit-0" => pick.exit_0 = true,
            "+0" | "--no-exit-0" => pick.exit_0 = false,
            "+s" | "--no-sort" if inline.is_none() => pick.no_sort = true,
            "--sort" => pick.no_sort = false,
            "--tac" => options.tac = true,
            "--no-tac" => options.tac = false,
            "--bind" => {
                if !ignorable_binds(&value(inline)?) {
                    return None;
                }
            }
            _ if IGNORED_SWITCHES.contains(&name) && inline.is_none() => {}
            _ if IGNORED_OPTIONAL_VALUES.contains(&name) => {}
            _ if IGNORED_VALUES.contains(&name) => {
                value(inline)?;
            }
            _ => return None,
        }
    }
    Some(())
}

/// `FZF_DEFAULT_OPTS_FILE`, then `FZF_DEFAULT_OPTS`, then the arguments, as fzf reads them.
fn parse(default_opts: &[String], args: &[String]) -> Option<Options> {
    let mut options = Options::default();
    for opts in default_opts {
        apply_args(&mut options, &shlex::split(opts)?)?;
    }
    apply_args(&mut options, args)?;
    // Only fzf's own matching can decide these without a menu.
    let pick = &options.pick;
    let query = pick.query.as_deref().unwrap_or_default();
    if (pick.select_1 || pick.exit_0) && !query.trim().is_empty() {
        return None;
    }
    Some(options)
}

fn default_opts() -> Option<Vec<String>> {
    let mut opts = Vec::new();
    if let Some(path) = std::env::var_os("FZF_DEFAULT_OPTS_FILE").filter(|path| !path.is_empty()) {
        opts.push(std::fs::read_to_string(path).ok()?);
    }
    match std::env::var("FZF_DEFAULT_OPTS") {
        Ok(value) => opts.push(value),
        Err(std::env::VarError::NotPresent) => {}
        Err(std::env::VarError::NotUnicode(_)) => return None,
    }
    Some(opts)
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::X_OK) } == 0)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    true
}

/// The first executable `fzf` on `path` that isn't `this`.
fn find_fzf(path: &OsStr, this: Option<&Path>) -> Option<PathBuf> {
    let name = if cfg!(windows) { "fzf.exe" } else { "fzf" };
    std::env::split_paths(path)
        .map(|dir| dir.join(name))
        .find(|path| {
            path.is_file()
                && is_executable(path)
                && std::fs::canonicalize(path)
                    .ok()
                    .is_some_and(|path| Some(path.as_path()) != this)
        })
}

/// The real fzf: this binary may be linked as `fzf`.
pub(crate) fn real_fzf() -> Option<PathBuf> {
    let this = std::env::current_exe().and_then(std::fs::canonicalize).ok();
    find_fzf(&std::env::var_os("PATH")?, this.as_deref())
}

/// Runs the real fzf, sending what was already read from stdin and then the rest of it.
fn run_real(args: &[OsString], read: Option<Vec<u8>>) -> i32 {
    let Some(fzf) = real_fzf() else {
        eprintln!("btmux: this needs fzf, which isn't on PATH");
        return EXIT_FAILED;
    };
    let mut command = Command::new(fzf);
    command.args(args);
    if read.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("btmux: couldn't run fzf: {error}");
            return EXIT_FAILED;
        }
    };
    if let (Some(read), Some(mut input)) = (read, child.stdin.take()) {
        // On a thread, since fzf may exit before a producer does.
        std::thread::spawn(move || {
            if input.write_all(&read).is_ok() {
                let _ = std::io::copy(&mut std::io::stdin(), &mut input);
            }
        });
    }
    match child.wait() {
        Ok(status) => status.code().unwrap_or(EXIT_FAILED),
        Err(error) => {
            eprintln!("btmux: couldn't run fzf: {error}");
            EXIT_FAILED
        }
    }
}

fn to_strings(args: &[OsString]) -> Option<Vec<String>> {
    args.iter()
        .map(|arg| arg.to_str().map(str::to_owned))
        .collect()
}

/// fzf shows tabs as space and prints them, keeps empty records, and has no descriptions.
fn items<'a>(input: &'a [u8], options: &Options) -> Vec<(&'a [u8], widget::PickItem)> {
    let separator = if options.pick.read0 { 0 } else { b'\n' };
    let mut items: Vec<_> = input
        .split_inclusive(|&byte| byte == separator)
        .map(|record| {
            let value = record.strip_suffix(&[separator]).unwrap_or(record);
            let label = String::from_utf8_lossy(value).replace('\t', " ");
            let description = None;
            (value, widget::PickItem { label, description })
        })
        .collect();
    if options.tac {
        items.reverse();
    }
    items
}

/// The arguments if this binary was run under the name `fzf`.
pub fn args_when_linked() -> Option<Vec<OsString>> {
    let mut args = std::env::args_os();
    let name = PathBuf::from(args.next()?);
    (name.file_stem()? == "fzf").then(|| args.collect())
}

pub async fn run(args: &[OsString]) -> i32 {
    let options = to_strings(args).and_then(|strings| parse(&default_opts()?, &strings));
    let (Some(options), Ok(pane)) = (options, widget::pane_id()) else {
        return run_real(args, None);
    };
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() {
        return run_real(args, None);
    }
    // A longer list than a menu can take goes to fzf, without waiting for the end of it.
    let mut input = Vec::new();
    let limit = widget::MAX_BYTES as u64 + 1;
    if let Err(error) = (&mut stdin).take(limit).read_to_end(&mut input) {
        eprintln!("btmux: {error}");
        return EXIT_FAILED;
    }
    if input.len() > widget::MAX_BYTES {
        return run_real(args, Some(input));
    }
    let shown = widget::pick_from(&pane, &options.pick, items(&input, &options)).await;
    match shown {
        Ok(code) => code,
        Err(_) => run_real(args, Some(input)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_owned()).collect()
    }

    fn parsed(list: &[&str]) -> Option<Options> {
        parse(&[], &args(list))
    }

    #[test]
    fn takes_what_zoxide_passes() {
        let options = parsed(&[
            "--delimiter=\t",
            "--nth=2",
            "--read0",
            "--exact",
            "--no-sort",
            "--bind=ctrl-z:ignore,btab:up,tab:down",
            "--cycle",
            "--keep-right",
            "--border=sharp",
            "--height=45%",
            "--info=inline",
            "--layout=reverse",
            "--tabstop=1",
            "--exit-0",
            "--preview=\\command -p ls -Cp {2..}",
            "--preview-window=down,30%,sharp",
        ])
        .unwrap();
        assert!(options.pick.read0 && options.pick.exit_0 && !options.pick.multi);
        assert!(options.pick.no_sort, "zoxide lists by score");
    }

    #[test]
    fn maps_flags_in_every_spelling() {
        let options = parsed(&["-q", "a b", "-m", "--print0", "--tac", "--prompt=Pick> "]).unwrap();
        assert_eq!(options.pick.query.as_deref(), Some("a b"));
        assert_eq!(options.pick.prompt.as_deref(), Some("Pick"));
        assert!(options.pick.multi && options.pick.print0 && options.tac);
        assert!(parsed(&["-1"]).unwrap().pick.select_1);
        assert_eq!(
            parsed(&["--query=x"]).unwrap().pick.query.as_deref(),
            Some("x")
        );
        assert_eq!(parsed(&["--prompt", "> "]).unwrap().pick.prompt, None);
        assert!(!parsed(&["-m", "+m"]).unwrap().pick.multi, "later wins");
        assert!(parsed(&["+s"]).unwrap().pick.no_sort);
        assert!(!parsed(&["--no-sort", "--sort=1000"]).unwrap().pick.no_sort);
        assert!(
            parsed(&["--height", "40%", "-e"]).is_some(),
            "a value isn't a flag"
        );
    }

    #[test]
    fn leaves_what_it_cannot_honor_to_fzf() {
        for list in [
            &["--expect=ctrl-x"][..],
            &["--print-query"],
            &["--filter=x"],
            &["-f", "x"],
            &["--with-nth=2"],
            &["--header=x"],
            &["--ansi"],
            &["--multi=3"],
            &["--version"],
            &["--help"],
            &["positional"],
            &["--query"],
            &["--exact=x"],
            &["--no-sort=x"],
        ] {
            assert!(parsed(list).is_none(), "{list:?}");
        }
    }

    #[test]
    fn a_query_that_decides_without_a_menu_goes_to_fzf() {
        for list in [
            &["-q", "fbr", "-1"][..],
            &["--query=^main$", "--exit-0"],
            &["-1", "--query", "x"],
        ] {
            assert!(parsed(list).is_none(), "{list:?}");
        }
        assert!(parse(&args(&["-1"]), &args(&["-q", "x"])).is_none());
        for list in [
            &["-q", "x"][..],
            &["-1", "-0"],
            &["-q", "", "-1"],
            &["-q", " ", "-0"],
            &["-q", "x", "-1", "+1"],
        ] {
            assert!(parsed(list).is_some(), "{list:?}");
        }
    }

    #[test]
    fn binds_are_ignored_only_without_new_behavior() {
        for binds in [
            "tab:down",
            "tab:toggle+down,btab:up",
            "enter:accept",
            "ctrl-y:accept",
            "alt-shift-up:up,ctrl-space:toggle,f12:down,x:ignore",
        ] {
            assert!(ignorable_binds(binds), "{binds}");
        }
        for binds in [
            "ctrl-r:reload(zoxide edit reload)",
            "enter:abort",
            "enter:toggle+accept",
            "ctrl-y:execute-silent(pbcopy)",
            "start:reload(ls)",
            "ctrl-a:select-all+accept+nonsense",
            "nonsense",
            "load:abort",
            "load:select-all+accept",
            "start:accept",
            "one:accept",
            "zero:abort",
            "result:first",
            "tab:down,load:abort",
        ] {
            assert!(!ignorable_binds(binds), "{binds}");
        }
    }

    #[test]
    fn default_opts_come_first_and_keep_quoting() {
        let defaults = args(&["--height 40% --color='bg:#000,fg:#fff' --multi"]);
        let options = parse(&defaults, &args(&["+m"])).unwrap();
        assert!(!options.pick.multi);
        assert!(parse(&args(&["--multi"]), &[]).unwrap().pick.multi);
        assert!(parse(&args(&["--header=x"]), &[]).is_none());
        assert!(
            parse(&args(&["--color='bad"]), &[]).is_none(),
            "bad quoting"
        );
    }

    #[test]
    fn items_are_whole_with_tabs_shown_as_spaces() {
        let options = parsed(&["--read0", "--tac"]).unwrap();
        let list = items(b"  12.0\t/a b\0second\nline\0", &options);
        assert_eq!(list[1].0, b"  12.0\t/a b", "printed unchanged");
        assert_eq!(list[1].1.label, "  12.0 /a b");
        assert_eq!(list[0].1.label, "second\nline");
        let lines = items(b"a\tb\nc\n", &parsed(&[]).unwrap());
        assert_eq!(lines[0].0, b"a\tb");
        assert!(lines[0].1.description.is_none());
    }

    #[test]
    fn items_keep_empty_records() {
        let values = |input, list: &[&str]| {
            items(input, &parsed(list).unwrap())
                .into_iter()
                .map(|(value, _)| value.to_vec())
                .collect::<Vec<_>>()
        };
        let none: Vec<Vec<u8>> = vec![];
        assert_eq!(values(b"", &[]), none);
        assert_eq!(values(b"\n", &[]), [b""]);
        assert_eq!(values(b"\n\n", &[]), [b"", b""]);
        assert_eq!(values(b"a", &[]), [b"a"]);
        assert_eq!(values(b"a\n\nb\n", &[]), [&b"a"[..], b"", b"b"]);
        assert_eq!(values(b"a\n\0\0", &["--read0"]), [&b"a\n"[..], b""]);
    }

    #[cfg(unix)]
    #[test]
    fn finds_the_first_executable_fzf_but_not_itself() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("btmux-fzf-{}", uuid::Uuid::new_v4()));
        let dir = |name: &str| {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        };
        let fzf = |name: &str, mode| {
            let path = dir(name).join("fzf");
            std::fs::write(&path, "").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            path
        };
        fzf("plain", 0o644);
        std::fs::create_dir_all(dir("nested").join("fzf")).unwrap();
        let this = std::fs::canonicalize(fzf("this", 0o755)).unwrap();
        let real = fzf("real", 0o755);
        let path =
            std::env::join_paths(["plain", "nested", "this", "real"].map(|name| root.join(name)))
                .unwrap();
        assert_eq!(find_fzf(&path, Some(&this)), Some(real));
        let path = std::env::join_paths(["plain", "this"].map(|name| root.join(name))).unwrap();
        assert_eq!(find_fzf(&path, Some(&this)), None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
