//! macOS personal-use storage selected by the user. This is a plain local
//! account file protected by filesystem permissions, NOT Keychain encryption.
//! It never reads, updates, or deletes old Keychain entries.
use super::{validate, SavedAccount};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use zeroize::Zeroizing;

const MAX_BYTES: u64 = 4096;
const FILENAME: &str = "account.json";
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn location(home: &Path) -> Result<PathBuf, String> {
    let parent = home
        .parent()
        .filter(|p| p.is_absolute())
        .ok_or("登录信息目录无效")?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| "登录信息目录不可访问")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("登录信息目录无效".into());
    }
    Ok(parent.join(FILENAME))
}

fn checked_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法访问本机登录信息".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.nlink() != 1 {
        return Err("登录信息文件不能是链接或目录".into());
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("登录信息文件权限过宽，请将其设为仅当前用户可读写".into());
    }
    Ok(Some(metadata))
}

pub(super) fn read_saved(home: &Path) -> Result<Option<SavedAccount>, String> {
    let path = location(home)?;
    let Some(before) = checked_metadata(&path)? else {
        return Ok(None);
    };
    if before.len() > MAX_BYTES {
        return Err("登录信息文件过大".into());
    }
    let file = File::open(&path).map_err(|_| "无法读取本机登录信息")?;
    let after = file.metadata().map_err(|_| "无法读取登录信息文件属性")?;
    if before.ino() != after.ino() || before.dev() != after.dev() || after.nlink() != 1 {
        return Err("登录信息文件已改变，请重试".into());
    }
    let mut raw = Zeroizing::new(Vec::new());
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "本机登录信息读取失败")?;
    if raw.len() > MAX_BYTES as usize {
        return Err("登录信息文件过大".into());
    }
    let saved: SavedAccount =
        serde_json::from_slice(&raw).map_err(|_| "已保存的登录信息损坏，请重新登录")?;
    validate(&saved.server, &saved.username, &saved.password, false)?;
    Ok(Some(saved))
}

struct PendingFile(PathBuf);
impl Drop for PendingFile {
    fn drop(&mut self) {
        // Only our own create_new temporary file, never the saved file or vault.
        let _ = fs::remove_file(&self.0);
    }
}

pub(super) fn persist(home: &Path, saved: &SavedAccount) -> Result<(), String> {
    validate(&saved.server, &saved.username, &saved.password, false)?;
    let path = location(home)?;
    checked_metadata(&path)?;
    let parent = path.parent().ok_or("登录信息目录无效")?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .map_err(|_| "无法设置登录信息目录权限")?;
    let raw = Zeroizing::new(serde_json::to_vec(saved).map_err(|_| "无法编码登录信息")?);
    let temp = parent.join(format!(
        ".account-{}-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时间无效")?
            .as_nanos(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|_| "无法创建本机登录信息文件")?;
    let pending = PendingFile(temp);
    file.write_all(&raw)
        .and_then(|()| file.sync_all())
        .map_err(|_| "本机登录信息保存失败")?;
    drop(file);
    fs::rename(&pending.0, &path).map_err(|_| "本机登录信息保存失败，原信息未替换")?;
    Ok(())
}

pub(super) fn clear_saved(home: &Path) -> Result<(), String> {
    let path = location(home)?;
    if checked_metadata(&path)?.is_some() {
        fs::remove_file(path).map_err(|_| "本机登录信息清除失败")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::AccountState;

    fn home() -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp")
            .join(format!(
                "local-account-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(root.join("core")).unwrap();
        root.join("core")
    }
    fn saved() -> SavedAccount {
        SavedAccount {
            server: "https://localhost:18443".into(),
            username: "alice".into(),
            password: "fixture-password-only".into(),
            auto_login: true,
        }
    }
    #[test]
    fn persists_across_state_reloads_without_keychain() {
        let home = home();
        assert!(read_saved(&home).unwrap().is_none());
        assert!(!AccountState::load(&home).info().has_password);
        persist(&home, &saved()).unwrap();
        let path = location(&home).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let loaded = read_saved(&home).unwrap().unwrap();
        assert_eq!(loaded.password, "fixture-password-only");
        let info = AccountState::load(&home).info();
        assert!(info.has_password && info.auto_login);
        assert!(!serde_json::to_string(&info)
            .unwrap()
            .contains("fixture-password-only"));
        assert!(fs::read_dir(path.parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
    }
    #[test]
    fn unremembering_removes_secret_and_forget_only_clears_this_profile() {
        let home = home();
        persist(&home, &saved()).unwrap();
        let mut account = saved();
        account.password.clear();
        account.auto_login = false;
        persist(&home, &account).unwrap();
        let bytes = fs::read(location(&home).unwrap()).unwrap();
        assert!(!String::from_utf8(bytes)
            .unwrap()
            .contains("fixture-password-only"));
        assert!(!AccountState::load(&home).info().has_password);
        assert_eq!(AccountState::load(&home).info().username, "alice");
        fs::write(home.join("identity-kept"), b"unchanged").unwrap();
        clear_saved(&home).unwrap();
        clear_saved(&home).unwrap();
        assert!(read_saved(&home).unwrap().is_none());
        assert_eq!(fs::read(home.join("identity-kept")).unwrap(), b"unchanged");
    }
    #[test]
    fn errors_are_explicit_and_paths_are_not_followed() {
        let home = home();
        persist(&home, &saved()).unwrap();
        let path = location(&home).unwrap();
        fs::write(&path, b"not json").unwrap();
        assert!(!AccountState::load(&home).info().storage_error.is_empty());
        persist(&home, &saved()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_saved(&home).is_err());
        assert!(persist(&home, &saved()).is_err());
        let linked_home = self::home();
        std::os::unix::fs::symlink(&path, location(&linked_home).unwrap()).unwrap();
        assert!(read_saved(&linked_home).is_err());
        assert!(persist(&linked_home, &saved()).is_err());
        assert!(clear_saved(&linked_home).is_err());
        assert!(path.exists());
    }
}
