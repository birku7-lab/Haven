mod db;
mod lan_server;
mod storage;
mod transfers;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{delete, get, patch, post, put},
    Router,
};
use base64::Engine as _;
use chrono::Utc;
use db::{DbManager, DevicePermissions, SyncHistoryRecord, SyncRuleRecord};
use lan_server::{get_lan_ipv4_addresses, start_lan_listener, LanServerStatus};
use qrcode::{render::svg, QrCode};
use rand::Rng;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use storage::{
    allocate_unique_path, get_volume_stats, list_system_drives, resolve_inside_root,
    run_storage_scan, sanitize_name, sha256_file, stream_file_range_response, ScannerState,
    HAVEN_SUBDIRS, USER_ROOT_DIRS,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
struct AppState {
    db: Arc<DbManager>,
    sessions: Arc<Mutex<HashMap<String, Value>>>,
    lan_shutdown: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    lan_status: Arc<Mutex<LanServerStatus>>,
    scanner_state: Arc<Mutex<ScannerState>>,
    app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
}

fn check_auth(headers: &HeaderMap, query_token: Option<&str>, state: &AppState) -> bool {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
        .or_else(|| query_token.map(|s| s.trim().to_string()));

    let Some(token) = raw else {
        return false;
    };
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    let mut map = state.sessions.lock().unwrap();
    if let Some(entry) = map.get_mut(&hash) {
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("lastActiveAt".into(), json!(Utc::now().to_rfc3339()));
        }
        return true;
    }
    false
}

fn unauth() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": "Authentication required"})),
    )
        .into_response()
}

fn require_root(state: &AppState) -> Result<PathBuf, Response> {
    let Some(root_str) = state.db.get_settings().storage_root else {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error": "Storage location not initialized"})),
        )
            .into_response());
    };
    if !state.db.is_open() {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error": "Storage database not open"})),
        )
            .into_response());
    }
    Ok(PathBuf::from(root_str))
}

async fn api_health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "haven-tauri-rust-core",
        "storageInitialized": state.db.is_open(),
        "timestamp": Utc::now().to_rfc3339()
    }))
}

async fn api_docs() -> Json<Value> {
    Json(json!({
        "service": "Haven Personal Storage Server API",
        "version": "1.0.0",
        "runtime": "Tauri v2 Native Windows Backend (Rust/Axum)",
        "endpoints": [
            "GET /api/v1/health",
            "POST /api/v1/pair",
            "GET /api/v1/storage/info",
            "GET /api/v1/files",
            "GET /api/v1/files/{id}/content (supports HTTP Range 206)",
            "GET /api/v1/files/{id}/thumbnail",
            "POST /api/v1/transfers/upload",
            "PUT /api/v1/transfers/{id}/chunks/{index}",
            "POST /api/v1/transfers/{id}/complete"
        ]
    }))
}

async fn api_auth_status(State(state): State<AppState>) -> Json<Value> {
    let boot = state.db.load_bootstrap();
    Json(json!({
        "passcodeConfigured": boot.admin_passcode_hash.is_some(),
        "managedByEnv": false,
        "setupCompleted": state.db.is_open()
    }))
}

#[derive(Deserialize)]
struct PasscodeBody {
    passcode: String,
}

async fn api_auth_setup(State(state): State<AppState>, Json(body): Json<PasscodeBody>) -> Response {
    let mut boot = state.db.load_bootstrap();
    if boot.admin_passcode_hash.is_some() {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error": "Passcode already configured"})),
        )
            .into_response();
    }
    if body.passcode.len() < 4 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Passcode must be at least 4 characters"})),
        )
            .into_response();
    }
    let salt = DbManager::new_id();
    let hash = DbManager::hash_passcode(&body.passcode, &salt);
    boot.admin_passcode_salt = Some(salt);
    boot.admin_passcode_hash = Some(hash);
    let _ = state.db.save_bootstrap(&boot);

    let raw_token = format!("{}{}", DbManager::new_id(), DbManager::new_id());
    let token_hash = hex::encode(Sha256::digest(raw_token.as_bytes()));
    let sid = DbManager::new_id();
    let now = Utc::now().to_rfc3339();
    state.sessions.lock().unwrap().insert(
        token_hash,
        json!({
            "id": sid,
            "createdAt": now,
            "lastActiveAt": now,
            "userAgent": "Haven Windows Desktop"
        }),
    );
    (
        StatusCode::CREATED,
        Json(json!({"token": raw_token, "sessionId": sid})),
    )
        .into_response()
}

async fn api_auth_login(State(state): State<AppState>, Json(body): Json<PasscodeBody>) -> Response {
    let boot = state.db.load_bootstrap();
    let (Some(expected), Some(salt)) = (boot.admin_passcode_hash, boot.admin_passcode_salt) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Passcode not configured"})),
        )
            .into_response();
    };
    if DbManager::hash_passcode(&body.passcode, &salt) != expected {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Invalid passcode"})),
        )
            .into_response();
    }
    let raw_token = format!("{}{}", DbManager::new_id(), DbManager::new_id());
    let token_hash = hex::encode(Sha256::digest(raw_token.as_bytes()));
    let sid = DbManager::new_id();
    let now = Utc::now().to_rfc3339();
    state.sessions.lock().unwrap().insert(
        token_hash,
        json!({
            "id": sid,
            "createdAt": now,
            "lastActiveAt": now,
            "userAgent": "Haven Windows Desktop"
        }),
    );
    Json(json!({"token": raw_token, "sessionId": sid})).into_response()
}

async fn api_auth_logout(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
    {
        let hash = hex::encode(Sha256::digest(token.trim().as_bytes()));
        state.sessions.lock().unwrap().remove(&hash);
    }
    Json(json!({"ok": true})).into_response()
}

async fn api_auth_sessions(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let list: Vec<Value> = state.sessions.lock().unwrap().values().cloned().collect();
    Json(json!({"sessions": list})).into_response()
}

async fn api_auth_revoke_session(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let mut map = state.sessions.lock().unwrap();
    map.retain(|_, v| v.get("id").and_then(|s| s.as_str()) != Some(id.as_str()));
    Json(json!({"ok": true})).into_response()
}

async fn api_drives(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let mut drives = Vec::new();
    for d in list_system_drives() {
        let mount = d.mount_point.clone();
        let total = d.total_bytes;
        let free = d.free_bytes;
        let used = total.saturating_sub(free);
        let default_path = if cfg!(windows) {
            format!("{}HavenStorage", mount)
        } else {
            format!("{}/HavenStorage", mount.trim_end_matches('/'))
        };
        let display_name = if d.label.is_empty() {
            mount.clone()
        } else {
            format!("{} ({})", d.label, mount)
        };
        drives.push(json!({
            "id": mount,
            "name": display_name,
            "mountPath": default_path,
            "fileSystem": d.file_system,
            "totalBytes": total,
            "freeBytes": free,
            "usedBytes": used,
            "isWritable": !d.is_read_only,
            "isSystem": mount.eq_ignore_ascii_case("C:\\") || mount == "/"
        }));
    }
    let default_path = if cfg!(windows) {
        "D:\\HavenStorage".to_string()
    } else {
        "~/HavenStorage".to_string()
    };
    Json(json!({
        "drives": drives,
        "platform": if cfg!(windows) { "win32" } else { "linux" },
        "defaultPath": default_path
    }))
    .into_response()
}

