#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, State};

mod account;
mod activity;
mod files;
use account::{forget_account, join_account, login_saved};
use activity::sync_activity;
use files::{list_files, reveal_file};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bridge {
    gui_url: String,
    api_key: String,
    cert_file: String,
}
struct Core {
    _instance_lock: Option<fs::File>,
    child: Mutex<Option<Child>>,
    http: reqwest::Client,
    bridge: Bridge,
    home: PathBuf,
    ca_fingerprint: String,
    server_hint: String,
    account: account::AccountState,
}
impl Core {
    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut c) = child.take() {
                if !matches!(c.try_wait(), Ok(None)) {
                    return;
                }
                let cert_path = self.bridge.cert_file.clone();
                let api = self.bridge.api_key.clone();
                let url = format!("{}/rest/system/shutdown", self.bridge.gui_url);
                // Blocking HTTP runs on its own thread, never inside a Tokio runtime.
                let _ = std::thread::spawn(move || {
                    if let Ok(pem) = fs::read(cert_path) {
                        if let Ok(cert) = reqwest::Certificate::from_pem(&pem) {
                            if let Ok(http) = reqwest::blocking::Client::builder()
                                .no_proxy()
                                .redirect(reqwest::redirect::Policy::none())
                                .tls_built_in_root_certs(false)
                                .add_root_certificate(cert)
                                .timeout(Duration::from_secs(3))
                                .build()
                            {
                                let _ = http.post(url).header("X-API-Key", api).send();
                            }
                        }
                    }
                })
                .join();
                for _ in 0..50 {
                    if matches!(c.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
    async fn request(&self, endpoint: &str, body: Option<Value>) -> Result<Value, String> {
        let url = format!("{}/rest/{}", self.bridge.gui_url, endpoint);
        let mut req = match body {
            Some(b) => self.http.post(url).json(&b),
            None => self.http.get(url),
        };
        req = req.header("X-API-Key", &self.bridge.api_key);
        let mut response = req
            .send()
            .await
            .map_err(|_| "无法连接本机内核，请稍后重试；详情见 core.log".to_string())?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|len| len > 16 * 1024 * 1024)
        {
            return Err("本机响应过大，请缩小查询范围".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "本机响应读取失败".to_string())?
        {
            if bytes.len().saturating_add(chunk.len()) > 16 * 1024 * 1024 {
                return Err("本机响应过大，请缩小查询范围".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            return Err(String::from_utf8_lossy(&bytes).chars().take(500).collect());
        }
        serde_json::from_slice(&bytes).map_err(|_| "本机响应不是有效 JSON".to_string())
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        self.stop()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Folder {
    id: String,
    label: String,
    path: String,
    state: String,
    need_bytes: u64,
    need_items: u64,
    local_files: u64,
    global_files: u64,
    global_bytes: u64,
    errors: u64,
    error: String,
    connected: bool,
    paused: bool,
    remote_need_items: Option<u64>,
    remote_need_bytes: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    platform: String,
    home: String,
    version: String,
    connected: bool,
    ca_fingerprint: String,
    server_hint: String,
    account: account::AccountInfo,
    folders: Vec<Folder>,
}

#[tauri::command]
async fn snapshot(core: State<'_, Core>) -> Result<Snapshot, String> {
    snapshot_inner(&core).await
}

async fn snapshot_inner(core: &Core) -> Result<Snapshot, String> {
    let version = core.request("system/version", None).await?;
    let folders = core.request("config/folders", None).await?;
    let connections = core.request("system/connections", None).await?;
    let connected = connections["connections"]
        .as_object()
        .map(|c| c.values().any(|v| v["connected"] == true))
        .unwrap_or(false);
    let mut result = Vec::new();
    for f in folders.as_array().ok_or("文件夹响应无效")? {
        let id = f["id"].as_str().unwrap_or_default();
        if !files::valid_id(id) {
            continue;
        }
        let status = match core.request(&format!("db/status?folder={id}"), None).await {
            Ok(value) => value,
            Err(_) => json!({"state":"unknown", "error":"状态读取失败，请刷新或查看 core.log"}),
        };
        let peers: Vec<&str> = f["devices"]
            .as_array()
            .map(|ds| {
                ds.iter()
                    .filter_map(|d| d["deviceID"].as_str())
                    .filter(|d| connections["connections"][*d]["connected"] == true)
                    .collect()
            })
            .unwrap_or_default();
        let mut remote_need_items = Some(0);
        let mut remote_need_bytes = Some(0);
        if peers.is_empty() {
            remote_need_items = None;
            remote_need_bytes = None;
        }
        for peer in &peers {
            let completion = core
                .request(
                    &files::query("db/completion", &[("folder", id), ("device", peer)]),
                    None,
                )
                .await;
            match completion {
                Ok(c) if c["remoteState"] == "valid" => {
                    remote_need_items = remote_need_items
                        .zip(
                            c["needItems"]
                                .as_u64()
                                .zip(c["needDeletes"].as_u64())
                                .map(|(items, deletes)| items + deletes),
                        )
                        .map(|(a, b)| a + b);
                    remote_need_bytes = remote_need_bytes
                        .zip(c["needBytes"].as_u64())
                        .map(|(a, b)| a + b);
                }
                _ => {
                    remote_need_items = None;
                    remote_need_bytes = None;
                }
            }
        }
        result.push(Folder {
            id: id.into(),
            label: f["label"].as_str().unwrap_or(id).into(),
            path: f["path"].as_str().unwrap_or_default().into(),
            state: status["state"].as_str().unwrap_or("unknown").into(),
            need_bytes: status["needBytes"].as_u64().unwrap_or(0),
            need_items: status["needTotalItems"].as_u64().unwrap_or(0),
            local_files: status["localFiles"].as_u64().unwrap_or(0),
            global_files: status["globalFiles"].as_u64().unwrap_or(0),
            global_bytes: status["globalBytes"].as_u64().unwrap_or(0),
            errors: status["errors"]
                .as_u64()
                .or(status["pullErrors"].as_u64())
                .unwrap_or(0),
            error: status["error"].as_str().unwrap_or_default().into(),
            connected: !peers.is_empty(),
            paused: f["paused"] == true,
            remote_need_items,
            remote_need_bytes,
        });
    }
    Ok(Snapshot {
        platform: std::env::consts::OS.into(),
        home: core.home.display().to_string(),
        version: version["longVersion"]
            .as_str()
            .or(version["version"].as_str())
            .unwrap_or("unknown")
            .into(),
        connected,
        ca_fingerprint: core.ca_fingerprint.clone(),
        server_hint: core.server_hint.clone(),
        account: core.account.info(),
        folders: result,
    })
}
#[tauri::command]
async fn open_folder(core: State<'_, Core>, id: String) -> Result<(), String> {
    files::reveal_inner(&core, &id, "").await
}
fn hidden(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = cmd;
}
fn private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn clean_env(cmd: &mut Command) {
    for (k, _) in std::env::vars() {
        if k.starts_with("ST") || k.starts_with("XUNCLOUD_") {
            cmd.env_remove(k);
        }
    }
}
fn start(app: &tauri::App) -> Result<Core, Box<dyn std::error::Error>> {
    let resource = app.path().resource_dir()?.join("resources");
    let binary = resource.join(if cfg!(windows) {
        "syncthing.exe"
    } else {
        "syncthing"
    });
    let app_data = app.path().app_data_dir()?;
    private_dir(&app_data)?;
    let instance_lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(app_data.join("desktop.lock"))?;
    instance_lock
        .try_lock()
        .map_err(|_| "小寻云同步已在运行，不能重复启动")?;
    let home = app_data.join("core");
    private_dir(&home)?;
    let sync_root = app.path().home_dir()?.join("XunCloud-Test");
    let mut init = Command::new(&binary);
    hidden(&mut init);
    clean_env(&mut init);
    let output = init
        .arg("--home")
        .arg(&home)
        .args(["cloud", "init-desktop", "--sync-root"])
        .arg(sync_root)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "初始化独立内核失败：{}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    let bridge: Bridge = serde_json::from_slice(&output.stdout)?;
    let parsed = reqwest::Url::parse(&bridge.gui_url)?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
    {
        return Err("拒绝非回环内核地址".into());
    }
    let certificate = fs::read(&bridge.cert_file)?;
    let http = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .tls_built_in_root_certs(false)
        .add_root_certificate(reqwest::Certificate::from_pem(&certificate)?)
        .timeout(Duration::from_secs(35))
        .build()?;
    let ca = resource.join("ca.pem");
    let fingerprint = if ca.exists() {
        format!("{:x}", Sha256::digest(fs::read(&ca)?))
    } else {
        String::new()
    };
    let hint = fs::read_to_string(resource.join("server.txt"))
        .unwrap_or_default()
        .trim()
        .to_string();
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("core.log"))?;
    let mut cmd = Command::new(binary);
    hidden(&mut cmd);
    clean_env(&mut cmd);
    cmd.arg("--home")
        .arg(&home)
        .args(["serve", "--no-browser", "--no-restart", "--no-upgrade"]);
    cmd.env("STMONITORED", "1");
    if ca.exists() {
        cmd.env("XUNCLOUD_CA_FILE", ca);
    }
    let child = cmd
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .spawn()?;
    Ok(Core {
        _instance_lock: Some(instance_lock),
        child: Mutex::new(Some(child)),
        http,
        bridge,
        home,
        ca_fingerprint: fingerprint,
        server_hint: hint,
        account: account::AccountState::pending(),
    })
}
fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let core = start(app)?;
            app.manage(core);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(account::initialize(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            join_account,
            login_saved,
            forget_account,
            list_files,
            sync_activity,
            reveal_file,
            open_folder
        ])
        .build(tauri::generate_context!())
        .expect("XunCloud initialization failed");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<Core>().stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn response_does_not_include_management_credentials() {
        let result = Snapshot {
            platform: "macos".into(),
            home: "test".into(),
            version: "test".into(),
            connected: false,
            ca_fingerprint: "public".into(),
            server_hint: "localhost".into(),
            account: account::AccountInfo::default(),
            folders: Vec::new(),
        };
        let value = serde_json::to_value(result).unwrap();
        assert!(value.get("apiKey").is_none());
        assert!(value.get("password").is_none());
    }
    // Explicit opt-in smoke check against ONLY the installed test profile.
    // No automatic credentials discovery and no production-profile fallback.
    #[test]
    #[ignore = "requires a running isolated desktop test profile"]
    fn installed_native_https_bridge() {
        let binary = std::env::var_os("XUNCLOUD_TEST_BINARY").expect("explicit test binary");
        let home = PathBuf::from(
            std::env::var_os("XUNCLOUD_TEST_PROFILE").expect("explicit test profile"),
        );
        assert_eq!(
            fs::read_to_string(home.join(".xun-cloud-desktop")).unwrap(),
            "xun-cloud-isolated-desktop-v1\n"
        );
        let mut cmd = Command::new(binary);
        clean_env(&mut cmd);
        let out = cmd
            .arg("--home")
            .arg(&home)
            .args(["cloud", "init-desktop", "--sync-root"])
            .arg(home.parent().unwrap().join("unused-root"))
            .output()
            .unwrap();
        assert!(out.status.success());
        let bridge: Bridge = serde_json::from_slice(&out.stdout).unwrap();
        let parsed = reqwest::Url::parse(&bridge.gui_url).unwrap();
        assert_eq!(parsed.host_str(), Some("127.0.0.1"));
        assert_eq!(parsed.scheme(), "https");
        let cert = reqwest::Certificate::from_pem(&fs::read(&bridge.cert_file).unwrap()).unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .tls_built_in_root_certs(false)
            .add_root_certificate(cert)
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap();
        let core = Core {
            _instance_lock: None,
            child: Mutex::new(None),
            http: client,
            bridge,
            home,
            ca_fingerprint: String::new(),
            server_hint: String::new(),
            account: account::AccountState::empty(),
        };
        tauri::async_runtime::block_on(async {
            let mut core = core;
            let status = snapshot_inner(&core)
                .await
                .expect("Rust TLS + native snapshot must succeed");
            assert!(status.connected);
            assert!(!status.folders.is_empty());
            let first = &status.folders[0];
            let page = files::list_inner(&core, &first.id, "", 0, &files::ListOptions::default())
                .await
                .expect("live root browse");
            let page_value = serde_json::to_value(&page).unwrap();
            assert!(page_value["total"].as_u64().unwrap() > 0);
            for row in page_value["entries"].as_array().unwrap() {
                if row["kind"] == "directory" {
                    files::list_inner(
                        &core,
                        &first.id,
                        row["path"].as_str().unwrap(),
                        0,
                        &files::ListOptions::default(),
                    )
                    .await
                    .expect("live subdirectory");
                }
            }
            assert!(
                files::list_inner(&core, "default", "", 0, &files::ListOptions::default())
                    .await
                    .is_err()
            );
            assert!(files::list_inner(
                &core,
                &first.id,
                "../outside",
                0,
                &files::ListOptions::default()
            )
            .await
            .is_err());
            let activity = activity::activity_inner(&core, &first.id, 1)
                .await
                .expect("real queue read");
            let root = PathBuf::from(&first.path);
            for row in page_value["entries"].as_array().unwrap() {
                if row["localAvailable"] == true {
                    assert!(files::contained_path(&root, row["path"].as_str().unwrap()).is_ok());
                }
            }
            if let Some(output) = std::env::var_os("XUNCLOUD_TEST_REPORT") {
                fs::write(
                    output,
                    serde_json::to_vec_pretty(
                        &json!({"snapshot": status, "files":page_value, "activity":activity}),
                    )
                    .unwrap(),
                )
                .unwrap();
            }
            if let Some(credentials) = std::env::var_os("XUNCLOUD_TEST_CREDENTIALS") {
                assert_eq!(std::env::var("XUNCLOUD_TEST_SAVE_ACCOUNT").unwrap(), "1");
                #[cfg(target_os = "macos")]
                {
                    // Test persistence in an explicit scratch profile, not the installed
                    // user's account file and never the old Keychain entry.
                    let account_home = PathBuf::from(
                        std::env::var_os("XUNCLOUD_TEST_ACCOUNT_HOME")
                            .expect("explicit scratch account home"),
                    );
                    let scratch = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../tmp")
                        .canonicalize()
                        .unwrap();
                    assert!(account_home.is_absolute());
                    assert!(account_home
                        .parent()
                        .unwrap()
                        .canonicalize()
                        .unwrap()
                        .starts_with(scratch));
                    private_dir(&account_home).unwrap();
                    core.home = account_home.join("core");
                    private_dir(&core.home).unwrap();
                }
                let mut credentials: Value =
                    serde_json::from_slice(&fs::read(credentials).unwrap()).unwrap();
                let password = credentials["password"].take().as_str().unwrap().to_owned();
                let result = account::join_inner(
                    &core,
                    credentials["server"].as_str().unwrap().into(),
                    credentials["username"].as_str().unwrap().into(),
                    password,
                    true,
                    true,
                )
                .await
                .expect("account login + platform account storage");
                assert!(
                    result.get("warning").is_none(),
                    "account save did not succeed"
                );
                assert!(core.account.info().has_password);
                // Recreate state to verify persistence across an app restart.
                core.account = account::AccountState::load(&core.home);
                assert!(core.account.info().auto_login);
                let wrong = account::join_inner(
                    &core,
                    credentials["server"].as_str().unwrap().into(),
                    credentials["username"].as_str().unwrap().into(),
                    "invalid-password-for-rejection-check".into(),
                    true,
                    true,
                )
                .await;
                assert!(wrong.is_err(), "wrong password must not be accepted");
                assert!(
                    core.account.info().auto_login,
                    "failed login must preserve saved profile"
                );
                let restored = account::login_saved_inner(&core, true)
                    .await
                    .expect("automatic saved login");
                assert!(restored.get("path").is_some());
                assert!(account::login_saved_inner(&core, true).await.is_err());
                println!("PASS platform account save/reload + automatic login + one-attempt bound; no secrets returned");
            }
            println!(
                "PASS installed Rust HTTPS bridge + real file listing: {} authorized folder(s), server connected",
                status.folders.len()
            );
        });
    }
}
