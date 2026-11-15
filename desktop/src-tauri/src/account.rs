//! Credentials never cross the native bridge on reads. The entire saved profile
//! lives in the OS vault, not a JSON file or browser storage. No plaintext fallback.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "com.xun.cloud.test.account";
const USER: &str = "default";

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedAccount {
    server: String,
    username: String,
    password: String,
    auto_login: bool,
}
impl Drop for SavedAccount {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AccountInfo {
    pub server: String,
    pub username: String,
    pub has_password: bool,
    pub auto_login: bool,
    pub storage_error: String,
    pub loading: bool,
}

pub(super) struct AccountState {
    info: Mutex<AccountInfo>,
    pub operation: tokio::sync::Mutex<()>,
    automatic_attempted: AtomicBool,
}
impl AccountState {
    pub fn pending() -> Self {
        Self {
            info: Mutex::new(AccountInfo {
                loading: true,
                ..Default::default()
            }),
            operation: tokio::sync::Mutex::new(()),
            automatic_attempted: AtomicBool::new(false),
        }
    }
    pub fn load() -> Self {
        let info = match read_saved() {
            Ok(Some(saved)) => summary(&saved),
            Ok(None) => AccountInfo::default(),
            Err(error) => AccountInfo {
                storage_error: error,
                ..Default::default()
            },
        };
        Self {
            info: Mutex::new(info),
            operation: tokio::sync::Mutex::new(()),
            automatic_attempted: AtomicBool::new(false),
        }
    }
    pub fn info(&self) -> AccountInfo {
        self.info
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| AccountInfo {
                storage_error: "登录信息暂不可用".into(),
                ..Default::default()
            })
    }
    fn set(&self, info: AccountInfo) -> Result<(), String> {
        *self.info.lock().map_err(|_| "登录信息暂不可用")? = info;
        Ok(())
    }
    #[cfg(test)]
    pub fn empty() -> Self {
        Self {
            info: Mutex::new(AccountInfo::default()),
            operation: tokio::sync::Mutex::new(()),
            automatic_attempted: AtomicBool::new(false),
        }
    }
}
fn summary(saved: &SavedAccount) -> AccountInfo {
    AccountInfo {
        server: saved.server.clone(),
        username: saved.username.clone(),
        has_password: !saved.password.is_empty(),
        auto_login: saved.auto_login && !saved.password.is_empty(),
        storage_error: String::new(),
        loading: false,
    }
}

