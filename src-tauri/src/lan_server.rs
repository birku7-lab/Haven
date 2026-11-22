use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{get, patch, post, put},
    Router,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use crate::db::{DbManager, DeviceRecord, SyncRuleRecord};
use crate::storage::{
    allocate_unique_path, classify_file, get_volume_stats, resolve_inside_root, sanitize_name,
    stream_file_range_response,
};
use crate::transfers;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanServerStatus {
    pub running: bool,
    pub port: u16,
    pub bind_address: String,
    pub lan_urls: Vec<String>,
    pub started_at: Option<String>,
    pub active_connections: usize,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct LanState {
    pub db: Arc<DbManager>,
    pub status: Arc<Mutex<LanServerStatus>>,
}

pub fn get_lan_ipv4_addresses() -> Vec<String> {
    let mut ips = Vec::new();
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                let ip = addr.ip().to_string();
                if ip != "127.0.0.1" && !ip.starts_with("0.") {
                    ips.push(ip);
                }
            }
        }
    }
    ips
}

fn auth_device(headers: &HeaderMap, db: &DbManager) -> Result<DeviceRecord, Response> {
    let Some(auth) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Authentication required. Provide Bearer device token."})),
        )
            .into_response());
    };
    let Some(raw_token) = auth.strip_prefix("Bearer ") else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Invalid authorization header"})),
        )
            .into_response());
    };
    let token_hash = hex::encode(Sha256::digest(raw_token.trim().as_bytes()));
    let Some(device) = db.find_device_by_token_hash(&token_hash) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Invalid or revoked device token"})),
        )
            .into_response());
    };
    let guard = db.conn.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        let now = Utc::now().to_rfc3339();
        let _ = conn.execute(
            "UPDATE devices SET status = 'connected', last_seen_at = ?1, last_connected_at = ?1 WHERE id = ?2",
            params![now, device.id],
        );
    }
    Ok(device)
}

async fn lan_health(State(state): State<LanState>) -> Json<Value> {
    Json(json!({
        "service": "haven-storage-server",
        "protocolVersion": "1.0",
        "setupCompleted": state.db.is_open(),
        "timestamp": Utc::now().to_rfc3339()
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
    code: String,
    secret: String,
    device_name: String,
    device_type: Option<String>,
    os_version: Option<String>,
}

async fn lan_pair(State(state): State<LanState>, Json(body): Json<PairBody>) -> Response {
    if !state.db.is_open() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Storage server not initialized"})),
        )
            .into_response();
    }
    let now = Utc::now().to_rfc3339();
    {
        let guard = state.db.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else {
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "DB not open"}))).into_response();
        };
        let session: Option<(String, String, String, i64)> = conn
            .query_row(
                "SELECT id, secret, expires_at, used FROM pairing_sessions WHERE code = ?1",
                params![body.code.trim()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .ok()
            .flatten();
        let Some((sid, exp_secret, expires_at, used)) = session else {
            return (StatusCode::UNAUTHORIZED, Json(json!({"error": "Invalid pairing code"}))).into_response();
        };
        if used != 0 || expires_at < now || exp_secret != body.secret {
            return (StatusCode::UNAUTHORIZED, Json(json!({"error": "Pairing session expired or invalid"}))).into_response();
        }
        let _ = conn.execute("UPDATE pairing_sessions SET used = 1 WHERE id = ?1", params![sid]);
    }

    let raw_token = format!(
        "hvn_{}{}",
        DbManager::new_id().replace('-', ""),
        DbManager::new_id().replace('-', "")
    );
    let token_hash = hex::encode(Sha256::digest(raw_token.as_bytes()));
    let dev_id = DbManager::new_id();
    let perms = crate::db::DevicePermissions::default();
    let perms_json = serde_json::to_string(&perms).unwrap();
    let dev_type = if body.device_type.as_deref() == Some("windows") {
        "windows"
    } else {
        "android"
    };
    let os_ver = body.os_version.unwrap_or_else(|| "Android".to_string());
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "INSERT INTO devices (id, name, device_type, os_version, token_hash, permissions_json, status, is_revoked, paired_at, last_connected_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'connected', 0, ?7, ?7, ?7)",
                params![dev_id, body.device_name, dev_type, os_ver, token_hash, perms_json, now],
            );
        }
    }
    state
        .db
        .log_event("info", "server", &format!("Paired new device: {}", body.device_name));
    (
        StatusCode::CREATED,
        Json(json!({
            "deviceId": dev_id,
            "token": raw_token,
            "permissions": perms,
            "serverName": "Haven PC"
        })),
    )
        .into_response()
}