#[derive(Deserialize)]
struct PathBody {
    path: String,
}

async fn api_validate_path(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<PathBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let p = PathBuf::from(body.path.trim());
    let writable = fs::create_dir_all(&p).is_ok() && {
        let probe = p.join(".haven-write-probe");
        let ok = fs::write(&probe, b"ok").is_ok();
        let _ = fs::remove_file(&probe);
        ok
    };
    let (total, free, used, avail) = get_volume_stats(&p);
    Json(json!({
        "path": p.to_string_lossy(),
        "writable": writable,
        "exists": p.exists(),
        "error": if writable { Value::Null } else { json!("Path is not writable") },
        "volume": {
            "totalBytes": total,
            "freeBytes": free,
            "usedBytes": used,
            "available": avail
        }
    }))
    .into_response()
}

async fn api_initialize(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<PathBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = PathBuf::from(body.path.trim());
    let mut created = Vec::new();
    for sub in HAVEN_SUBDIRS {
        let dir = root.join(sub);
        if !dir.exists() {
            if let Err(e) = fs::create_dir_all(&dir) {
                return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response();
            }
            created.push(sub.to_string());
        }
    }
    let db_path = root.join("Database").join("haven.db");
    if let Err(e) = state.db.open(&db_path) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e})),
        )
            .into_response();
    }
    let _ = state.db.set_config_kv("storageRoot", &root.to_string_lossy());
    let _ = state.db.set_config_kv("setupCompleted", "true");
    let mut boot = state.db.load_bootstrap();
    boot.storage_root = Some(root.to_string_lossy().to_string());
    let _ = state.db.save_bootstrap(&boot);

    let now = Utc::now().to_rfc3339();
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            for dir_name in USER_ROOT_DIRS {
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO folders (id, name, relative_path, parent_id, created_at, modified_at, is_favorite, device_origin)
                     VALUES (?1, ?2, ?3, NULL, ?4, ?4, 0, 'windows-pc')",
                    params![DbManager::new_id(), dir_name, dir_name, now],
                );
            }
        }
    }
    state
        .db
        .log_event("info", "storage", &format!("Initialized HavenStorage at {}", root.display()));
    (
        StatusCode::CREATED,
        Json(json!({
            "storageRoot": root.to_string_lossy(),
            "subdirsCreated": created,
            "dbPath": db_path.to_string_lossy(),
            "settings": state.db.get_settings()
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct RelocateBody {
    path: String,
    mode: String,
}

fn copy_dir_recursive_verified(src: &Path, dst: &Path) -> Result<usize, String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let mut count = 0usize;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let s = entry.path();
        let d = dst.join(entry.file_name());
        let meta = fs::symlink_metadata(&s).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            count += copy_dir_recursive_verified(&s, &d)?;
        } else if meta.is_file() {
            fs::copy(&s, &d).map_err(|e| e.to_string())?;
            if sha256_file(&s)? != sha256_file(&d)? {
                return Err(format!("Checksum mismatch copying {}", s.display()));
            }
            count += 1;
        }
    }
    Ok(count)
}

async fn api_relocate(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<RelocateBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let old_root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let new_root = PathBuf::from(body.path.trim());
    if new_root == old_root {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "New location must differ from current location"})),
        )
            .into_response();
    }
    let mut files_copied = 0usize;
    if body.mode == "copy_and_switch" {
        for sub in HAVEN_SUBDIRS {
            let s = old_root.join(sub);
            let d = new_root.join(sub);
            if s.exists() {
                match copy_dir_recursive_verified(&s, &d) {
                    Ok(c) => files_copied += c,
                    Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
                }
            } else {
                let _ = fs::create_dir_all(&d);
            }
        }
    } else {
        for sub in HAVEN_SUBDIRS {
            let _ = fs::create_dir_all(new_root.join(sub));
        }
    }
    let new_db = new_root.join("Database").join("haven.db");
    if let Err(e) = state.db.open(&new_db) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e})),
        )
            .into_response();
    }
    let _ = state.db.set_config_kv("storageRoot", &new_root.to_string_lossy());
    let _ = state.db.set_config_kv("setupCompleted", "true");
    let mut boot = state.db.load_bootstrap();
    boot.storage_root = Some(new_root.to_string_lossy().to_string());
    let _ = state.db.save_bootstrap(&boot);
    state.db.log_event(
        "info",
        "storage",
        &format!("Relocated HavenStorage to {} ({} files copied)", new_root.display(), files_copied),
    );
    Json(json!({"newRoot": new_root.to_string_lossy(), "filesCopied": files_copied})).into_response()
}

