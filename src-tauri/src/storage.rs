use axum::{
    body::Body,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use image::ImageReader;
use rusqlite::params;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, SeekFrom};
use std::path::{Component, Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::db::DbManager;

pub const HAVEN_SUBDIRS: &[&str] = &[
    "Files",
    "Photos",
    "Videos",
    "Documents",
    "Audio",
    "Archives",
    "Other",
    "Thumbnails",
    "Database",
    "Backups",
    "Temp",
    "RecycleBin",
];

pub const USER_ROOT_DIRS: &[&str] = &[
    "Files",
    "Photos",
    "Videos",
    "Documents",
    "Audio",
    "Archives",
    "Other",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerState {
    pub is_running: bool,
    pub last_run_at: Option<String>,
    pub scanned_count: usize,
    pub new_files: usize,
    pub missing_files: usize,
    pub moved_files: usize,
    pub hashed_files: usize,
    pub thumbnails_generated: usize,
    pub duplicates_found: usize,
    pub errors: Vec<String>,
}

impl Default for ScannerState {
    fn default() -> Self {
        Self {
            is_running: false,
            last_run_at: None,
            scanned_count: 0,
            new_files: 0,
            missing_files: 0,
            moved_files: 0,
            hashed_files: 0,
            thumbnails_generated: 0,
            duplicates_found: 0,
            errors: vec![],
        }
    }
}

pub fn resolve_inside_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let clean = rel.replace('\\', "/");
    let mut joined = root.to_path_buf();
    for comp in Path::new(&clean).components() {
        match comp {
            Component::Normal(p) => joined.push(p),
            Component::CurDir => {}
            _ => return Err("Access denied: path escapes storage root".to_string()),
        }
    }
    Ok(joined)
}

pub fn to_rel_posix(root: &Path, abs: &Path) -> Result<String, String> {
    let rel = abs
        .strip_prefix(root)
        .map_err(|_| "Access denied: path outside storage root".to_string())?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    Ok(parts.join("/"))
}

pub fn sanitize_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err("Invalid file or folder name".to_string());
    }
    let clean: String = trimmed
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let final_name = clean.trim().to_string();
    if final_name.is_empty() || final_name == "." || final_name == ".." {
        return Err("Invalid file or folder name".to_string());
    }
    Ok(final_name)
}

pub fn allocate_unique_path(root: &Path, dir_rel: &str, desired_name: &str) -> Result<(String, String), String> {
    let clean = sanitize_name(desired_name)?;
    let p = Path::new(&clean);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&clean)
        .to_string();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();

    let mut counter = 0usize;
    loop {
        let candidate_name = if counter == 0 {
            clean.clone()
        } else {
            format!("{} ({}){}", stem, counter, ext)
        };
        let rel = if dir_rel.is_empty() {
            candidate_name.clone()
        } else {
            format!("{}/{}", dir_rel.trim_end_matches('/'), candidate_name)
        };
        let abs = resolve_inside_root(root, &rel)?;
        if !abs.exists() {
            return Ok((rel, candidate_name));
        }
        counter += 1;
    }
}