async fn lan_storage_info(headers: HeaderMap, State(state): State<LanState>) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.read_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks readFiles permission"})),
        )
            .into_response();
    }
    let Some(root_str) = state.db.get_settings().storage_root else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Storage not initialized"})),
        )
            .into_response();
    };
    let (total, free, used, avail) = get_volume_stats(&PathBuf::from(&root_str));
    let guard = state.db.conn.lock().unwrap();
    let (total_files, total_folders, total_managed): (i64, i64, i64) = guard
        .as_ref()
        .map(|c| {
            let f = c
                .query_row("SELECT COUNT(*) FROM files WHERE is_deleted = 0", [], |r| r.get(0))
                .unwrap_or(0);
            let d = c
                .query_row("SELECT COUNT(*) FROM folders", [], |r| r.get(0))
                .unwrap_or(0);
            let m = c
                .query_row(
                    "SELECT COALESCE(SUM(size), 0) FROM files WHERE is_deleted = 0",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            (f, d, m)
        })
        .unwrap_or((0, 0, 0));

    Json(json!({
        "serverName": "Haven PC",
        "storageRoot": root_str,
        "volume": { "totalBytes": total, "freeBytes": free, "usedBytes": used, "available": avail },
        "totalFiles": total_files,
        "totalFolders": total_folders,
        "totalManagedBytes": total_managed
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanFilesQuery {
    folder_id: Option<String>,
    search: Option<String>,
    category: Option<String>,
    favorites: Option<String>,
    recent: Option<String>,
    sort_by: Option<String>,
    sort_dir: Option<String>,
}

async fn lan_list_files(
    headers: HeaderMap,
    Query(q): Query<LanFilesQuery>,
    State(state): State<LanState>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.read_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks readFiles permission"})),
        )
            .into_response();
    }
    let has_search = q.search.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
    let has_cat = q
        .category
        .as_deref()
        .map(|s| !s.is_empty() && s != "all")
        .unwrap_or(false);
    let fav_only = q.favorites.as_deref() == Some("1");
    let recent_only = q.recent.as_deref() == Some("1");
    let sort_by = q.sort_by.as_deref().unwrap_or("name");
    let sort_dir = q.sort_dir.as_deref().unwrap_or("asc");

    let (folders, files, breadcrumbs) = if has_search || has_cat || fav_only || recent_only {
        let fl = state.db.list_files(
            None,
            false,
            false,
            if has_cat { q.category.as_deref() } else { None },
            q.search.as_deref(),
            fav_only,
            if recent_only { "importedAt" } else { sort_by },
            if recent_only { "desc" } else { sort_dir },
            if recent_only { Some(50) } else { None },
        );
        (vec![], fl, vec![json!({"id": Value::Null, "name": "HavenStorage"})])
    } else {
        let fid = q.folder_id.as_deref().filter(|s| !s.is_empty());
        let flds = state.db.list_folders(fid, false);
        let fl = state
            .db
            .list_files(fid, true, false, None, None, false, sort_by, sort_dir, None);
        let mut chain = Vec::new();
        let mut cursor = fid.and_then(|id| state.db.get_folder_by_id(id));
        while let Some(c) = cursor {
            chain.push(json!({"id": c.id, "name": c.name}));
            cursor = c
                .parent_id
                .as_deref()
                .and_then(|pid| state.db.get_folder_by_id(pid));
        }
        chain.reverse();
        let mut crumbs = vec![json!({"id": Value::Null, "name": "HavenStorage"})];
        crumbs.extend(chain);
        (flds, fl, crumbs)
    };
    let all_folders = state.db.list_folders(None, true);
    Json(json!({
        "folders": folders,
        "files": files,
        "breadcrumbs": breadcrumbs,
        "allFolders": all_folders
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanCreateFolderBody {
    name: String,
    parent_id: Option<String>,
}

async fn lan_create_folder(
    headers: HeaderMap,
    State(state): State<LanState>,
    Json(body): Json<LanCreateFolderBody>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.upload_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks uploadFiles permission"})),
        )
            .into_response();
    }
    let Some(root_str) = state.db.get_settings().storage_root else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Storage not initialized"})),
        )
            .into_response();
    };
    let root = PathBuf::from(root_str);
    let clean = match sanitize_name(&body.name) {
        Ok(n) => n,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    };
    let parent_rel = body
        .parent_id
        .as_deref()
        .and_then(|pid| state.db.get_folder_by_id(pid))
        .map(|f| f.relative_path)
        .unwrap_or_else(|| "Files".to_string());
    let (rel_path, final_name) = match allocate_unique_path(&root, &parent_rel, &clean) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    };
    let abs = match resolve_inside_root(&root, &rel_path) {
        Ok(a) => a,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    };
    if let Err(e) = fs::create_dir_all(&abs) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response();
    }
    let id = DbManager::new_id();
    let now = Utc::now().to_rfc3339();
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "INSERT INTO folders (id, name, relative_path, parent_id, created_at, modified_at, is_favorite, device_origin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, ?6)",
                params![id, final_name, rel_path, body.parent_id, now, device.name],
            );
        }
    }
    (
        StatusCode::CREATED,
        Json(state.db.get_folder_by_id(&id).unwrap()),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanUpdateFileBody {
    name: Option<String>,
    is_favorite: Option<bool>,
    tags: Option<Vec<String>>,
}

async fn lan_update_file(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<LanState>,
    Json(body): Json<LanUpdateFileBody>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.upload_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks uploadFiles permission"})),
        )
            .into_response();
    }
    let Some(root_str) = state.db.get_settings().storage_root else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Storage not initialized"})),
        )
            .into_response();
    };
    let root = PathBuf::from(root_str);
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    };
    if file.is_deleted {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    }
    let now = Utc::now().to_rfc3339();
    if let Some(ref new_name_raw) = body.name {
        if new_name_raw != &file.name {
            let clean = match sanitize_name(new_name_raw) {
                Ok(n) => n,
                Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
            };
            let dir_rel = Path::new(&file.relative_path)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or("Files");
            let (new_rel, final_name) = match allocate_unique_path(&root, dir_rel, &clean) {
                Ok(v) => v,
                Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
            };
            let old_abs = resolve_inside_root(&root, &file.relative_path).unwrap();
            let new_abs = resolve_inside_root(&root, &new_rel).unwrap();
            if let Err(e) = fs::rename(&old_abs, &new_abs) {
                return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response();
            }
            let (cat, ext, mime) = classify_file(&final_name);
            let guard = state.db.conn.lock().unwrap();
            if let Some(conn) = guard.as_ref() {
                let _ = conn.execute(
                    "UPDATE files SET name = ?1, relative_path = ?2, category = ?3, extension = ?4, mime_type = ?5, modified_at = ?6 WHERE id = ?7",
                    params![final_name, new_rel, cat, ext, mime, now, id],
                );
            }
        }
    }
    if let Some(fav) = body.is_favorite {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "UPDATE files SET is_favorite = ?1 WHERE id = ?2",
                params![if fav { 1 } else { 0 }, id],
            );
        }
    }
    if let Some(tags) = body.tags {
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "UPDATE files SET tags_json = ?1 WHERE id = ?2",
                params![tags_json, id],
            );
        }
    }
    Json(state.db.get_file_by_id(&id).unwrap()).into_response()
}

