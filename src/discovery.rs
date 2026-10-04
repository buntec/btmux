//! Owner-only local server registrations, shared with the desktop launcher.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub struct RunningServer {
    pub pid: u32,
    pub address: SocketAddr,
    pub profile: Option<String>,
    pub token: String,
}

pub fn state_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))?;
    Some(base.join("btmux"))
}

pub fn valid_token(token: &str) -> bool {
    token.len() >= 32
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}

pub fn read_private_file(path: &Path) -> std::io::Result<String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 16 * 1024
    {
        return Err(std::io::Error::other("expected an owner-only regular file"));
    }
    let mut contents = String::new();
    file.take(16 * 1024).read_to_string(&mut contents)?;
    Ok(contents)
}

pub fn read_registration(path: &Path) -> Option<RunningServer> {
    let server: RunningServer = serde_json::from_str(&read_private_file(path).ok()?).ok()?;
    (server.address.ip().is_loopback()
        && server.address.port() != 0
        && server.pid > 0
        && valid_token(&server.token))
    .then_some(server)
}

pub fn registration_paths(dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![dir.join("state.server")];
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                paths.push(entry.path().join("state.server"));
            }
        }
    }
    paths.sort();
    paths
}

pub struct Registration(PathBuf);

impl Registration {
    pub fn publish(
        state_file: &Path,
        mut address: SocketAddr,
        profile: Option<String>,
        token: String,
    ) -> std::io::Result<Option<Self>> {
        if address.ip().is_unspecified() {
            address.set_ip(match address.ip() {
                IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
                IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
            });
        }
        if !address.ip().is_loopback() {
            return Ok(None);
        }
        let server = RunningServer {
            pid: std::process::id(),
            address,
            profile,
            token,
        };
        let path = state_file.with_extension("server");
        let temporary = path.with_extension(format!("server.{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file: File = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            let contents = serde_json::to_vec(&server)?;
            file.write_all(&contents)?;
            file.sync_all()?;
            std::fs::rename(&temporary, &path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temporary);
        }
        result?;
        Ok(Some(Self(path)))
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn publishes_private_registration_and_removes_it_on_shutdown() {
        let dir = std::env::temp_dir().join(format!("btmux-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.server");
        let registration = Registration::publish(
            &dir.join("state.json"),
            "0.0.0.0:8004".parse().unwrap(),
            Some("test".into()),
            "a".repeat(64),
        )
        .unwrap()
        .unwrap();
        let server = read_registration(&path).unwrap();
        assert_eq!(server.address, "127.0.0.1:8004".parse().unwrap());
        assert_eq!(server.profile.as_deref(), Some("test"));
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        let link = dir.join("link");
        symlink(&path, &link).unwrap();
        assert!(read_registration(&link).is_none());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_registration(&path).is_none());
        drop(registration);
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_remote_addresses_and_invalid_credentials() {
        let dir = std::env::temp_dir().join(format!("btmux-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = dir.join("state.json");
        assert!(Registration::publish(
            &state,
            "192.0.2.1:8004".parse().unwrap(),
            None,
            "a".repeat(64)
        )
        .unwrap()
        .is_none());
        let registration = Registration::publish(
            &state,
            "[::]:8004".parse().unwrap(),
            None,
            "bad\r\nheader".into(),
        )
        .unwrap()
        .unwrap();
        assert!(read_registration(&state.with_extension("server")).is_none());
        drop(registration);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scans_default_and_named_profiles_without_following_directory_symlinks() {
        let dir = std::env::temp_dir().join(format!("btmux-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("dev")).unwrap();
        symlink(dir.join("dev"), dir.join("linked")).unwrap();
        assert_eq!(
            registration_paths(&dir),
            vec![dir.join("dev/state.server"), dir.join("state.server")]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