pub fn classify_file(name: &str) -> (&'static str, String, String) {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| format!(".{}", s.to_lowercase()))
        .unwrap_or_default();
    let cat = match ext.as_str() {
        ".jpg" | ".jpeg" | ".png" | ".webp" | ".gif" | ".bmp" | ".heic" | ".tiff" | ".avif" | ".svg" => "photo",
        ".mp4" | ".mkv" | ".mov" | ".avi" | ".webm" | ".wmv" | ".m4v" => "video",
        ".mp3" | ".wav" | ".flac" | ".aac" | ".ogg" | ".m4a" | ".opus" => "audio",
        ".pdf" | ".doc" | ".docx" | ".xls" | ".xlsx" | ".ppt" | ".pptx" | ".txt" | ".md" | ".csv" => "document",
        ".zip" | ".rar" | ".7z" | ".tar" | ".gz" | ".iso" => "archive",
        ".exe" | ".msi" | ".bat" | ".ps1" | ".apk" => "executable",
        ".rs" | ".ts" | ".tsx" | ".js" | ".py" | ".json" | ".html" | ".css" | ".sql" => "code",
        _ => "other",
    };
    let mime = mime_guess::from_path(name)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    (cat, ext, mime)
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[derive(Debug, Clone)]
pub struct SystemDriveInfo {
    pub mount_point: String,
    pub label: String,
    pub file_system: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub is_read_only: bool,
}

#[cfg(windows)]
pub fn list_system_drives() -> Vec<SystemDriveInfo> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW, GetVolumeInformationW,
    };

    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_RAMDISK: u32 = 6;
    const FILE_READ_ONLY_VOLUME: u32 = 0x0008_0000;

    let mut drives = Vec::new();
    let mut buf = vec![0u16; 512];
    let len = unsafe { GetLogicalDriveStringsW(buf.len() as u32, buf.as_mut_ptr()) } as usize;
    if len == 0 {
        return drives;
    }

    let mut start = 0usize;
    while start < len.min(buf.len()) {
        let Some(rel_end) = buf[start..len.min(buf.len())].iter().position(|&c| c == 0) else {
            break;
        };
        let end = start + rel_end;
        if end == start {
            break;
        }
        let slice = &buf[start..end];
        let mount = String::from_utf16_lossy(slice);
        start = end + 1;

        let wide: Vec<u16> = OsStr::new(&mount)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let dtype = unsafe { GetDriveTypeW(wide.as_ptr()) };
        if !matches!(dtype, DRIVE_FIXED | DRIVE_REMOVABLE | DRIVE_REMOTE | DRIVE_RAMDISK) {
            continue;
        }

        let mut avail_caller = 0u64;
        let mut total = 0u64;
        let mut total_free = 0u64;
        let ok_space = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut avail_caller,
                &mut total,
                &mut total_free,
            )
        };
        if ok_space == 0 || total == 0 {
            continue;
        }

        let mut vol_name = [0u16; 260];
        let mut fs_name = [0u16; 64];
        let mut flags = 0u32;
        let ok_vol = unsafe {
            GetVolumeInformationW(
                wide.as_ptr(),
                vol_name.as_mut_ptr(),
                vol_name.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut flags,
                fs_name.as_mut_ptr(),
                fs_name.len() as u32,
            )
        };
        let label = if ok_vol != 0 {
            let z = vol_name.iter().position(|&c| c == 0).unwrap_or(0);
            String::from_utf16_lossy(&vol_name[..z])
        } else {
            String::new()
        };
        let file_system = if ok_vol != 0 {
            let z = fs_name.iter().position(|&c| c == 0).unwrap_or(0);
            String::from_utf16_lossy(&fs_name[..z])
        } else {
            "NTFS".to_string()
        };

        drives.push(SystemDriveInfo {
            mount_point: mount,
            label,
            file_system,
            total_bytes: total,
            free_bytes: avail_caller,
            is_read_only: (flags & FILE_READ_ONLY_VOLUME) != 0,
        });
    }
    drives
}

#[cfg(not(windows))]
pub fn list_system_drives() -> Vec<SystemDriveInfo> {
    vec![SystemDriveInfo {
        mount_point: "/".to_string(),
        label: "Root".to_string(),
        file_system: "ext4".to_string(),
        total_bytes: 0,
        free_bytes: 0,
        is_read_only: false,
    }]
}