async fn lan_delete_file(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<LanState>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.delete_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks deleteFiles permission"})),
        )
            .into_response();
    }
    let Some(root_str) = state.db.get_settings().storage_root else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Storage not initialized"})),
        )
            .into_response();
    };
    match crate::soft_delete_file_internal(&state.db, &PathBuf::from(root_str), &id) {
        Ok(f) => Json(f).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanMediaQuery {
    #[serde(rename = "type")]
    media_type: Option<String>,
    sort_by: Option<String>,
    sort_dir: Option<String>,
    search: Option<String>,
    favorites: Option<String>,
    folder_id: Option<String>,
}

async fn lan_media(
    headers: HeaderMap,
    Query(q): Query<LanMediaQuery>,
    State(state): State<LanState>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.read_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks readFiles permission"})),
        )
            .into_response();
    }
    let m_type = q.media_type.as_deref().unwrap_or("all");
    let sort_by = q.sort_by.as_deref().unwrap_or("modifiedAt");
    let sort_dir = q.sort_dir.as_deref().unwrap_or("desc");
    let fav_only = q.favorites.as_deref() == Some("1");
    let fid = q.folder_id.as_deref().filter(|s| !s.is_empty());

    let photos = if m_type == "all" || m_type == "photo" {
        state.db.list_files(
            fid,
            fid.is_some(),
            false,
            Some("photo"),
            q.search.as_deref(),
            fav_only,
            sort_by,
            sort_dir,
            None,
        )
    } else {
        vec![]
    };
    let videos = if (m_type == "all" || m_type == "video") && device.permissions.stream_media {
        state.db.list_files(
            fid,
            fid.is_some(),
            false,
            Some("video"),
            q.search.as_deref(),
            fav_only,
            sort_by,
            sort_dir,
            None,
        )
    } else {
        vec![]
    };
    let photo_count = photos.len();
    let video_count = videos.len();
    let mut items = photos;
    items.extend(videos);
    items.sort_by(|a, b| {
        let ord = if sort_by == "size" {
            a.size.cmp(&b.size)
        } else {
            a.modified_at.cmp(&b.modified_at)
        };
        if sort_dir.eq_ignore_ascii_case("asc") {
            ord
        } else {
            ord.reverse()
        }
    });

    let mut albums: HashMap<String, (Option<String>, String, usize, String)> = HashMap::new();
    for item in &items {
        let key = item.folder_id.clone().unwrap_or_else(|| "root".to_string());
        if let Some(entry) = albums.get_mut(&key) {
            entry.2 += 1;
        } else {
            let name = item
                .folder_id
                .as_deref()
                .and_then(|id| state.db.get_folder_by_id(id))
                .map(|f| f.name)
                .unwrap_or_else(|| "Library Root".to_string());
            albums.insert(key, (item.folder_id.clone(), name, 1, item.id.clone()));
        }
    }
    let albums_json: Vec<Value> = albums
        .into_values()
        .map(|(fid, name, count, cover_id)| {
            json!({
                "folderId": fid,
                "name": name,
                "count": count,
                "coverId": cover_id
            })
        })
        .collect();

    Json(json!({
        "items": items,
        "albums": albums_json,
        "counts": { "photos": photo_count, "videos": video_count }
    }))
    .into_response()
}