async fn api_dashboard(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let settings = state.db.get_settings();
    let srv = state.lan_status.lock().unwrap().clone();
    if !state.db.is_open() {
        return Json(json!({
            "setupCompleted": false,
            "settings": settings,
            "server": srv
        }))
        .into_response();
    }
    let root = PathBuf::from(settings.storage_root.clone().unwrap_or_default());
    let (total, free, used, avail) = get_volume_stats(&root);
    let used_pct = if total > 0 {
        ((used as f64 / total as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };

    let (file_cnt, folder_cnt, managed_bytes, connected_dev, paired_dev) = {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let f_cnt: i64 = conn
                .query_row("SELECT COUNT(*) FROM files WHERE is_deleted = 0", [], |r| r.get(0))
                .unwrap_or(0);
            let fld_cnt: i64 = conn
                .query_row("SELECT COUNT(*) FROM folders", [], |r| r.get(0))
                .unwrap_or(0);
            let m_bytes: i64 = conn
                .query_row("SELECT COALESCE(SUM(size), 0) FROM files WHERE is_deleted = 0", [], |r| r.get(0))
                .unwrap_or(0);
            let c_dev: i64 = conn
                .query_row("SELECT COUNT(*) FROM devices WHERE is_revoked = 0 AND status = 'connected'", [], |r| r.get(0))
                .unwrap_or(0);
            let p_dev: i64 = conn
                .query_row("SELECT COUNT(*) FROM devices WHERE is_revoked = 0", [], |r| r.get(0))
                .unwrap_or(0);
            (f_cnt, fld_cnt, m_bytes, c_dev, p_dev)
        } else {
            (0, 0, 0, 0, 0)
        }
    };

    let active_transfers: Vec<_> = state
        .db
        .list_transfers()
        .into_iter()
        .filter(|t| matches!(t.status.as_str(), "active" | "queued" | "paused" | "verifying"))
        .collect();
    let recent_files = state.db.list_files(None, false, false, None, None, false, "importedAt", "desc", Some(8));
    let recent_activity = state.db.list_logs(10, None, None);
    let (integrity_ok, _) = state.db.check_integrity();
    let last_backup = state.db.get_config_kv("lastBackupAt");
    let scanner = state.scanner_state.lock().unwrap().clone();

    let mut warnings = Vec::new();
    if used_pct >= settings.warning_threshold_pct as f64 {
        warnings.push(json!({
            "code": "LOW_DISK_SPACE",
            "level": if used_pct >= 95.0 { "error" } else { "warn" },
            "message": format!("Target volume is {:.1}% full (threshold {}%).", used_pct, settings.warning_threshold_pct)
        }));
    }
    if !integrity_ok {
        warnings.push(json!({
            "code": "DB_INTEGRITY",
            "level": "error",
            "message": "SQLite integrity check reported an issue."
        }));
    }

    Json(json!({
        "setupCompleted": true,
        "settings": settings,
        "volume": {
            "totalBytes": total,
            "freeBytes": free,
            "usedBytes": used,
            "available": avail,
            "usedPct": used_pct
        },
        "counts": {
            "files": file_cnt,
            "folders": folder_cnt,
            "managedBytes": managed_bytes,
            "connectedDevices": connected_dev,
            "pairedDevices": paired_dev
        },
        "server": srv,
        "scanner": scanner,
        "activeTransfers": active_transfers,
        "recentFiles": recent_files,
        "recentActivity": recent_activity,
        "backupStatus": { "lastBackupAt": last_backup, "integrityOk": integrity_ok },
        "warnings": warnings
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesQuery {
    folder_id: Option<String>,
    search: Option<String>,
    category: Option<String>,
    favorites: Option<String>,
    recent: Option<String>,
    sort_by: Option<String>,
    sort_dir: Option<String>,
}

async fn api_list_files(
    headers: HeaderMap,
    Query(q): Query<FilesQuery>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    if let Err(resp) = require_root(&state) {
        return resp;
    }
    let has_search = q.search.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
    let has_cat = q.category.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    let fav_only = q.favorites.as_deref() == Some("1");
    let recent_only = q.recent.as_deref() == Some("1");
    let sort_by = q.sort_by.as_deref().unwrap_or("name");
    let sort_dir = q.sort_dir.as_deref().unwrap_or("asc");

    let (folders, files, breadcrumbs) = if has_search || has_cat || fav_only || recent_only {
        let fl = state.db.list_files(
            None,
            false,
            false,
            q.category.as_deref(),
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
        let fl = state.db.list_files(fid, true, false, None, None, false, sort_by, sort_dir, None);
        let mut chain = Vec::new();
        let mut cursor = fid.and_then(|id| state.db.get_folder_by_id(id));
        while let Some(c) = cursor {
            chain.push(json!({"id": c.id, "name": c.name}));
            cursor = c.parent_id.as_deref().and_then(|pid| state.db.get_folder_by_id(pid));
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
struct CreateFolderBody {
    name: String,
    parent_id: Option<String>,
}

async fn api_create_folder(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<CreateFolderBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
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
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, 'windows-pc')",
                params![id, final_name, rel_path, body.parent_id, now],
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
struct RenameBody {
    name: String,
}

async fn api_rename_folder(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
    Json(body): Json<RenameBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(folder) = state.db.get_folder_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "Folder not found"}))).into_response();
    };
    let clean = match sanitize_name(&body.name) {
        Ok(n) => n,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    };
    let parent_rel = Path::new(&folder.relative_path)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("");
    let new_rel = if parent_rel.is_empty() {
        clean.clone()
    } else {
        format!("{}/{}", parent_rel, clean)
    };
    let old_abs = match resolve_inside_root(&root, &folder.relative_path) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    };
    let new_abs = match resolve_inside_root(&root, &new_rel) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    };
    if old_abs != new_abs {
        if let Err(e) = fs::rename(&old_abs, &new_abs) {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response();
        }
    }
    let now = Utc::now().to_rfc3339();
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "UPDATE folders SET name = ?1, relative_path = ?2, modified_at = ?3 WHERE id = ?4",
                params![clean, new_rel, now, id],
            );
        }
    }
    Json(state.db.get_folder_by_id(&id).unwrap()).into_response()
}

async fn api_delete_folder(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(folder) = state.db.get_folder_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "Folder not found"}))).into_response();
    };
    let files = state.db.list_files(Some(&id), true, false, None, None, false, "name", "asc", None);
    let mut moved = 0usize;
    for f in files {
        if soft_delete_file_internal(&state.db, &root, &f.id).is_ok() {
            moved += 1;
        }
    }
    if let Ok(abs) = resolve_inside_root(&root, &folder.relative_path) {
        let _ = fs::remove_dir_all(abs);
    }
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute("DELETE FROM folders WHERE id = ?1", params![id]);
        }
    }
    Json(json!({"filesMovedToBin": moved})).into_response()
}

async fn api_get_file_details(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    };
    let abs = resolve_inside_root(&root, &file.relative_path).unwrap_or_default();
    Json(json!({"file": file, "absolutePath": abs.to_string_lossy()})).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateFileBody {
    name: Option<String>,
    is_favorite: Option<bool>,
    tags: Option<Vec<String>>,
}

async fn api_update_file(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
    Json(body): Json<UpdateFileBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    };
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
            let (cat, ext, mime) = storage::classify_file(&final_name);
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveCopyBody {
    target_folder_id: Option<String>,
}

async fn api_move_file(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
    Json(body): Json<MoveCopyBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    };
    let target_rel = body
        .target_folder_id
        .as_deref()
        .and_then(|fid| state.db.get_folder_by_id(fid))
        .map(|f| f.relative_path)
        .unwrap_or_else(|| "Files".to_string());
    let (new_rel, new_name) = match allocate_unique_path(&root, &target_rel, &file.name) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    };
    let old_abs = resolve_inside_root(&root, &file.relative_path).unwrap();
    let new_abs = resolve_inside_root(&root, &new_rel).unwrap();
    if let Some(parent) = new_abs.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::rename(&old_abs, &new_abs) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response();
    }
    let now = Utc::now().to_rfc3339();
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "UPDATE files SET name = ?1, relative_path = ?2, folder_id = ?3, modified_at = ?4 WHERE id = ?5",
                params![new_name, new_rel, body.target_folder_id, now, id],
            );
        }
    }
    Json(state.db.get_file_by_id(&id).unwrap()).into_response()
}

async fn api_copy_file(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
    Json(body): Json<MoveCopyBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    };
    let target_rel = body
        .target_folder_id
        .as_deref()
        .and_then(|fid| state.db.get_folder_by_id(fid))
        .map(|f| f.relative_path)
        .unwrap_or_else(|| {
            Path::new(&file.relative_path)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or("Files")
                .to_string()
        });
    let p = Path::new(&file.name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(&file.name);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| format!(".{}", s))
        .unwrap_or_default();
    let copy_desired = format!("{} - Copy{}", stem, ext);
    let (new_rel, new_name) = match allocate_unique_path(&root, &target_rel, &copy_desired) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    };
    let old_abs = resolve_inside_root(&root, &file.relative_path).unwrap();
    let new_abs = resolve_inside_root(&root, &new_rel).unwrap();
    if let Some(parent) = new_abs.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::copy(&old_abs, &new_abs) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response();
    }
    let new_id = DbManager::new_id();
    let now = Utc::now().to_rfc3339();
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "INSERT INTO files (id, name, relative_path, folder_id, size, mime_type, category, extension, created_at, modified_at, imported_at, sha256, thumbnail_path, is_favorite, tags_json, backup_status, device_origin, transfer_status, is_deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9, ?10, ?11, 0, '[]', 'local_only', 'windows-pc', 'complete', 0)",
                params![
                    new_id,
                    new_name,
                    new_rel,
                    body.target_folder_id.or(file.folder_id),
                    file.size,
                    file.mime_type,
                    file.category,
                    file.extension,
                    now,
                    file.sha256,
                    file.thumbnail_path
                ],
            );
        }
    }
    (
        StatusCode::CREATED,
        Json(state.db.get_file_by_id(&new_id).unwrap()),
    )
        .into_response()
}

