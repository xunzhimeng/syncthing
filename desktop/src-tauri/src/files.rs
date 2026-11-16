//! Read-only view of authorized cloud folders' sync indexes. No web-supplied
//! filesystem path is opened; only folder IDs already in the core configuration.
use super::Core;
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const PAGE_SIZE: usize = 100;
const MAX_ENTRIES: usize = 20_000;

pub(super) fn valid_id(id: &str) -> bool {
    id.starts_with("xc-")
        && id.len() <= 128
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
pub(super) fn query(endpoint: &str, pairs: &[(&str, &str)]) -> String {
    let mut serializer = reqwest::Url::parse("https://localhost/").unwrap();
    serializer
        .query_pairs_mut()
        .extend_pairs(pairs.iter().copied());
    format!("{endpoint}?{}", serializer.query().unwrap_or_default())
}
pub(super) fn valid_relative(path: &str) -> bool {
    path.len() <= 4096
        && !path.contains(['\\', ':', '\0'])
        && !path.chars().any(char::is_control)
        && (path.is_empty()
            || path
                .split('/')
                .all(|c| !c.is_empty() && c != "." && c != ".."))
}
pub(super) async fn authorized_folder(core: &Core, id: &str) -> Result<Value, String> {
    if !valid_id(id) {
        return Err("没有该同步目录".into());
    }
    let folders = core.request("config/folders", None).await?;
    folders
        .as_array()
        .ok_or("文件夹响应无效")?
        .iter()
        .find(|f| f["id"] == id)
        .cloned()
        .ok_or("没有该同步目录".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileEntry {
    name: String,
    path: String,
    kind: String,
    size: u64,
    modified: String,
    status: String,
    local_available: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FilePage {
    folder_id: String,
    path: String,
    entries: Vec<FileEntry>,
    total: usize,
    next_offset: Option<usize>,
    warning: String,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum SortBy {
    #[default]
    Name,
    Size,
    Modified,
}
#[derive(Default)]
pub(super) struct ListOptions {
    pub filter: String,
    pub sort_by: SortBy,
    pub descending: bool,
}

#[tauri::command]
pub(super) async fn list_files(
    core: tauri::State<'_, Core>,
    id: String,
    path: String,
    offset: usize,
    filter: Option<String>,
    sort_by: Option<SortBy>,
    descending: Option<bool>,
) -> Result<FilePage, String> {
    list_inner(
        &core,
        &id,
        &path,
        offset,
        &ListOptions {
            filter: filter.unwrap_or_default(),
            sort_by: sort_by.unwrap_or_default(),
            descending: descending.unwrap_or(false),
        },
    )
    .await
}
pub(super) async fn list_inner(
    core: &Core,
    id: &str,
    path: &str,
    offset: usize,
    options: &ListOptions,
) -> Result<FilePage, String> {
    if !valid_relative(path) || offset > MAX_ENTRIES || options.filter.len() > 512 {
        return Err("无效的目录、筛选条件或分页位置".into());
    }
    let folder = authorized_folder(core, id).await?;
    let connections = core.request("system/connections", None).await?;
    let peers: Vec<String> = folder["devices"]
        .as_array()
        .ok_or("文件夹设备响应无效")?
        .iter()
        .filter_map(|d| d["deviceID"].as_str().map(str::to_owned))
        .collect();
    let connected = peers
        .iter()
        .any(|p| connections["connections"][p]["connected"] == true);
    let paused = folder["paused"] == true;
    let result = core
        .request(
            &query(
                "db/browse",
                &[("folder", id), ("prefix", path), ("levels", "0")],
            ),
            None,
        )
        .await?;
    let mut tree = result.as_array().ok_or("文件列表响应无效")?.clone();
    if tree.len() > MAX_ENTRIES {
        return Err("当前目录超过 20,000 项，请在系统文件管理器中查看".into());
    }
    filter_and_sort(&mut tree, options);
    let root = PathBuf::from(folder["path"].as_str().ok_or("同步目录路径无效")?);
    let total = tree.len();
    let end = offset.saturating_add(PAGE_SIZE).min(total);
    let rows = tree.into_iter().skip(offset).take(PAGE_SIZE);
    let entries = stream::iter(rows.map(|f| {
        let peers = &peers;
        let root = &root;
        async move {
            let name = f["name"].as_str().unwrap_or_default().to_owned();
            let relative = if path.is_empty() {
                name.clone()
            } else {
                format!("{path}/{name}")
            };
            let kind = match f["type"].as_str().unwrap_or_default() {
                "FILE_INFO_TYPE_DIRECTORY" => "directory",
                "FILE_INFO_TYPE_FILE" => "file",
                _ => "symlink",
            };
            let info = core
                .request(
                    &query("db/file", &[("folder", id), ("file", &relative)]),
                    None,
                )
                .await;
            let status = match &info {
                Ok(info) => file_status(info, &relative, peers, connected, paused),
                Err(_) => "unknown",
            };
            let local_available = kind != "symlink"
                && info.as_ref().is_ok_and(|v| {
                    v["local"]["name"]
                        .as_str()
                        .is_some_and(|n| n.replace('\\', "/") == relative)
                        && v["local"]["deleted"] == false
                })
                && contained_path(root, &relative).is_ok();
            FileEntry {
                name,
                path: relative,
                kind: kind.into(),
                size: f["size"].as_u64().unwrap_or(0),
                modified: f["modTime"].as_str().unwrap_or_default().into(),
                status: status.into(),
                local_available,
            }
        }
    }))
    .buffered(8)
    .collect()
    .await;
    Ok(FilePage {
        folder_id: id.into(),
        path: path.into(),
        entries,
        total,
        next_offset: if end < total { Some(end) } else { None },
        warning: if paused {
            "此目录已暂停同步".into()
        } else if !connected {
            "服务器未连接，显示本机最后一次索引状态".into()
        } else {
            String::new()
        },
    })
}

fn filter_and_sort(tree: &mut Vec<Value>, options: &ListOptions) {
    let filter = options.filter.trim().to_lowercase();
    tree.retain(|f| {
        f["name"].as_str().is_some_and(|n| {
            !n.contains('/')
                && valid_relative(n)
                && !n.is_empty()
                && n.to_lowercase().contains(&filter)
        })
    });
    tree.sort_by(|a, b| {
        let ad = a["type"] == "FILE_INFO_TYPE_DIRECTORY";
        let bd = b["type"] == "FILE_INFO_TYPE_DIRECTORY";
        bd.cmp(&ad).then_with(|| {
            let name = || {
                a["name"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(b["name"].as_str().unwrap_or_default())
            };
            let order = match options.sort_by {
                SortBy::Name => name(),
                SortBy::Size => a["size"].as_u64().cmp(&b["size"].as_u64()).then_with(name),
                SortBy::Modified => parsed_time(a).cmp(&parsed_time(b)).then_with(name),
            };
            if options.descending {
                order.reverse()
            } else {
                order
            }
        })
    });
}

fn parsed_time(value: &Value) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(
        value["modTime"].as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        metadata.file_type().is_symlink()
    }
}

// This is deliberately stricter than a plain canonicalize/starts_with check:
// reject links/junctions at every component, even if they resolve inside root.
// Nothing from this method is executed; only directories/the OS reveal UI open.
pub(super) fn contained_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if !root.is_absolute() || !valid_relative(relative) {
        return Err("路径不在同步目录内".into());
    }
    let root_meta = fs::symlink_metadata(root).map_err(|_| "同步目录尚未创建或不可访问")?;
    if is_link(&root_meta) || !root_meta.is_dir() {
        return Err("不能打开链接目录".into());
    }
    let base = root.canonicalize().map_err(|_| "同步目录不可访问")?;
    let mut path = base.clone();
    for part in relative.split('/').filter(|p| !p.is_empty()) {
        if [".stfolder", ".stignore", ".stversions"].contains(&part) {
            return Err("不能打开同步内部文件".into());
        }
        path.push(part);
        let metadata = fs::symlink_metadata(&path).map_err(|_| "文件尚未下载到本机或不可访问")?;
        if is_link(&metadata) {
            return Err("不能打开符号链接或重解析点".into());
        }
        if !metadata.is_file() && !metadata.is_dir() {
            return Err("不支持此文件类型".into());
        }
    }
    let actual = path.canonicalize().map_err(|_| "文件不可访问")?;
    if !actual.starts_with(&base) {
        return Err("路径不在同步目录内".into());
    }
    Ok(actual)
}

#[tauri::command]
pub(super) async fn reveal_file(
    core: tauri::State<'_, Core>,
    id: String,
    path: String,
) -> Result<(), String> {
    reveal_inner(&core, &id, &path).await
}
pub(super) async fn reveal_inner(core: &Core, id: &str, path: &str) -> Result<(), String> {
    if !valid_relative(path) {
        return Err("目录路径无效".into());
    }
    let folder = authorized_folder(core, id).await?;
    if !path.is_empty() {
        let info = core
            .request(&query("db/file", &[("folder", id), ("file", path)]), None)
            .await?;
        if info["local"]["name"]
            .as_str()
            .map(|n| n.replace('\\', "/"))
            .as_deref()
            != Some(path)
            || info["local"]["deleted"] != false
            || !["FILE_INFO_TYPE_FILE", "FILE_INFO_TYPE_DIRECTORY"]
                .contains(&info["local"]["type"].as_str().unwrap_or_default())
        {
            return Err("文件尚未下载到本机或不支持打开".into());
        }
    }
    let root = PathBuf::from(folder["path"].as_str().ok_or("同步目录路径无效")?);
    let relative = path.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let target = contained_path(&root, &relative)?;
        let mut cmd = reveal_command(&target)?;
        // Never invoke a shell and never launch a synced file itself.
        cmd.spawn()
            .map_err(|_| "无法在系统文件管理器中显示".to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "系统文件管理器操作失败".to_string())?
}

fn reveal_command(target: &Path) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("/usr/bin/open");
        // Always reveal, including directories: a synced .app is a directory
        // but a default `open` would launch it. -R only selects in Finder.
        cmd.arg("-R").arg(target);
        Ok(cmd)
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer.exe");
        cmd.arg(format!("/select,{}", target.display()));
        Ok(cmd)
    }
    #[cfg(target_os = "linux")]
    {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(if target.is_file() {
            target.parent().ok_or("文件目录无效")?
        } else {
            target
        });
        Ok(cmd)
    }
}

fn file_status(
    info: &Value,
    path: &str,
    peers: &[String],
    connected: bool,
    paused: bool,
) -> &'static str {
    if paused {
        return "paused";
    }
    let local = &info["local"];
    let global = &info["global"];
    if local["ignored"] == true {
        return "ignored";
    }
    if local["invalid"] == true || global["invalid"] == true {
        return "error";
    }
    if local["mustRescan"] == true {
        return "scanning";
    }
    if global["name"]
        .as_str()
        .map(|n| n.replace('\\', "/"))
        .as_deref()
        != Some(path)
        || global["version"].as_array().is_none_or(|v| v.is_empty())
    {
        return "unknown";
    }
    if local["name"]
        .as_str()
        .map(|n| n.replace('\\', "/"))
        .as_deref()
        != Some(path)
        || local["deleted"] == true
        || local["version"] != global["version"]
    {
        return if connected {
            "downloading"
        } else {
            "offline_pending"
        };
    }
    if global["deleted"] == true {
        return "pending_delete";
    }
    // Directories' own metadata does not prove all descendants are synced.
    if global["type"] == "FILE_INFO_TYPE_DIRECTORY" {
        return "directory";
    }
    if !connected {
        return "local_current";
    }
    let remote_has_file = info["availability"].as_array().is_some_and(|items| {
        items.iter().any(|i| {
            i["fromTemporary"] == false
                && i["id"]
                    .as_str()
                    .is_some_and(|id| peers.iter().any(|p| p == id))
        })
    });
    if remote_has_file {
        "synced"
    } else {
        "uploading"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn boundaries_and_query_encoding() {
        for path in [
            "/etc", "../x", "a/../x", "a//b", "a/", "C:\\x", "a\\b", "a\0b", "./x",
        ] {
            assert!(!valid_relative(path), "{path}");
        }
        for path in ["", "中文/Hello # &%.txt", "a/b"] {
            assert!(valid_relative(path));
        }
        assert!(valid_id("xc-123"));
        for id in ["default", "xc-1&folder=default", "xc-../etc"] {
            assert!(!valid_id(id));
        }
        let q = query("db/file", &[("file", "中文/a &b#c")]);
        assert!(q.contains("%26"));
        assert!(q.contains("%23"));
        assert!(!q.contains("&b"));
    }
    #[test]
    fn filtering_and_sorting_happen_before_paging() {
        let mut entries = vec![
            json!({"name":"b.txt","size":2,"type":"FILE_INFO_TYPE_FILE"}),
            json!({"name":"z-folder","size":0,"type":"FILE_INFO_TYPE_DIRECTORY"}),
            json!({"name":"a.txt","size":10,"type":"FILE_INFO_TYPE_FILE"}),
            json!({"name":"../escape","size":9,"type":"FILE_INFO_TYPE_FILE"}),
        ];
        filter_and_sort(
            &mut entries,
            &ListOptions {
                filter: String::new(),
                sort_by: SortBy::Size,
                descending: true,
            },
        );
        assert_eq!(
            entries
                .iter()
                .map(|e| e["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["z-folder", "a.txt", "b.txt"]
        );
        filter_and_sort(
            &mut entries,
            &ListOptions {
                filter: "A.TXT".into(),
                ..Default::default()
            },
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "a.txt");
    }
    #[test]
    fn modification_times_sort_by_instant_not_string() {
        let mut rows = vec![
            json!({"name":"fraction", "modTime":"2026-11-16T11:00:00.5Z"}),
            json!({"name":"whole", "modTime":"2026-11-16T11:00:00Z"}),
            json!({"name":"offset", "modTime":"2026-11-16T18:59:59+08:00"}),
        ];
        filter_and_sort(
            &mut rows,
            &ListOptions {
                sort_by: SortBy::Modified,
                ..Default::default()
            },
        );
        assert_eq!(
            rows.iter()
                .map(|r| r["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["offset", "whole", "fraction"]
        );
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn app_bundles_and_scripts_are_only_revealed() {
        for path in [
            "/safe/untrusted.app",
            "/safe/run.command",
            "/safe/directory",
        ] {
            let cmd = reveal_command(Path::new(path)).unwrap();
            assert_eq!(cmd.get_program(), "/usr/bin/open");
            assert_eq!(
                cmd.get_args().collect::<Vec<_>>(),
                vec![std::ffi::OsStr::new("-R"), std::ffi::OsStr::new(path)]
            );
        }
    }
    #[test]
    fn local_reveal_is_confined_and_does_not_follow_links() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp")
            .join(format!(
                "reveal-paths-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/a # &.txt"), b"local test").unwrap();
        let expected = root.join("nested/a # &.txt").canonicalize().unwrap();
        assert_eq!(contained_path(&root, "nested/a # &.txt").unwrap(), expected);
        assert!(contained_path(&root, "").unwrap().is_dir());
        for path in [
            "../outside",
            "/etc/passwd",
            "nested/../../x",
            "missing",
            ".stfolder/internal",
            "nested/./a",
        ] {
            assert!(contained_path(&root, path).is_err(), "{path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("nested"), root.join("link")).unwrap();
            assert!(contained_path(&root, "link/a # &.txt").is_err());
            assert!(contained_path(&root.join("link"), "").is_err());
        }
    }
    #[test]
    fn never_claim_synced_from_idle_or_size_alone() {
        let peers = vec!["server".into()];
        let mut info = json!({"local":{"name":"a","version":["v1"]},"global":{"name":"a","version":["v1"]},"availability":[{"id":"server","fromTemporary":false}]});
        assert_eq!(file_status(&info, "a", &peers, true, false), "synced");
        assert_eq!(
            file_status(&info, "a", &peers, false, false),
            "local_current"
        );
        assert_eq!(file_status(&info, "a", &peers, true, true), "paused");
        info["availability"][0]["fromTemporary"] = json!(true);
        assert_eq!(file_status(&info, "a", &peers, true, false), "uploading");
        info["local"]["version"] = json!(["v0"]);
        assert_eq!(file_status(&info, "a", &peers, true, false), "downloading");
        info["local"]["ignored"] = json!(true);
        assert_eq!(file_status(&info, "a", &peers, true, false), "ignored");
        assert_eq!(file_status(&json!({}), "a", &peers, true, false), "unknown");
        let windows = json!({"local":{"name":"nested\\file.bin","version":["v1"]},"global":{"name":"nested\\file.bin","version":["v1"]},"availability":[{"id":"server","fromTemporary":false}]});
        assert_eq!(
            file_status(&windows, "nested/file.bin", &peers, true, false),
            "synced"
        );
    }
}