#[cfg(windows)]
pub fn get_volume_stats(target_path: &Path) -> (u64, u64, u64, bool) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut probe = target_path.to_path_buf();
    while !probe.exists() {
        if let Some(p) = probe.parent() {
            probe = p.to_path_buf();
        } else {
            break;
        }
    }
    let wide: Vec<u16> = probe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut avail_caller = 0u64;
    let mut total = 0u64;
    let mut total_free = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut avail_caller,
            &mut total,
            &mut total_free,
        )
    };
    if ok != 0 && total > 0 {
        return (total, avail_caller, total.saturating_sub(avail_caller), true);
    }
    if let Some(first) = list_system_drives().first() {
        return (
            first.total_bytes,
            first.free_bytes,
            first.total_bytes.saturating_sub(first.free_bytes),
            first.total_bytes > 0,
        );
    }
    (0, 0, 0, false)
}

#[cfg(not(windows))]
pub fn get_volume_stats(_target_path: &Path) -> (u64, u64, u64, bool) {
    (0, 0, 0, false)
}

pub fn generate_thumbnail(root: &Path, abs_source: &Path, file_id: &str, category: &str) -> Option<String> {
    if category != "photo" {
        return None;
    }
    let ext = abs_source
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if matches!(ext.as_str(), "svg" | "heic" | "avif") {
        return None;
    }
    let thumb_dir = root.join("Thumbnails");
    let _ = fs::create_dir_all(&thumb_dir);
    let thumb_rel = format!("Thumbnails/{}.webp", file_id);
    let thumb_abs = root.join("Thumbnails").join(format!("{}.webp", file_id));

    let img = ImageReader::open(abs_source).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let resized = img.thumbnail(360, 360);
    resized.save_with_format(&thumb_abs, image::ImageFormat::WebP).ok()?;
    Some(thumb_rel)
}

pub fn ensure_folder_hierarchy(db: &DbManager, root: &Path, folder_rel: &str) -> Option<String> {
    let clean = folder_rel.trim_matches('/');
    if clean.is_empty() {
        return None;
    }
    if let Some(existing) = db.get_folder_by_rel(clean) {
        return Some(existing.id);
    }
    let parts: Vec<&str> = clean.split('/').collect();
    let mut parent_id: Option<String> = None;
    let mut cur_rel = String::new();
    let now = Utc::now().to_rfc3339();
    for part in parts {
        if !cur_rel.is_empty() {
            cur_rel.push('/');
        }
        cur_rel.push_str(part);
        if let Some(found) = db.get_folder_by_rel(&cur_rel) {
            parent_id = Some(found.id);
        } else {
            let abs = root.join(&cur_rel);
            let _ = fs::create_dir_all(&abs);
            let id = DbManager::new_id();
            let guard = db.conn.lock().unwrap();
            if let Some(conn) = guard.as_ref() {
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO folders (id, name, relative_path, parent_id, created_at, modified_at, is_favorite, device_origin)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, 'windows-pc')",
                    params![id, part, cur_rel, parent_id, now],
                );
            }
            drop(guard);
            parent_id = db.get_folder_by_rel(&cur_rel).map(|f| f.id);
        }
    }
    parent_id
}