pub(crate) fn soft_delete_file_internal(db: &DbManager, root: &Path, id: &str) -> Result<db::FileRecord, String> {
    let file = db.get_file_by_id(id).ok_or("File not found")?;
    if file.is_deleted {
        return Ok(file);
    }
    let (bin_rel, _) = allocate_unique_path(root, "RecycleBin", &format!("{}_{}", id, file.name))?;
    let old_abs = resolve_inside_root(root, &file.relative_path)?;
    let bin_abs = resolve_inside_root(root, &bin_rel)?;
    if let Some(parent) = bin_abs.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if old_abs.exists() {
        fs::rename(&old_abs, &bin_abs).map_err(|e| e.to_string())?;
    }
    let now = Utc::now().to_rfc3339();
    {
        let guard = db.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or("DB not open")?;
        conn.execute(
            "UPDATE files SET is_deleted = 1, deleted_at = ?1, original_relative_path = ?2, original_folder_id = ?3, relative_path = ?4 WHERE id = ?5",
            params![now, file.relative_path, file.folder_id, bin_rel, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(db.get_file_by_id(id).unwrap())
}

async fn api_delete_file(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match soft_delete_file_internal(&state.db, &root, &id) {
        Ok(f) => Json(f).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
struct BatchDeleteBody {
    ids: Vec<String>,
}

async fn api_batch_delete(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<BatchDeleteBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let mut moved = 0usize;
    for id in body.ids {
        if soft_delete_file_internal(&state.db, &root, &id).is_ok() {
            moved += 1;
        }
    }
    Json(json!({"movedToRecycleBin": moved})).into_response()
}

#[derive(Deserialize)]
struct ContentQuery {
    token: Option<String>,
    download: Option<String>,
}

async fn api_file_content(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<ContentQuery>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, q.token.as_deref(), &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    };
    let Ok(abs) = resolve_inside_root(&root, &file.relative_path) else {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Access denied"}))).into_response();
    };
    stream_file_range_response(&headers, &abs, &file.mime_type, &file.name, q.download.as_deref() == Some("1")).await
}

async fn api_file_thumbnail(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<ContentQuery>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, q.token.as_deref(), &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    };
    let Some(thumb_rel) = file.thumbnail_path else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "Thumbnail not available"}))).into_response();
    };
    let Ok(abs) = resolve_inside_root(&root, &thumb_rel) else {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Access denied"}))).into_response();
    };
    stream_file_range_response(&HeaderMap::new(), &abs, "image/webp", "thumb.webp", false).await
}

async fn api_open_in_os(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    };
    let Ok(abs) = resolve_inside_root(&root, &file.relative_path) else {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Access denied"}))).into_response();
    };
    let path_str = abs.to_string_lossy().to_string();
    let opened = {
        let guard = state.app_handle.lock().unwrap();
        if let Some(app) = guard.as_ref() {
            app.opener().open_path(&path_str, None::<&str>).is_ok()
        } else {
            false
        }
    };
    Json(json!({"opened": opened, "path": path_str})).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaQuery {
    #[serde(rename = "type")]
    media_type: Option<String>,
    sort_by: Option<String>,
    sort_dir: Option<String>,
    search: Option<String>,
    favorites: Option<String>,
    folder_id: Option<String>,
}

async fn api_media(
    headers: HeaderMap,
    Query(q): Query<MediaQuery>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    if let Err(resp) = require_root(&state) {
        return resp;
    }
    let m_type = q.media_type.as_deref().unwrap_or("all");
    let sort_by = q.sort_by.as_deref().unwrap_or("modifiedAt");
    let sort_dir = q.sort_dir.as_deref().unwrap_or("desc");
    let fav_only = q.favorites.as_deref() == Some("1");
    let fid = q.folder_id.as_deref().filter(|s| !s.is_empty());

    let photos = if m_type == "all" || m_type == "photo" {
        state.db.list_files(fid, fid.is_some(), false, Some("photo"), q.search.as_deref(), fav_only, sort_by, sort_dir, None)
    } else {
        vec![]
    };
    let videos = if m_type == "all" || m_type == "video" {
        state.db.list_files(fid, fid.is_some(), false, Some("video"), q.search.as_deref(), fav_only, sort_by, sort_dir, None)
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

async fn api_transfers_list(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    Json(json!({"transfers": state.db.list_transfers()})).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadInitBody {
    file_name: String,
    total_bytes: i64,
    folder_id: Option<String>,
    chunk_size: Option<i64>,
    sha256_expected: Option<String>,
}

async fn api_upload_init(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<UploadInitBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match transfers::create_upload_session(
        &state.db,
        &root,
        &body.file_name,
        body.total_bytes,
        body.folder_id.as_deref(),
        body.chunk_size,
        body.sha256_expected,
        None,
    ) {
        Ok(tr) => (StatusCode::CREATED, Json(tr)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

async fn api_upload_chunk(
    headers: HeaderMap,
    AxumPath((id, index)): AxumPath<(String, i64)>,
    State(state): State<AppState>,
    body: Bytes,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let chunk_sha = headers.get("x-chunk-sha256").and_then(|v| v.to_str().ok());
    match transfers::write_chunk(&state.db, &root, &id, index, &body, chunk_sha) {
        Ok(tr) => Json(tr).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

async fn api_upload_complete(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match transfers::finalize_upload(&state.db, &root, &id) {
        Ok((tr, file)) => Json(json!({"transfer": tr, "file": file})).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

async fn api_transfer_set_status(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
    new_status: &str,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let now = Utc::now().to_rfc3339();
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "UPDATE transfers SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![new_status, now, id],
            );
        }
    }
    match state.db.get_transfer_by_id(&id) {
        Some(tr) => Json(tr).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "Transfer not found"}))).into_response(),
    }
}

async fn api_transfer_pause(
    headers: HeaderMap,
    id: AxumPath<String>,
    state: State<AppState>,
) -> Response {
    api_transfer_set_status(headers, id, state, "paused").await
}
async fn api_transfer_resume(
    headers: HeaderMap,
    id: AxumPath<String>,
    state: State<AppState>,
) -> Response {
    api_transfer_set_status(headers, id, state, "active").await
}
async fn api_transfer_retry(
    headers: HeaderMap,
    id: AxumPath<String>,
    state: State<AppState>,
) -> Response {
    api_transfer_set_status(headers, id, state, "active").await
}
async fn api_transfer_cancel(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    if let Ok(root) = require_root(&state) {
        let _ = fs::remove_file(root.join("Temp").join(format!("{}.part", id)));
    }
    let now = Utc::now().to_rfc3339();
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "UPDATE transfers SET status = 'cancelled', updated_at = ?1 WHERE id = ?2",
                params![now, id],
            );
        }
    }
    match state.db.get_transfer_by_id(&id) {
        Some(tr) => Json(tr).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "Transfer not found"}))).into_response(),
    }
}

