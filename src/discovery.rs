//! Owner-only local server registrations, shared with the desktop launcher.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
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
    let env = |name| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
    };
    #[cfg(windows)]
    let home = env("LOCALAPPDATA");
    #[cfg(not(windows))]
    let home = env("HOME").map(|h| h.join(".local/state"));
    Some(env("XDG_STATE_HOME").or(home)?.join("btmux"))
}

/// The server's credential rule, shared with `auth.rs`.
pub fn valid_token(token: &str) -> bool {
    token.len() >= 4
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}

/// Create `path`, which must not exist, readable and writable only by this user.
pub fn create_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    #[cfg(windows)]
    options.access_mode(
        windows_sys::Win32::Foundation::GENERIC_WRITE
            | windows_sys::Win32::Storage::FileSystem::WRITE_DAC,
    );
    let file = options.open(path)?;
    #[cfg(windows)]
    if let Err(error) = acl::restrict(&file) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(file)
}

/// The size limit for registrations and token files.
pub const SMALL_FILE: u64 = 16 * 1024;

/// Read an owner-only regular file of at most `limit` bytes.
pub fn read_private_file(path: &Path, limit: u64) -> std::io::Result<String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    #[cfg(unix)]
    let private = metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0;
    #[cfg(windows)]
    let private = acl::is_private(&file);
    if !metadata.is_file() || !private {
        return Err(std::io::Error::other("expected an owner-only regular file"));
    }
    if metadata.len() > limit {
        return Err(std::io::ErrorKind::FileTooLarge.into());
    }
    let mut contents = String::new();
    file.take(limit).read_to_string(&mut contents)?;
    Ok(contents)
}

pub fn read_registration(path: &Path) -> Option<RunningServer> {
    let server: RunningServer =
        serde_json::from_str(&read_private_file(path, SMALL_FILE).ok()?).ok()?;
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
            let mut file = create_private_file(&temporary)?;
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

/// File ACLs, the Windows counterpart of mode 0600.
#[cfg(windows)]
pub mod acl {
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        AclSizeInformation, AddAccessAllowedAce, EqualSid, GetAce, GetAclInformation, GetLengthSid,
        GetTokenInformation, InitializeAcl, IsWellKnownSid, TokenUser, WinBuiltinAdministratorsSid,
        WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, ACL_SIZE_INFORMATION,
        DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSID, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::SystemServices::{
        ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// This process's `TOKEN_USER`, whose SID points into the buffer.
    struct User(Vec<u64>);

    impl User {
        fn current() -> std::io::Result<Self> {
            unsafe {
                let mut token: HANDLE = null_mut();
                if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let mut len = 0;
                GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len);
                let mut buf = vec![0u64; (len as usize).div_ceil(8)];
                let ok =
                    GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
                let error = std::io::Error::last_os_error();
                CloseHandle(token);
                if ok == 0 {
                    return Err(error);
                }
                Ok(Self(buf))
            }
        }

        fn sid(&self) -> PSID {
            unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
        }
    }

    /// Whether only this user (and SYSTEM and Administrators, like root) can
    /// open `file`, which must have been opened with read access.
    pub fn is_private(file: &File) -> bool {
        let Ok(user) = User::current() else {
            return false;
        };
        unsafe {
            let trusted = |sid: PSID| {
                EqualSid(sid, user.sid()) != 0
                    || IsWellKnownSid(sid, WinLocalSystemSid) != 0
                    || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
            };
            let (mut owner, mut dacl, mut descriptor) = (null_mut(), null_mut(), null_mut());
            if GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            ) != ERROR_SUCCESS
            {
                return false;
            }
            // A null DACL grants everyone access.
            let private = !dacl.is_null() && trusted(owner) && aces_trusted(dacl, trusted);
            LocalFree(descriptor);
            private
        }
    }

    /// Whether every allow entry in `dacl` that applies to the file is trusted.
    unsafe fn aces_trusted(dacl: *const ACL, trusted: impl Fn(PSID) -> bool) -> bool {
        unsafe {
            let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
            if GetAclInformation(
                dacl,
                (&raw mut info).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            ) == 0
            {
                return false;
            }
            (0..info.AceCount).all(|index| {
                let mut ace = null_mut();
                if GetAce(dacl, index, &mut ace) == 0 {
                    return false;
                }
                let header = &*ace.cast::<ACE_HEADER>();
                match u32::from(header.AceType) {
                    _ if u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0 => true,
                    ACCESS_DENIED_ACE_TYPE => true,
                    ACCESS_ALLOWED_ACE_TYPE => trusted(
                        (&raw const (*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart)
                            .cast_mut()
                            .cast(),
                    ),
                    // Object and callback entries: not written by btmux.
                    _ => false,
                }
            })
        }
    }

    /// Grant only this user access to `file`, which must have been opened with
    /// `WRITE_DAC`, dropping inherited entries.
    pub fn restrict(file: &File) -> std::io::Result<()> {
        let user = User::current()?;
        unsafe {
            let len = size_of::<ACL>()
                + size_of::<ACCESS_ALLOWED_ACE>()
                + GetLengthSid(user.sid()) as usize;
            let mut buf = vec![0u64; len.div_ceil(8)];
            let acl = buf.as_mut_ptr().cast::<ACL>();
            if InitializeAcl(acl, (buf.len() * 8) as u32, ACL_REVISION) == 0
                || AddAccessAllowedAce(acl, ACL_REVISION, FILE_ALL_ACCESS, user.sid()) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            match SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null(),
            ) {
                ERROR_SUCCESS => Ok(()),
                error => Err(std::io::Error::from_raw_os_error(error as i32)),
            }
        }
    }
}

#[cfg(all(test, unix))]
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
        // Any credential the server accepts.
        let registration = Registration::publish(
            &state,
            "127.0.0.1:8004".parse().unwrap(),
            None,
            "1234".into(),
        )
        .unwrap()
        .unwrap();
        assert!(read_registration(&state.with_extension("server")).is_some());
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
