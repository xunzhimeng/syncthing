//! Read-only view of authorized cloud folders' sync indexes. No web-supplied
//! filesystem path is opened; only folder IDs already in the core configuration.
use super::Core;
use futures_util::{stream, StreamExt};
use serde::Serialize;
use serde_json::Value;

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
fn valid_relative(path: &str) -> bool {
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

#[tauri::command]
pub(super) async fn list_files(
    core: tauri::State<'_, Core>,
    id: String,
    path: String,
    offset: usize,
) -> Result<FilePage, String> {
    list_inner(&core, &id, &path, offset).await
}
pub(super) async fn list_inner(
    core: &Core,
    id: &str,
    path: &str,
    offset: usize,
) -> Result<FilePage, String> {
    if !valid_relative(path) || offset > MAX_ENTRIES {
        return Err("无效的目录或分页位置".into());
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
    // Names from a remote device are untrusted too. Never construct a traversal
    // or permit entering symbolic links (the UI only navigates directories).
    tree.retain(|f| {
        f["name"]
            .as_str()
            .is_some_and(|n| !n.contains('/') && valid_relative(n) && !n.is_empty())
    });
    tree.sort_by(|a, b| {
        let ad = a["type"]
            .as_str()
            .unwrap_or_default()
            .ends_with("_DIRECTORY");
        let bd = b["type"]
            .as_str()
            .unwrap_or_default()
            .ends_with("_DIRECTORY");
        bd.cmp(&ad).then_with(|| {
            a["name"]
                .as_str()
                .unwrap_or_default()
                .cmp(b["name"].as_str().unwrap_or_default())
        })
    });
    let total = tree.len();
    let end = offset.saturating_add(PAGE_SIZE).min(total);
    let rows = tree.into_iter().skip(offset).take(PAGE_SIZE);
    let entries = stream::iter(rows.map(|f| {
        let peers = &peers;
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
            let status = match info {
                Ok(info) => file_status(&info, &relative, peers, connected, paused),
                Err(_) => "unknown",
            };
            FileEntry {
                name,
                path: relative,
                kind: kind.into(),
                size: f["size"].as_u64().unwrap_or(0),
                modified: f["modTime"].as_str().unwrap_or_default().into(),
                status: status.into(),
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