async fn api_transfers_clear_history(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "DELETE FROM transfers WHERE status IN ('completed', 'cancelled', 'failed')",
                [],
            );
        }
    }
    Json(json!({"ok": true})).into_response()
}

async fn api_analytics(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let (total, free, used, avail) = get_volume_stats(&root);
    let all_files = state.db.list_files(None, false, false, None, None, false, "size", "desc", None);
    let total_files = all_files.len();
    let all_folders = state.db.list_folders(None, true);
    let total_folders = all_folders.len();
    let total_managed: i64 = all_files.iter().map(|f| f.size).sum();

    let mut cat_map: HashMap<String, (usize, i64)> = HashMap::new();
    let mut dup_map: HashMap<String, Vec<db::FileRecord>> = HashMap::new();
    let mut folder_stats: HashMap<String, (usize, i64)> = HashMap::new();

    for f in &all_files {
        let entry = cat_map.entry(f.category.clone()).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += f.size;

        if let Some(ref sha) = f.sha256 {
            if f.size > 0 {
                dup_map.entry(sha.clone()).or_default().push(f.clone());
            }
        }
        if let Some(ref fid) = f.folder_id {
            let fe = folder_stats.entry(fid.clone()).or_insert((0, 0));
            fe.0 += 1;
            fe.1 += f.size;
        }
    }

    let by_category: Vec<Value> = cat_map
        .into_iter()
        .map(|(cat, (count, bytes))| json!({"category": cat, "count": count, "bytes": bytes}))
        .collect();
    let largest_files: Vec<_> = all_files.iter().take(15).cloned().collect();

    let mut largest_folders: Vec<Value> = all_folders
        .iter()
        .filter_map(|fld| {
            let (cnt, bytes) = folder_stats.get(&fld.id).copied().unwrap_or((0, 0));
            if cnt > 0 {
                Some(json!({
                    "id": fld.id,
                    "name": fld.name,
                    "relativePath": fld.relative_path,
                    "bytes": bytes,
                    "fileCount": cnt
                }))
            } else {
                None
            }
        })
        .collect();
    largest_folders.sort_by(|a, b| {
        b["bytes"].as_i64().unwrap_or(0).cmp(&a["bytes"].as_i64().unwrap_or(0))
    });
    largest_folders.truncate(10);

    let duplicates: Vec<Value> = dup_map
        .into_iter()
        .filter(|(_, list)| list.len() > 1)
        .map(|(sha, list)| {
            let size = list.first().map(|f| f.size).unwrap_or(0);
            json!({"sha256": sha, "size": size, "files": list})
        })
        .collect();

    let empty_folders: Vec<_> = all_folders
        .into_iter()
        .filter(|fld| folder_stats.get(&fld.id).map(|v| v.0).unwrap_or(0) == 0)
        .collect();

    let recently_added = state.db.list_files(None, false, false, None, None, false, "importedAt", "desc", Some(12));
    let history: Vec<Value> = {
        let guard = state.db.conn.lock().unwrap();
        guard
            .as_ref()
            .and_then(|c| {
                c.prepare("SELECT used_bytes, total_bytes, file_count, recorded_at FROM storage_history ORDER BY id DESC LIMIT 30")
                    .ok()
                    .and_then(|mut st| {
                        st.query_map([], |r| {
                            Ok(json!({
                                "usedBytes": r.get::<_, i64>(0)?,
                                "totalBytes": r.get::<_, i64>(1)?,
                                "fileCount": r.get::<_, i64>(2)?,
                                "recordedAt": r.get::<_, String>(3)?
                            }))
                        })
                        .ok()
                        .map(|rows| rows.flatten().collect())
                    })
            })
            .unwrap_or_default()
    };

    Json(json!({
        "volume": { "totalBytes": total, "freeBytes": free, "usedBytes": used, "available": avail },
        "totalFiles": total_files,
        "totalFolders": total_folders,
        "totalManagedBytes": total_managed,
        "byCategory": by_category,
        "largestFiles": largest_files,
        "largestFolders": largest_folders,
        "duplicates": duplicates,
        "emptyFolders": empty_folders,
        "recentlyAdded": recently_added,
        "history": history
    }))
    .into_response()
}

async fn api_scanner_status(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    Json(state.scanner_state.lock().unwrap().clone()).into_response()
}

async fn api_scanner_start(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let result = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || run_storage_scan(&db, &root)
    })
    .await
    .unwrap_or_default();
    *state.scanner_state.lock().unwrap() = result.clone();
    Json(result).into_response()
}

async fn api_recycle_bin(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    if let Err(resp) = require_root(&state) {
        return resp;
    }
    let items = state.db.list_files(None, false, true, None, None, false, "modifiedAt", "desc", None);
    let total_bytes: i64 = items.iter().map(|i| i.size).sum();
    Json(json!({"items": items, "totalBytes": total_bytes})).into_response()
}

async fn api_recycle_restore(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let Some(file) = state.db.get_file_by_id(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "File not found"}))).into_response();
    };
    if !file.is_deleted {
        return Json(file).into_response();
    }
    let orig_rel = file
        .original_relative_path
        .clone()
        .unwrap_or_else(|| format!("Files/{}", file.name));
    let orig_dir = Path::new(&orig_rel)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("Files");
    let (restored_rel, restored_name) = match allocate_unique_path(&root, orig_dir, &file.name) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    };
    let bin_abs = resolve_inside_root(&root, &file.relative_path).unwrap();
    let dst_abs = resolve_inside_root(&root, &restored_rel).unwrap();
    if let Some(parent) = dst_abs.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if bin_abs.exists() {
        if let Err(e) = fs::rename(&bin_abs, &dst_abs) {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response();
        }
    }
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "UPDATE files SET name = ?1, relative_path = ?2, folder_id = original_folder_id, is_deleted = 0, deleted_at = NULL, original_relative_path = NULL, original_folder_id = NULL WHERE id = ?3",
                params![restored_name, restored_rel, id],
            );
        }
    }
    Json(state.db.get_file_by_id(&id).unwrap()).into_response()
}

async fn api_recycle_perm_delete(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    if let Some(file) = state.db.get_file_by_id(&id) {
        if let Ok(abs) = resolve_inside_root(&root, &file.relative_path) {
            let _ = fs::remove_file(abs);
        }
        if let Some(ref thumb) = file.thumbnail_path {
            if let Ok(t_abs) = resolve_inside_root(&root, thumb) {
                let _ = fs::remove_file(t_abs);
            }
        }
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute("DELETE FROM files WHERE id = ?1", params![id]);
        }
    }
    Json(json!({"ok": true})).into_response()
}