pub fn run_storage_scan(db: &DbManager, root: &Path) -> ScannerState {
    let mut state = ScannerState {
        is_running: true,
        last_run_at: None,
        scanned_count: 0,
        new_files: 0,
        missing_files: 0,
        moved_files: 0,
        hashed_files: 0,
        thumbnails_generated: 0,
        duplicates_found: 0,
        errors: vec![],
    };

    let existing_files = db.list_files(None, false, false, None, None, false, "name", "asc", None);
    let mut by_rel: HashMap<String, crate::db::FileRecord> = HashMap::new();
    for f in existing_files {
        by_rel.insert(f.relative_path.clone(), f);
    }
    let mut seen_rels: HashSet<String> = HashSet::new();

    // Walk managed user directories
    let mut queue: Vec<PathBuf> = USER_ROOT_DIRS
        .iter()
        .map(|d| root.join(d))
        .filter(|p| p.exists())
        .collect();

    while let Some(dir) = queue.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let abs = entry.path();
            let Ok(meta) = fs::symlink_metadata(&abs) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if let Ok(rel_dir) = to_rel_posix(root, &abs) {
                    let _ = ensure_folder_hierarchy(db, root, &rel_dir);
                }
                queue.push(abs);
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            state.scanned_count += 1;
            let Ok(rel) = to_rel_posix(root, &abs) else {
                continue;
            };
            seen_rels.insert(rel.clone());

            let size = meta.len() as i64;
            let modified_at: String = meta
                .modified()
                .ok()
                .map(|t| chrono::DateTime::<Utc>::from(t).to_rfc3339())
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            let name = abs
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();

            if let Some(existing) = by_rel.get(&rel) {
                let mut sha = existing.sha256.clone();
                if sha.is_none() || existing.size != size {
                    if let Ok(h) = sha256_file(&abs) {
                        sha = Some(h);
                        state.hashed_files += 1;
                    }
                }
                let mut thumb = existing.thumbnail_path.clone();
                if thumb.is_none() && existing.category == "photo" {
                    if let Some(t) = generate_thumbnail(root, &abs, &existing.id, &existing.category) {
                        thumb = Some(t);
                        state.thumbnails_generated += 1;
                    }
                }
                if sha != existing.sha256 || thumb != existing.thumbnail_path || existing.size != size {
                    let guard = db.conn.lock().unwrap();
                    if let Some(conn) = guard.as_ref() {
                        let _ = conn.execute(
                            "UPDATE files SET size = ?1, modified_at = ?2, sha256 = ?3, thumbnail_path = ?4, transfer_status = 'complete' WHERE id = ?5",
                            params![size, modified_at, sha, thumb, existing.id],
                        );
                    }
                }
            } else {
                let parent_rel = abs
                    .parent()
                    .and_then(|p| to_rel_posix(root, p).ok())
                    .unwrap_or_else(|| "Files".to_string());
                let folder_id = ensure_folder_hierarchy(db, root, &parent_rel);
                let (cat, ext, mime) = classify_file(&name);
                let sha = sha256_file(&abs).ok();
                if sha.is_some() {
                    state.hashed_files += 1;
                }
                let file_id = DbManager::new_id();
                let thumb = generate_thumbnail(root, &abs, &file_id, cat);
                if thumb.is_some() {
                    state.thumbnails_generated += 1;
                }
                let now = Utc::now().to_rfc3339();
                let guard = db.conn.lock().unwrap();
                if let Some(conn) = guard.as_ref() {
                    let _ = conn.execute(
                        "INSERT OR IGNORE INTO files (id, name, relative_path, folder_id, size, mime_type, category, extension, created_at, modified_at, imported_at, sha256, thumbnail_path, is_favorite, tags_json, backup_status, device_origin, transfer_status, is_deleted)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, 0, '[]', 'local_only', 'windows-pc', 'complete', 0)",
                        params![file_id, name, rel, folder_id, size, mime, cat, ext, modified_at, now, sha, thumb],
                    );
                }
                state.new_files += 1;
            }
        }
    }

    // Check missing files
    for (rel, rec) in &by_rel {
        if !seen_rels.contains(rel) && rec.transfer_status != "missing" {
            let guard = db.conn.lock().unwrap();
            if let Some(conn) = guard.as_ref() {
                let _ = conn.execute(
                    "UPDATE files SET transfer_status = 'missing' WHERE id = ?1",
                    params![rec.id],
                );
            }
            state.missing_files += 1;
        }
    }

    // Count duplicate groups
    {
        let guard = db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            state.duplicates_found = conn
                .query_row(
                    "SELECT COUNT(*) FROM (SELECT sha256 FROM files WHERE is_deleted = 0 AND sha256 IS NOT NULL AND size > 0 GROUP BY sha256 HAVING COUNT(*) > 1)",
                    [],
                    |r| r.get::<_, usize>(0),
                )
                .unwrap_or(0);
        }
    }

    // Record storage snapshot
    let (total_b, _free_b, used_b, _) = get_volume_stats(root);
    {
        let guard = db.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let cnt: i64 = conn
                .query_row("SELECT COUNT(*) FROM files WHERE is_deleted = 0", [], |r| r.get(0))
                .unwrap_or(0);
            let _ = conn.execute(
                "INSERT INTO storage_history (used_bytes, total_bytes, file_count, recorded_at) VALUES (?1, ?2, ?3, ?4)",
                params![used_b as i64, total_b as i64, cnt, Utc::now().to_rfc3339()],
            );
        }
    }

    state.is_running = false;
    state.last_run_at = Some(Utc::now().to_rfc3339());
    db.log_event(
        "info",
        "scanner",
        &format!(
            "Storage scan completed: {} scanned, {} new, {} missing",
            state.scanned_count, state.new_files, state.missing_files
        ),
    );
    state
}

