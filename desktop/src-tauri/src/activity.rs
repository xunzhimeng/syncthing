//! Read-only per-space work queue. No invented progress, speed, or history.
use super::{
    files::{authorized_folder, query, valid_relative},
    Core,
};
use futures_util::{stream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

const PAGE_SIZE: usize = 100;
const MAX_PEERS: usize = 32;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActivityEntry {
    name: String,
    path: String,
    kind: String,
    size: u64,
    direction: String,
    status: String,
    deleted: bool,
    error: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActivityPage {
    folder_id: String,
    page: usize,
    entries: Vec<ActivityEntry>,
    has_more: bool,
    warnings: Vec<String>,
}

#[tauri::command]
pub(super) async fn sync_activity(
    core: tauri::State<'_, Core>,
    id: String,
    page: usize,
) -> Result<ActivityPage, String> {
    activity_inner(&core, &id, page).await
}

fn rows<'a>(value: &'a Value, field: &str) -> Result<&'a [Value], String> {
    match &value[field] {
        Value::Array(items) => Ok(items),
        Value::Null if value.get(field).is_some() => Ok(&[]),
        _ => Err("同步队列响应不完整".into()),
    }
}
fn entry(
    value: &Value,
    direction: &str,
    state: &str,
    paused: bool,
    connected: bool,
) -> Option<ActivityEntry> {
    let path = value["name"].as_str()?.replace('\\', "/");
    if path.is_empty() || !valid_relative(&path) {
        return None;
    }
    let status = if paused {
        "paused"
    } else if !connected {
        "offline"
    } else {
        state
    };
    Some(ActivityEntry {
        name: path.rsplit('/').next()?.to_owned(),
        path,
        kind: match value["type"].as_str().unwrap_or_default() {
            "FILE_INFO_TYPE_DIRECTORY" => "directory",
            "FILE_INFO_TYPE_FILE" => "file",
            _ => "symlink",
        }
        .into(),
        size: value["size"].as_u64().unwrap_or(0),
        direction: direction.into(),
        status: status.into(),
        deleted: value["deleted"] == true,
        error: String::new(),
    })
}