async fn api_recycle_empty(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let items = state.db.list_files(None, false, true, None, None, false, "name", "asc", None);
    let count = items.len();
    for file in items {
        if let Ok(abs) = resolve_inside_root(&root, &file.relative_path) {
            let _ = fs::remove_file(abs);
        }
        if let Some(ref thumb) = file.thumbnail_path {
            if let Ok(t_abs) = resolve_inside_root(&root, thumb) {
                let _ = fs::remove_file(t_abs);
            }
        }
    }
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute("DELETE FROM files WHERE is_deleted = 1", []);
        }
    }
    Json(json!({"removed": count})).into_response()
}

async fn api_server_status(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    Json(state.lan_status.lock().unwrap().clone()).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerStartBody {
    port: Option<u16>,
    bind_lan: Option<bool>,
}

async fn api_server_start(
    headers: HeaderMap,
    State(state): State<AppState>,
    body: Option<Json<ServerStartBody>>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    if let Err(resp) = require_root(&state) {
        return resp;
    }
    let port_ov = body.as_ref().and_then(|b| b.port);
    let bind_ov = body.as_ref().and_then(|b| b.bind_lan);
    match start_lan_listener(
        state.db.clone(),
        state.lan_status.clone(),
        state.lan_shutdown.clone(),
        port_ov,
        bind_ov,
    )
    .await
    {
        Ok(st) => Json(st).into_response(),
        Err(err) => (
            StatusCode::CONFLICT,
            Json(json!({"error": err, "status": state.lan_status.lock().unwrap().clone()})),
        )
            .into_response(),
    }
}

async fn api_server_stop(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    if let Some(tx) = state.lan_shutdown.lock().unwrap().take() {
        let _ = tx.send(());
    }
    let mut st = state.lan_status.lock().unwrap();
    st.running = false;
    st.started_at = None;
    st.lan_urls.clear();
    let _ = state.db.set_config_kv("serverEnabled", "false");
    state.db.log_event("info", "server", "Storage server stopped");
    Json(st.clone()).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerConfigBody {
    port: Option<u16>,
    auto_start: Option<bool>,
    bind_lan: Option<bool>,
}

async fn api_server_config(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<ServerConfigBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    if let Some(p) = body.port {
        if p < 1024 {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "Port must be between 1024 and 65535"})),
            )
                .into_response();
        }
        let _ = state.db.set_config_kv("serverPort", &p.to_string());
    }
    if let Some(a) = body.auto_start {
        let _ = state
            .db
            .set_config_kv("serverAutoStart", if a { "true" } else { "false" });
    }
    if let Some(b) = body.bind_lan {
        let _ = state
            .db
            .set_config_kv("serverBindLan", if b { "true" } else { "false" });
    }
    let was_running = state.lan_status.lock().unwrap().running;
    if was_running {
        if let Some(tx) = state.lan_shutdown.lock().unwrap().take() {
            let _ = tx.send(());
        }
        state.lan_status.lock().unwrap().running = false;
        let _ = start_lan_listener(
            state.db.clone(),
            state.lan_status.clone(),
            state.lan_shutdown.clone(),
            None,
            None,
        )
        .await;
    }
    Json(json!({
        "settings": state.db.get_settings(),
        "status": state.lan_status.lock().unwrap().clone()
    }))
    .into_response()
}

async fn api_devices_list(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    Json(json!({"devices": state.db.list_devices()})).into_response()
}

async fn api_devices_pairing_qr(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    if let Err(resp) = require_root(&state) {
        return resp;
    }
    let code: String = rand::thread_rng().gen_range(100000..999999).to_string();
    let secret = format!("{}{}", DbManager::new_id().replace('-', ""), DbManager::new_id().replace('-', ""));
    let now = Utc::now();
    let expires_at = (now + chrono::Duration::minutes(5)).to_rfc3339();
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "INSERT INTO pairing_sessions (id, code, secret, expires_at, used, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                params![DbManager::new_id(), code, secret, expires_at, now.to_rfc3339()],
            );
        }
    }
    let settings = state.db.get_settings();
    let srv = state.lan_status.lock().unwrap().clone();
    let ips = get_lan_ipv4_addresses();
    let payload = json!({
        "protocol": "haven-pair-v1",
        "host": ips.first().cloned().unwrap_or_else(|| "127.0.0.1".to_string()),
        "hosts": ips,
        "port": if srv.running { srv.port } else { settings.server_port },
        "serverRunning": srv.running,
        "code": code,
        "secret": secret,
        "expiresAt": expires_at
    });
    let qr_svg = QrCode::new(payload.to_string().as_bytes())
        .map(|q| {
            q.render::<svg::Color>()
                .min_dimensions(240, 240)
                .dark_color(svg::Color("#18181B"))
                .light_color(svg::Color("#FFFFFF"))
                .build()
        })
        .unwrap_or_default();
    let b64 = base64::engine::general_purpose::STANDARD.encode(qr_svg.as_bytes());
    let qr_data_url = format!("data:image/svg+xml;base64,{}", b64);
    Json(json!({"payload": payload, "qrDataUrl": qr_data_url})).into_response()
}

#[derive(Deserialize)]
struct PermsBody {
    permissions: DevicePermissions,
}

async fn api_device_permissions(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
    Json(body): Json<PermsBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let p_json = serde_json::to_string(&body.permissions).unwrap();
    let guard = state.db.conn.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        let _ = conn.execute(
            "UPDATE devices SET permissions_json = ?1 WHERE id = ?2",
            params![p_json, id],
        );
    }
    Json(json!({"ok": true})).into_response()
}

async fn api_device_revoke(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "UPDATE devices SET is_revoked = 1, status = 'revoked' WHERE id = ?1",
                params![id],
            );
        }
    }
    state.db.log_event("warn", "auth", &format!("Revoked device access ({})", id));
    Json(json!({"ok": true})).into_response()
}

async fn api_device_delete(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let guard = state.db.conn.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        let _ = conn.execute("DELETE FROM devices WHERE id = ?1", params![id]);
    }
    Json(json!({"ok": true})).into_response()
}