// Runs after the webview is created. A system authorization prompt must never
// block the app's setup/main thread or hide the file browser.
pub(super) async fn initialize(app: tauri::AppHandle) {
    use tauri::Manager;
    let core = app.state::<super::Core>();
    let _lock = core.account.operation.lock().await;
    let info = match tauri::async_runtime::spawn_blocking(AccountState::load).await {
        Ok(state) => state.info(),
        Err(_) => AccountInfo {
            storage_error: "登录信息读取未完成，请重试".into(),
            ..Default::default()
        },
    };
    let _ = core.account.set(info);
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, USER).map_err(|_| "无法访问系统凭据库；不会改用明文保存".into())
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn read_saved() -> Result<Option<SavedAccount>, String> {
    match entry()?.get_password() {
        Ok(raw) => {
            let raw = Zeroizing::new(raw);
            let saved: SavedAccount =
                serde_json::from_str(&raw).map_err(|_| "已保存的登录信息损坏，请重新登录")?;
            validate(&saved.server, &saved.username, &saved.password, false)?;
            Ok(Some(saved))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("系统凭据库不可用或访问被拒绝，请解锁后重试；不会改用明文保存".into()),
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn read_saved() -> Result<Option<SavedAccount>, String> {
    Ok(None)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn persist(saved: &SavedAccount) -> Result<(), String> {
    let raw = Zeroizing::new(serde_json::to_string(saved).map_err(|_| "无法编码登录信息")?);
    entry()?
        .set_password(&raw)
        .map_err(|_| "系统凭据库保存失败；之前保存的信息可能仍存在，请解锁凭据库后重试".into())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn persist(_: &SavedAccount) -> Result<(), String> {
    Err("此平台暂不支持安全保存登录信息；未保存密码".into())
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn clear_saved() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法清除系统凭据库中的登录信息，请解锁后重试".into()),
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn clear_saved() -> Result<(), String> {
    Ok(())
}

fn validate(
    server: &str,
    username: &str,
    password: &str,
    require_password: bool,
) -> Result<(), String> {
    if server.is_empty()
        || server.len() > 512
        || username.is_empty()
        || username.len() > 32
        || password.len() > 72
        || (require_password && password.is_empty())
    {
        return Err("请填写有效的服务器地址、账号和密码".into());
    }
    let url = if server.starts_with("https://") {
        server.to_owned()
    } else {
        format!("https://{server}")
    };
    let url = reqwest::Url::parse(&url).map_err(|_| "服务器地址无效")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("请输入 HTTPS 服务器地址，不要包含账号、路径或查询参数".into());
    }
    if !username
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("账号只能包含英文字母、数字、下划线和短横线".into());
    }
    Ok(())
}
async fn authenticate(
    core: &super::Core,
    server: &str,
    username: &str,
    password: &str,
) -> Result<Value, String> {
    validate(server, username, password, true)?;
    core.request(
        "cloud/join",
        Some(json!({"server": server, "username": username, "password": password})),
    )
    .await
}

#[tauri::command]
pub(super) async fn join_account(
    core: tauri::State<'_, super::Core>,
    server: String,
    username: String,
    password: String,
    remember_password: bool,
    auto_login: bool,
) -> Result<Value, String> {
    join_inner(
        &core,
        server,
        username,
        password,
        remember_password,
        auto_login,
    )
    .await
}
pub(super) async fn join_inner(
    core: &super::Core,
    server: String,
    username: String,
    password: String,
    remember_password: bool,
    auto_login: bool,
) -> Result<Value, String> {
    let _lock = core.account.operation.lock().await;
    let password = Zeroizing::new(password);
    if auto_login && !remember_password {
        return Err("自动登录需要先勾选记住密码".into());
    }
    let server = server.trim().trim_end_matches('/').to_string();
    let username = username.trim().to_string();
    let mut result = authenticate(core, &server, &username, &password).await?;
    let saved = SavedAccount {
        server,
        username,
        password: if remember_password {
            password.to_string()
        } else {
            String::new()
        },
        auto_login,
    };
    let mut info = summary(&saved);
    let stored = tauri::async_runtime::spawn_blocking(move || persist(&saved))
        .await
        .map_err(|_| "凭据库操作未完成")?;
    if let Err(warning) = stored {
        info.has_password = false;
        info.auto_login = false;
        info.storage_error = warning.clone();
        result["warning"] = Value::String(warning);
    }
    core.account.set(info)?;
    Ok(result)
}

#[tauri::command]
pub(super) async fn login_saved(
    core: tauri::State<'_, super::Core>,
    automatic: bool,
) -> Result<Value, String> {
    login_saved_inner(&core, automatic).await
}
pub(super) async fn login_saved_inner(
    core: &super::Core,
    automatic: bool,
) -> Result<Value, String> {
    let _lock = core.account.operation.lock().await;
    if automatic
        && core
            .account
            .automatic_attempted
            .swap(true, Ordering::SeqCst)
    {
        return Err("本次启动已尝试自动登录，请手动重试".into());
    }
    let info = core.account.info();
    if automatic && (!info.auto_login || !info.has_password || !info.storage_error.is_empty()) {
        return Err("未启用可用的自动登录".into());
    }
    let saved = tauri::async_runtime::spawn_blocking(read_saved)
        .await
        .map_err(|_| "凭据库操作未完成")??
        .ok_or("还没有保存登录信息")?;
    if saved.password.is_empty() {
        return Err("没有已保存的密码，请输入密码登录".into());
    }
    if automatic && !saved.auto_login {
        return Err("未启用自动登录".into());
    }
    let result = authenticate(core, &saved.server, &saved.username, &saved.password).await?;
    core.account.set(summary(&saved))?;
    Ok(result)
}

#[tauri::command]
pub(super) async fn forget_account(core: tauri::State<'_, super::Core>) -> Result<(), String> {
    let _lock = core.account.operation.lock().await;
    tauri::async_runtime::spawn_blocking(clear_saved)
        .await
        .map_err(|_| "凭据库操作未完成")??;
    core.account.set(AccountInfo::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn summary_does_not_expose_password() {
        let saved = SavedAccount {
            server: "https://localhost:443".into(),
            username: "alice".into(),
            password: "never-serialize-this".into(),
            auto_login: true,
        };
        let value = serde_json::to_string(&summary(&saved)).unwrap();
        assert!(!value.contains("never-serialize-this"));
        assert!(!value.contains("\"password\""));
        assert!(summary(&saved).auto_login);
        let no_secret = SavedAccount {
            server: String::new(),
            username: String::new(),
            password: String::new(),
            auto_login: true,
        };
        assert!(!summary(&no_secret).auto_login);
    }
    #[test]
    fn rejects_unsafe_login_inputs() {
        for server in [
            "http://host",
            "https://user:pass@host",
            "https://host/path",
            "https://host?key=value",
            "https://host#fragment",
        ] {
            assert!(
                validate(server, "alice", "password", true).is_err(),
                "{server}"
            );
        }
        assert!(validate("192.0.2.1:18443", "alice", "password", true).is_ok());
        assert!(validate("https://localhost:18443", "alice", "", true).is_err());
        assert!(validate("https://localhost:18443", "../alice", "password", true).is_err());
    }
}