pub(super) async fn activity_inner(
    core: &Core,
    id: &str,
    page: usize,
) -> Result<ActivityPage, String> {
    if !(1..=200).contains(&page) {
        return Err("无效的队列分页".into());
    }
    let folder = authorized_folder(core, id).await?;
    let (connections, status) = futures_util::join!(
        core.request("system/connections", None),
        core.request("system/status", None)
    );
    let connections = connections?;
    let status = status?;
    let own = status["myID"].as_str().ok_or("本机设备身份不可用")?;
    let all_peers: Vec<&str> = folder["devices"]
        .as_array()
        .ok_or("同步设备响应无效")?
        .iter()
        .filter_map(|d| d["deviceID"].as_str())
        .filter(|d| *d != own)
        .collect();
    let connected = all_peers
        .iter()
        .any(|p| connections["connections"][*p]["connected"] == true);
    let paused = folder["paused"] == true;
    let number = page.to_string();
    let need_url = query(
        "db/need",
        &[("folder", id), ("page", &number), ("perpage", "100")],
    );
    let errors_url = query(
        "folder/errors",
        &[("folder", id), ("page", &number), ("perpage", "100")],
    );
    let (need, errors) = futures_util::join!(
        core.request(&need_url, None),
        core.request(&errors_url, None)
    );
    let mut result = ActivityPage {
        folder_id: id.into(),
        page,
        entries: Vec::new(),
        has_more: false,
        warnings: Vec::new(),
    };
    if paused {
        result.warnings.push("同步已暂停".into());
    } else if !connected {
        result.warnings.push("服务器未连接".into());
    }
    match need {
        Ok(need) => {
            let mut count = 0;
            for (field, state) in [
                ("progress", "receiving"),
                ("queued", "pending"),
                ("rest", "pending"),
            ] {
                match rows(&need, field) {
                    Ok(items) => {
                        count += items.len();
                        for value in items {
                            if let Some(item) = entry(value, "receive", state, paused, connected) {
                                result.entries.push(item);
                            }
                        }
                    }
                    Err(error) => result.warnings.push(error),
                }
            }
            result.has_more |= count >= PAGE_SIZE;
        }
        Err(_) => result.warnings.push("待接收队列读取失败".into()),
    }
    if all_peers.len() > MAX_PEERS {
        result
            .warnings
            .push("设备过多，仅显示前 32 个设备的待发送项目".into());
    }
    let requests: Vec<(bool, String)> = all_peers
        .iter()
        .take(MAX_PEERS)
        .map(|peer| {
            (
                connections["connections"][*peer]["connected"] == true,
                query(
                    "db/remoteneed",
                    &[
                        ("folder", id),
                        ("device", peer),
                        ("page", &number),
                        ("perpage", "100"),
                    ],
                ),
            )
        })
        .collect();
    let sends: Vec<_> = stream::iter(
        requests
            .into_iter()
            .map(|(connected, url)| async move { (connected, core.request(&url, None).await) }),
    )
    .buffered(4)
    .collect()
    .await;
    for (peer_connected, remote) in sends {
        match remote {
            Ok(remote) => match rows(&remote, "files") {
                Ok(items) => {
                    result.has_more |= items.len() >= PAGE_SIZE;
                    for value in items {
                        // Remote need is not proof that bytes are currently transferring.
                        if let Some(item) = entry(value, "send", "pending", paused, peer_connected)
                        {
                            result.entries.push(item);
                        }
                    }
                }
                Err(error) => result.warnings.push(error),
            },
            Err(_) => result.warnings.push("部分待发送队列读取失败".into()),
        }
    }
    match errors {
        Ok(errors) => match rows(&errors, "errors") {
            Ok(items) => {
                result.has_more |= items.len() >= PAGE_SIZE;
                for value in items {
                    let Some(path) = value["path"].as_str().map(|s| s.replace('\\', "/")) else {
                        continue;
                    };
                    if path.is_empty() || !valid_relative(&path) {
                        continue;
                    }
                    let reason: String = value["error"]
                        .as_str()
                        .unwrap_or("同步失败")
                        .chars()
                        .take(500)
                        .collect();
                    result.entries.retain(|e| e.path != path);
                    result.entries.push(ActivityEntry {
                        name: path.rsplit('/').next().unwrap_or(&path).into(),
                        path,
                        kind: "file".into(),
                        size: 0,
                        direction: "error".into(),
                        status: "error".into(),
                        deleted: false,
                        error: reason,
                    });
                }
            }
            Err(error) => result.warnings.push(error),
        },
        Err(_) => result.warnings.push("同步错误读取失败".into()),
    }
    let mut seen = HashSet::new();
    result
        .entries
        .retain(|entry| seen.insert((entry.path.clone(), entry.direction.clone())));
    result.warnings.sort();
    result.warnings.dedup();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn states_come_from_queue_not_optimistic_progress() {
        let value = json!({"name":"目录\\file.txt", "size":4, "type":"FILE_INFO_TYPE_FILE", "deleted":false});
        let receiving = entry(&value, "receive", "receiving", false, true).unwrap();
        assert_eq!(receiving.path, "目录/file.txt");
        assert_eq!(receiving.status, "receiving");
        assert_eq!(
            entry(&value, "send", "pending", false, true)
                .unwrap()
                .status,
            "pending"
        );
        assert_eq!(
            entry(&value, "receive", "receiving", false, false)
                .unwrap()
                .status,
            "offline"
        );
        assert_eq!(
            entry(&value, "receive", "receiving", true, true)
                .unwrap()
                .status,
            "paused"
        );
        assert!(entry(
            &json!({"name":"../secret"}),
            "receive",
            "pending",
            false,
            true
        )
        .is_none());
        assert!(entry(&json!({"name":"/absolute"}), "send", "pending", false, true).is_none());
        assert!(
            entry(
                &json!({"name":"a", "deleted":true}),
                "send",
                "pending",
                false,
                true
            )
            .unwrap()
            .deleted
        );
    }
    #[test]
    fn malformed_or_missing_queue_is_not_empty_success() {
        assert!(rows(&json!({}), "files").is_err());
        assert!(rows(&json!({"files":{}}), "files").is_err());
        assert!(rows(&json!({"files":null}), "files").unwrap().is_empty());
        assert!(rows(&json!({"files":[]}), "files").unwrap().is_empty());
    }
}