async fn api_sync_get(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
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
                    .map(|rows| rows.flatten().collect())
                })
        })
        .unwrap_or_default();

    let history: Vec<SyncHistoryRecord> = guard
        .as_ref()
        .and_then(|c| {
            c.prepare("SELECT * FROM sync_history ORDER BY created_at DESC LIMIT 50")
                .ok()
                .and_then(|mut st| {
                    st.query_map([], |r| {
                        Ok(SyncHistoryRecord {
                            id: r.get("id")?,
                            rule_id: r.get("rule_id")?,
                            status: r.get("status")?,
                            files_synced: r.get("files_synced")?,
                            conflicts_detected: r.get("conflicts_detected")?,
                            message: r.get("message")?,
                            created_at: r.get("created_at")?,
                        })
                    })
                    .ok()
                    .map(|rows| rows.flatten().collect())
                })
        })
        .unwrap_or_default();

    let paired_count = state.db.list_devices().into_iter().filter(|d| !d.is_revoked).count();
    Json(json!({
        "stage2Required": paired_count == 0,
        "pairedDeviceCount": paired_count,
        "rules": rules,
        "history": history
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSyncRuleBody {
    name: String,
    direction: String,
    local_folder_id: Option<String>,
    remote_path: String,
    exclusions: Option<Vec<String>>,
    conflict_policy: Option<String>,
    device_id: Option<String>,
}

async fn api_sync_create(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<CreateSyncRuleBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    if let Err(resp) = require_root(&state) {
        return resp;
    }
    let local_rel = body
        .local_folder_id
        .as_deref()
        .and_then(|fid| state.db.get_folder_by_id(fid))
        .map(|f| f.relative_path)
        .unwrap_or_else(|| "Files".to_string());
    let has_device = body.device_id.is_some()
        || state.db.list_devices().into_iter().any(|d| !d.is_revoked);
    let rule = SyncRuleRecord {
        id: DbManager::new_id(),
        device_id: body.device_id.filter(|s| !s.is_empty()),
        name: body.name,
        direction: body.direction,
        local_folder_id: body.local_folder_id,
        local_folder_path: local_rel,
        remote_path: body.remote_path,
        exclusions: body.exclusions.unwrap_or_default(),
        conflict_policy: body.conflict_policy.unwrap_or_else(|| "keep_both".to_string()),
        enabled: has_device,
        status: if has_device { "idle" } else { "awaiting_device" }.to_string(),
        last_sync_at: None,
        created_at: Utc::now().to_rfc3339(),
    };
    let ex_json = serde_json::to_string(&rule.exclusions).unwrap_or_else(|_| "[]".to_string());
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "INSERT INTO sync_rules (id, device_id, name, direction, local_folder_id, local_folder_path, remote_path, exclusions_json, conflict_policy, enabled, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    rule.id,
                    rule.device_id,
                    rule.name,
                    rule.direction,
                    rule.local_folder_id,
                    rule.local_folder_path,
                    rule.remote_path,
                    ex_json,
                    rule.conflict_policy,
                    if rule.enabled { 1 } else { 0 },
                    rule.status,
                    rule.created_at
                ],
            );
        }
    }
    (StatusCode::CREATED, Json(rule)).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchSyncRuleBody {
    enabled: Option<bool>,
    device_id: Option<String>,
}

async fn api_sync_patch(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
    Json(body): Json<PatchSyncRuleBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let has_device = state.db.list_devices().into_iter().any(|d| !d.is_revoked);
    let enabled = body.enabled.unwrap_or(true);
    let next_status = if !enabled {
        "disabled"
    } else if has_device || body.device_id.is_some() {
        "idle"
    } else {
        "awaiting_device"
    };
    {
        let guard = state.db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let _ = conn.execute(
                "UPDATE sync_rules SET enabled = ?1, status = ?2, device_id = COALESCE(?3, device_id) WHERE id = ?4",
                params![if enabled { 1 } else { 0 }, next_status, body.device_id, id],
            );
        }
    }
    Json(json!({"id": id, "enabled": enabled, "status": next_status})).into_response()
}

async fn api_sync_delete(
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let guard = state.db.conn.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        let _ = conn.execute("DELETE FROM sync_rules WHERE id = ?1", params![id]);
    }
    Json(json!({"ok": true})).into_response()
}

async fn api_settings_get(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    Json(json!({
        "settings": state.db.get_settings(),
        "dbPath": state.db.get_db_path().map(|p| p.to_string_lossy().to_string()),
        "configDir": state.db.config_dir.to_string_lossy()
    }))
    .into_response()
}

async fn api_settings_patch(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    if let Err(resp) = require_root(&state) {
        return resp;
    }
    if let Some(obj) = body.as_object() {
        for (k, v) in obj {
            let allowed = matches!(
                k.as_str(),
                "theme"
                    | "language"
                    | "startWithWindows"
                    | "minimizeToTray"
                    | "closeToTray"
                    | "warningThresholdPct"
                    | "serverAutoStart"
                    | "maxConcurrentTransfers"
                    | "transferRetryLimit"
                    | "scheduledScanMinutes"
            );
            if !allowed {
                continue;
            }
            let str_val = match v {
                Value::String(s) => s.clone(),
                Value::Bool(b) => if *b { "true".into() } else { "false".into() },
                Value::Number(n) => n.to_string(),
                _ => continue,
            };
            let _ = state.db.set_config_kv(k, &str_val);
            if k == "startWithWindows" {
                let enable = str_val == "true";
                let guard = state.app_handle.lock().unwrap();
                if let Some(app) = guard.as_ref() {
                    let autostart = app.autolaunch();
                    if enable {
                        let _ = autostart.enable();
                    } else {
                        let _ = autostart.disable();
                    }
                }
            }
        }
    }
    Json(json!({"settings": state.db.get_settings()})).into_response()
}

async fn api_db_status(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let backups_dir = root.join("Backups");
    let mut backups = Vec::new();
    if let Ok(entries) = fs::read_dir(&backups_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("sqlite") {
                if let Ok(meta) = fs::metadata(&p) {
                    let ts = meta
                        .modified()
                        .ok()
                        .map(|t| chrono::DateTime::<Utc>::from(t).to_rfc3339())
                        .unwrap_or_default();
                    backups.push(json!({
                        "name": entry.file_name().to_string_lossy(),
                        "path": p.to_string_lossy(),
                        "size": meta.len(),
                        "createdAt": ts
                    }));
                }
            }
        }
    }
    let db_path = state.db.get_db_path();
    let db_size = db_path
        .as_ref()
        .and_then(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    let (ok, res) = state.db.check_integrity();
    Json(json!({
        "dbPath": db_path.map(|p| p.to_string_lossy().to_string()),
        "dbSize": db_size,
        "integrity": { "ok": ok, "result": res },
        "backups": backups
    }))
    .into_response()
}