pub async fn stream_file_range_response(
    headers: &HeaderMap,
    abs_path: &Path,
    mime_type: &str,
    file_name: &str,
    download_disposition: bool,
) -> Response {
    let Ok(mut file) = tokio::fs::File::open(abs_path).await else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "File payload missing on disk"})),
        )
            .into_response();
    };
    let Ok(meta) = file.metadata().await else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Unable to stat file").into_response();
    };
    let file_size = meta.len();

    let mut builder = Response::builder()
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, mime_type);

    if download_disposition {
        let safe_name = file_name.replace('"', "_");
        builder = builder.header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", safe_name),
        );
    }

    if let Some(range_val) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if let Some(spec) = range_val.trim().strip_prefix("bytes=") {
            let mut parts = spec.splitn(2, '-');
            let s_str = parts.next().unwrap_or("");
            let e_str = parts.next().unwrap_or("");
            let start = if s_str.is_empty() { 0 } else { s_str.parse::<u64>().unwrap_or(u64::MAX) };
            let end = if e_str.is_empty() {
                file_size.saturating_sub(1)
            } else {
                e_str.parse::<u64>().unwrap_or(file_size.saturating_sub(1)).min(file_size.saturating_sub(1))
            };
            if file_size == 0 || start >= file_size || start > end {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{}", file_size))
                    .body(Body::empty())
                    .unwrap();
            }
            let len = end - start + 1;
            if file.seek(SeekFrom::Start(start)).await.is_err() {
                return (StatusCode::INTERNAL_SERVER_ERROR, "Seek failed").into_response();
            }
            let limited = file.take(len);
            let stream = ReaderStream::with_capacity(limited, 256 * 1024);
            return builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, file_size))
                .header(header::CONTENT_LENGTH, len.to_string())
                .body(Body::from_stream(stream))
                .unwrap();
        }
    }

    let stream = ReaderStream::with_capacity(file, 256 * 1024);
    builder
        .status(StatusCode::OK)
        .header(header::CONTENT_LENGTH, file_size.to_string())
        .body(Body::from_stream(stream))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_traversal_blocked() {
        let root = Path::new("/tmp/HavenStorage");
        assert!(resolve_inside_root(root, "../../etc/passwd").is_err());
        assert!(resolve_inside_root(root, "/etc/passwd").is_err());
        assert!(resolve_inside_root(root, "Files/sub/../secret").is_err());
        let ok = resolve_inside_root(root, "Files/Projects/doc.txt").unwrap();
        assert_eq!(ok, root.join("Files").join("Projects").join("doc.txt"));
    }

    #[test]
    fn test_unique_collision_naming() {
        let root = std::env::temp_dir().join(format!("haven-col-{}", DbManager::new_id()));
        fs::create_dir_all(root.join("Files")).unwrap();
        fs::write(root.join("Files").join("report.pdf"), b"v1").unwrap();
        let (rel, name) = allocate_unique_path(&root, "Files", "report.pdf").unwrap();
        assert_eq!(name, "report (1).pdf");
        assert_eq!(rel, "Files/report (1).pdf");
        let _ = fs::remove_dir_all(&root);
    }
}