#[derive(Deserialize)]
struct DownloadQuery {
    download: Option<String>,
}

async fn lan_file_content(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<DownloadQuery>,
    State(state): State<LanState>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    };
    if file.is_deleted {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    }
    if (file.category == "video" || file.category == "audio") && !device.permissions.stream_media {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks streamMedia permission"})),
        )
            .into_response();
    }
    if !device.permissions.read_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks readFiles permission"})),
        )
            .into_response();
    }
    let Some(root_str) = state.db.get_settings().storage_root else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Storage not initialized"})),
        )
            .into_response();
    };
    let Ok(abs) = resolve_inside_root(&PathBuf::from(root_str), &file.relative_path) else {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Access denied"}))).into_response();
    };
    stream_file_range_response(
        &headers,
        &abs,
        &file.mime_type,
        &file.name,
        q.download.as_deref() == Some("1"),
    )
    .await
}

async fn lan_file_thumbnail(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<LanState>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.read_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks readFiles permission"})),
        )
            .into_response();
    }
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Thumbnail not available"})),
        )
            .into_response();
    };
    let Some(thumb_rel) = file.thumbnail_path else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Thumbnail not available"})),
        )
            .into_response();
    };
    let Some(root_str) = state.db.get_settings().storage_root else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Storage not initialized"})),
        )
            .into_response();
    };
    let Ok(abs) = resolve_inside_root(&PathBuf::from(root_str), &thumb_rel) else {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Access denied"}))).into_response();
    };
    stream_file_range_response(&HeaderMap::new(), &abs, "image/webp", "thumb.webp", false).await
}

async fn lan_transfer_status(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<LanState>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.upload_files && !device.permissions.read_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks transfer inspection permission"})),
        )
            .into_response();
    }
    match state.db.get_transfer_by_id(&id) {
        Some(tr) => Json(tr).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "Transfer session not found"})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanUploadInitBody {
    file_name: String,
    total_bytes: i64,
    folder_id: Option<String>,
    chunk_size: Option<i64>,
    sha256_expected: Option<String>,
}