async fn api_db_backup(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match state.db.backup_database(&root) {
        Ok((backup_path, size, created_at)) => (
            StatusCode::CREATED,
            Json(json!({"backupPath": backup_path, "size": size, "createdAt": created_at})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreBody {
    backup_name: String,
}

async fn api_db_restore(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<RestoreBody>,
) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let root = match require_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let clean = Path::new(&body.backup_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let Ok(backup_path) = resolve_inside_root(&root, &format!("Backups/{}", clean)) else {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid backup name"}))).into_response();
    };
    match state.db.restore_database(&backup_path) {
        Ok(msg) => Json(json!({"ok": true, "message": msg})).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

async fn api_db_integrity(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_auth(&headers, None, &state) {
        return unauth();
    }
    let (ok, res) = state.db.check_integrity();
    Json(json!({"ok": ok, "result": res})).into_response()
}

#[derive(Deserialize)]
struct LogsQuery {
    category: Option<String>,
    level: Option<String>,
    token: Option<String>,
}

async fn api_logs_list(
    headers: HeaderMap,
    Query(q): Query<LogsQuery>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, q.token.as_deref(), &state) {
        return unauth();
    }
    let logs = state.db.list_logs(250, q.category.as_deref(), q.level.as_deref());
    Json(json!({"logs": logs})).into_response()
}

async fn api_logs_export(
    headers: HeaderMap,
    Query(q): Query<LogsQuery>,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, q.token.as_deref(), &state) {
        return unauth();
    }
    let logs = state.db.list_logs(1000, None, None);
    let payload = serde_json::to_string_pretty(&json!({
        "exportedAt": Utc::now().to_rfc3339(),
        "logs": logs
    }))
    .unwrap_or_default();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"haven-logs.json\"",
        )
        .body(axum::body::Body::from(payload))
        .unwrap()
}

#[tauri::command]
fn get_local_api_url(port: tauri::State<'_, u16>) -> String {
    format!("http://127.0.0.1:{}/api/v1", *port)
}

#[tauri::command]
fn pick_storage_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose Haven Storage Folder")
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Haven");
    let db = Arc::new(DbManager::new(config_dir));
    let settings = db.get_settings();
    let app_handle_slot = Arc::new(Mutex::new(None));

    let state = AppState {
        db: db.clone(),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        lan_shutdown: Arc::new(Mutex::new(None)),
        lan_status: Arc::new(Mutex::new(LanServerStatus {
            running: false,
            port: settings.server_port,
            bind_address: if settings.server_bind_lan {
                "0.0.0.0".to_string()
            } else {
                "127.0.0.1".to_string()
            },
            lan_urls: vec![],
            started_at: None,
            active_connections: 0,
            last_error: None,
        })),
        scanner_state: Arc::new(Mutex::new(ScannerState::default())),
        app_handle: app_handle_slot.clone(),
    };

    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
    let listener = rt
        .block_on(TcpListener::bind("127.0.0.1:0"))
        .expect("Failed to bind local IPC HTTP server");
    let api_port = listener.local_addr().unwrap().port();

    let router = Router::new()
        .route("/api/v1/health", get(api_health))
        .route("/api/v1/docs", get(api_docs))
        .route("/api/v1/auth/status", get(api_auth_status))
        .route("/api/v1/auth/setup", post(api_auth_setup))
        .route("/api/v1/auth/login", post(api_auth_login))
        .route("/api/v1/auth/logout", post(api_auth_logout))
        .route("/api/v1/auth/sessions", get(api_auth_sessions))
        .route("/api/v1/auth/sessions/{id}", delete(api_auth_revoke_session))
        .route("/api/v1/setup/drives", get(api_drives))
        .route("/api/v1/setup/validate", post(api_validate_path))
        .route("/api/v1/setup/initialize", post(api_initialize))
        .route("/api/v1/storage/relocate", post(api_relocate))
        .route("/api/v1/dashboard", get(api_dashboard))
        .route("/api/v1/files", get(api_list_files))
        .route("/api/v1/folders", post(api_create_folder))
        .route("/api/v1/folders/{id}", patch(api_rename_folder).delete(api_delete_folder))
        .route("/api/v1/files/{id}", get(api_get_file_details).patch(api_update_file).delete(api_delete_file))
        .route("/api/v1/files/{id}/move", post(api_move_file))
        .route("/api/v1/files/{id}/copy", post(api_copy_file))
        .route("/api/v1/files/batch-delete", post(api_batch_delete))
        .route("/api/v1/files/{id}/content", get(api_file_content))
        .route("/api/v1/files/{id}/thumbnail", get(api_file_thumbnail))
        .route("/api/v1/files/{id}/open", post(api_open_in_os))
        .route("/api/v1/media", get(api_media))
        .route("/api/v1/transfers", get(api_transfers_list))
        .route("/api/v1/transfers/upload", post(api_upload_init))
        .route("/api/v1/transfers/{id}/chunks/{index}", put(api_upload_chunk))
        .route("/api/v1/transfers/{id}/complete", post(api_upload_complete))
        .route("/api/v1/transfers/{id}/pause", post(api_transfer_pause))
        .route("/api/v1/transfers/{id}/resume", post(api_transfer_resume))
        .route("/api/v1/transfers/{id}/retry", post(api_transfer_retry))
        .route("/api/v1/transfers/{id}/cancel", post(api_transfer_cancel))
        .route("/api/v1/transfers/history", delete(api_transfers_clear_history))
        .route("/api/v1/analytics", get(api_analytics))
        .route("/api/v1/scanner/status", get(api_scanner_status))
        .route("/api/v1/scanner/start", post(api_scanner_start))
        .route("/api/v1/recycle-bin", get(api_recycle_bin))
        .route("/api/v1/recycle-bin/{id}/restore", post(api_recycle_restore))
        .route("/api/v1/recycle-bin/{id}", delete(api_recycle_perm_delete))
        .route("/api/v1/recycle-bin/empty", post(api_recycle_empty))
        .route("/api/v1/server/status", get(api_server_status))
        .route("/api/v1/server/start", post(api_server_start))
        .route("/api/v1/server/stop", post(api_server_stop))
        .route("/api/v1/server/config", patch(api_server_config))
        .route("/api/v1/devices", get(api_devices_list))
        .route("/api/v1/devices/pairing-qr", post(api_devices_pairing_qr))
        .route("/api/v1/devices/{id}/permissions", patch(api_device_permissions))
        .route("/api/v1/devices/{id}/revoke", post(api_device_revoke))
        .route("/api/v1/devices/{id}", delete(api_device_delete))
        .route("/api/v1/sync", get(api_sync_get))
        .route("/api/v1/sync/rules", post(api_sync_create))
        .route("/api/v1/sync/rules/{id}", patch(api_sync_patch).delete(api_sync_delete))
        .route("/api/v1/settings", get(api_settings_get).patch(api_settings_patch))
        .route("/api/v1/database/status", get(api_db_status))
        .route("/api/v1/database/backup", post(api_db_backup))
        .route("/api/v1/database/restore", post(api_db_restore))
        .route("/api/v1/database/integrity", post(api_db_integrity))
        .route("/api/v1/database/rebuild", post(api_scanner_start))
        .route("/api/v1/logs", get(api_logs_list))
        .route("/api/v1/logs/export", get(api_logs_export))
        .layer(DefaultBodyLimit::max(40 * 1024 * 1024))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .with_state(state.clone());

    rt.spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    // Auto-start LAN server if enabled in persisted settings
    if settings.server_auto_start && db.is_open() {
        let db_auto = db.clone();
        let st_auto = state.lan_status.clone();
        let sh_auto = state.lan_shutdown.clone();
        rt.spawn(async move {
            let _ = start_lan_listener(db_auto, st_auto, sh_auto, None, None).await;
        });
    }

    let db_for_events = db.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(api_port)
        .invoke_handler(tauri::generate_handler![get_local_api_url, pick_storage_folder])
        .setup(move |app| {
            *app_handle_slot.lock().unwrap() = Some(app.handle().clone());
            let show_i = MenuItem::with_id(app, "show", "Open Haven", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Haven Completely", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Haven — Personal Storage Hub")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let settings = db_for_events.get_settings();
                if settings.close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Haven desktop application");
}