async fn lan_upload_init(
    headers: HeaderMap,
    State(state): State<LanState>,
    Json(body): Json<LanUploadInitBody>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.upload_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks uploadFiles permission"})),
        )
            .into_response();
    }
    let Some(root_str) = state.db.get_settings().storage_root else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Storage not initialized"})),
        )
            .into_response();
    };
    match transfers::create_upload_session(
        &state.db,
        &PathBuf::from(root_str),
        &body.file_name,
        body.total_bytes,
        body.folder_id.as_deref(),
        body.chunk_size,
        body.sha256_expected,
        Some(device.id),
    ) {
        Ok(tr) => (StatusCode::CREATED, Json(tr)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

async fn lan_upload_chunk(
    headers: HeaderMap,
    AxumPath((id, index)): AxumPath<(String, i64)>,
    State(state): State<LanState>,
    body: Bytes,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.upload_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks uploadFiles permission"})),
        )
            .into_response();
    }
    let Some(root_str) = state.db.get_settings().storage_root else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Storage not initialized"})),
        )
            .into_response();
    };
    let chunk_sha = headers.get("x-chunk-sha256").and_then(|v| v.to_str().ok());
    match transfers::write_chunk(&state.db, &PathBuf::from(root_str), &id, index, &body, chunk_sha) {
        Ok(tr) => Json(tr).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

async fn lan_upload_complete(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<LanState>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.upload_files {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks uploadFiles permission"})),
        )
            .into_response();
    }
    let Some(root_str) = state.db.get_settings().storage_root else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "Storage not initialized"})),
        )
            .into_response();
    };
    match transfers::finalize_upload(&state.db, &PathBuf::from(root_str), &id) {
        Ok((tr, file)) => Json(json!({"transfer": tr, "file": file})).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

async fn lan_sync_rules(headers: HeaderMap, State(state): State<LanState>) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.sync_folders {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks syncFolders permission"})),
        )
            .into_response();
    }
    let guard = state.db.conn.lock().unwrap();
    let rules: Vec<SyncRuleRecord> = guard
        .as_ref()
        .and_then(|c| {
            c.prepare("SELECT * FROM sync_rules ORDER BY created_at DESC")
                .ok()
                .and_then(|mut st| {
                    st.query_map([], |r| {
                        let ex: String = r.get("exclusions_json")?;
                        Ok(SyncRuleRecord {
                            id: r.get("id")?,
                            device_id: r.get("device_id")?,
                            name: r.get("name")?,
                            direction: r.get("direction")?,
                            local_folder_id: r.get("local_folder_id")?,
                            local_folder_path: r.get("local_folder_path")?,
                            remote_path: r.get("remote_path")?,
                            exclusions: serde_json::from_str(&ex).unwrap_or_default(),
                            conflict_policy: r.get("conflict_policy")?,
                            enabled: r.get::<_, i64>("enabled")? == 1,
                            status: r.get("status")?,
                            last_sync_at: r.get("last_sync_at")?,
                            created_at: r.get("created_at")?,
                        })
                    })
                    .ok()
                    .map(|rows| {
                        rows.flatten()
                            .filter(|r| r.device_id.is_none() || r.device_id.as_deref() == Some(&device.id))
                            .collect()
                    })
                })
        })
        .unwrap_or_default();
    drop(guard);

    Json(json!({
        "rules": rules,
        "allFolders": state.db.list_folders(None, true)
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanSyncReportBody {
    status: Option<String>,
    files_synced: Option<i64>,
    conflicts_detected: Option<i64>,
    message: Option<String>,
}

async fn lan_sync_report(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<LanState>,
    Json(body): Json<LanSyncReportBody>,
) -> Response {
    let device = match auth_device(&headers, &state.db) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !device.permissions.sync_folders {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Device lacks syncFolders permission"})),
        )
            .into_response();
    }
    let now = Utc::now().to_rfc3339();
    let files_synced = body.files_synced.unwrap_or(0).max(0);
    let conflicts = body.conflicts_detected.unwrap_or(0).max(0);
    let run_status = match body.status.as_deref() {
        Some("conflict") => "conflict",
        Some("error") => "error",
        _ => "completed",
    };
    let rule_status = if conflicts > 0 { "conflict" } else { "active" };

    let rule_opt: Option<SyncRuleRecord> = {
        let guard = state.db.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else {
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "DB not open"}))).into_response();
        };
        let rule_name: Option<String> = conn
            .query_row("SELECT name FROM sync_rules WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        let Some(r_name) = rule_name else {
            return (StatusCode::NOT_FOUND, Json(json!({"error": "Sync rule not found"}))).into_response();
        };
        let msg = body
            .message
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("{} synced {} file(s) for {}", device.name, files_synced, r_name));

        let _ = conn.execute(
            "INSERT INTO sync_history (id, rule_id, status, files_synced, conflicts_detected, message, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![DbManager::new_id(), id, run_status, files_synced, conflicts, msg, now],
        );
        let _ = conn.execute(
            "UPDATE sync_rules SET device_id = COALESCE(device_id, ?1), enabled = 1, status = ?2, last_sync_at = ?3 WHERE id = ?4",
            params![device.id, rule_status, now, id],
        );
        conn.query_row("SELECT * FROM sync_rules WHERE id = ?1", params![id], |r| {
            let ex: String = r.get("exclusions_json")?;
            Ok(SyncRuleRecord {
                id: r.get("id")?,
                device_id: r.get("device_id")?,
                name: r.get("name")?,
                direction: r.get("direction")?,
                local_folder_id: r.get("local_folder_id")?,
                local_folder_path: r.get("local_folder_path")?,
                remote_path: r.get("remote_path")?,
                exclusions: serde_json::from_str(&ex).unwrap_or_default(),
                conflict_policy: r.get("conflict_policy")?,
                enabled: r.get::<_, i64>("enabled")? == 1,
                status: r.get("status")?,
                last_sync_at: r.get("last_sync_at")?,
                created_at: r.get("created_at")?,
            })
        })
        .optional()
        .ok()
        .flatten()
    };

    state.db.log_event(
        "info",
        "server",
        &format!("{} reported sync for rule {} ({} files)", device.name, id, files_synced),
    );
    Json(json!({ "rule": rule_opt })).into_response()
}

pub async fn start_lan_listener(
    db: Arc<DbManager>,
    status_arc: Arc<Mutex<LanServerStatus>>,
    shutdown_slot: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    port_override: Option<u16>,
    bind_lan_override: Option<bool>,
) -> Result<LanServerStatus, String> {
    {
        let st = status_arc.lock().unwrap();
        if st.running {
            return Ok(st.clone());
        }
    }
    let settings = db.get_settings();
    let port = port_override.unwrap_or(settings.server_port);
    let bind_lan = bind_lan_override.unwrap_or(settings.server_bind_lan);
    let bind_addr = if bind_lan { "0.0.0.0" } else { "127.0.0.1" };
    let addr: SocketAddr = format!("{}:{}", bind_addr, port)
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;

    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Port {} unavailable: {}", port, e))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    *shutdown_slot.lock().unwrap() = Some(tx);

    let lan_state = LanState {
        db: db.clone(),
        status: status_arc.clone(),
    };

    let router = Router::new()
        .route("/api/v1/health", get(lan_health))
        .route("/api/v1/pair", post(lan_pair))
        .route("/api/v1/storage/info", get(lan_storage_info))
        .route("/api/v1/files", get(lan_list_files))
        .route("/api/v1/folders", post(lan_create_folder))
        .route(
            "/api/v1/files/{id}",
            patch(lan_update_file).delete(lan_delete_file),
        )
        .route("/api/v1/files/{id}/content", get(lan_file_content))
        .route("/api/v1/files/{id}/thumbnail", get(lan_file_thumbnail))
        .route("/api/v1/media", get(lan_media))
        .route("/api/v1/transfers/{id}", get(lan_transfer_status))
        .route("/api/v1/transfers/upload", post(lan_upload_init))
        .route("/api/v1/transfers/{id}/chunks/{index}", put(lan_upload_chunk))
        .route("/api/v1/transfers/{id}/complete", post(lan_upload_complete))
        .route("/api/v1/sync/rules", get(lan_sync_rules))
        .route("/api/v1/sync/rules/{id}/report", post(lan_sync_report))
        .layer(DefaultBodyLimit::max(40 * 1024 * 1024))
        .with_state(lan_state);

    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });

    let mut urls = vec![format!("http://127.0.0.1:{}", port)];
    if bind_lan {
        for ip in get_lan_ipv4_addresses() {
            urls.push(format!("http://{}:{}", ip, port));
        }
    }

    let mut st = status_arc.lock().unwrap();
    st.running = true;
    st.port = port;
    st.bind_address = bind_addr.to_string();
    st.lan_urls = urls;
    st.started_at = Some(Utc::now().to_rfc3339());
    st.last_error = None;
    let _ = db.set_config_kv("serverEnabled", "true");
    let _ = db.set_config_kv("serverPort", &port.to_string());
    let _ = db.set_config_kv("serverBindLan", if bind_lan { "true" } else { "false" });
    db.log_event(
        "info",
        "server",
        &format!("LAN storage server started on {}:{}", bind_addr, port),
    );
    Ok(st.clone())
}
