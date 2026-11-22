use chrono::Utc;
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;

use crate::db::{DbManager, FileRecord, TransferRecord};
use crate::storage::{
    allocate_unique_path, classify_file, generate_thumbnail, get_volume_stats, resolve_inside_root,
    sha256_file,
};

pub fn create_upload_session(
    db: &DbManager,
    storage_root: &Path,
    file_name: &str,
    total_bytes: i64,
    folder_id: Option<&str>,
    chunk_size_opt: Option<i64>,
    sha256_expected: Option<String>,
    device_id: Option<String>,
) -> Result<TransferRecord, String> {
    if total_bytes < 0 {
        return Err("Invalid file size".to_string());
    }
    let (_total, free, _used, avail) = get_volume_stats(storage_root);
    if avail && (total_bytes as u64) + 1024 * 1024 > free {
        return Err("Insufficient disk space on target volume".to_string());
    }

    let dir_rel = if let Some(fid) = folder_id {
        db.get_folder_by_id(fid)
            .map(|f| f.relative_path)
            .unwrap_or_else(|| "Files".to_string())
    } else {
        "Files".to_string()
    };

    let (target_rel, clean_name) = allocate_unique_path(storage_root, &dir_rel, file_name)?;
    let chunk_size = chunk_size_opt.unwrap_or(4 * 1024 * 1024).clamp(1024, 32 * 1024 * 1024);
    let total_chunks = if total_bytes == 0 {
        1
    } else {
        ((total_bytes + chunk_size - 1) / chunk_size).max(1)
    };

    let temp_dir = storage_root.join("Temp");
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let id = DbManager::new_id();
    let part_path = temp_dir.join(format!("{}.part", id));
    fs::File::create(&part_path).map_err(|e| e.to_string())?;

    let settings = db.get_settings();
    let now = Utc::now().to_rfc3339();
    {
        let guard = db.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or("Database not initialized")?;
        conn.execute(
            "INSERT INTO transfers (id, direction, file_id, file_name, target_relative_path, folder_id, total_bytes, transferred_bytes, chunk_size, total_chunks, verified_chunks_json, status, speed_bps, sha256_expected, retry_count, max_retries, device_id, created_at, updated_at)
             VALUES (?1, 'upload', NULL, ?2, ?3, ?4, ?5, 0, ?6, ?7, '[]', 'active', 0, ?8, 0, ?9, ?10, ?11, ?11)",
            params![
                id,
                clean_name,
                target_rel,
                folder_id,
                total_bytes,
                chunk_size,
                total_chunks,
                sha256_expected,
                settings.transfer_retry_limit,
                device_id,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    db.get_transfer_by_id(&id)
        .ok_or_else(|| "Failed to load created transfer".to_string())
}

pub fn write_chunk(
    db: &DbManager,
    storage_root: &Path,
    transfer_id: &str,
    chunk_index: i64,
    data: &[u8],
    chunk_sha256: Option<&str>,
) -> Result<TransferRecord, String> {
    let tr = db
        .get_transfer_by_id(transfer_id)
        .ok_or_else(|| "Transfer session not found".to_string())?;
    if tr.status == "cancelled" {
        return Err("Transfer was cancelled".to_string());
    }
    if tr.status == "paused" {
        return Err("Transfer is paused".to_string());
    }
    if chunk_index < 0 || chunk_index >= tr.total_chunks {
        return Err(format!("Chunk index {} out of range", chunk_index));
    }

    if let Some(expected_hex) = chunk_sha256 {
        let actual_hex = hex::encode(Sha256::digest(data));
        if !actual_hex.eq_ignore_ascii_case(expected_hex.trim()) {
            return Err("Chunk SHA-256 verification failed".to_string());
        }
    }

    let part_path = storage_root.join("Temp").join(format!("{}.part", tr.id));
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .open(&part_path)
        .map_err(|e| e.to_string())?;
    let offset = (chunk_index as u64) * (tr.chunk_size as u64);
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())?;
    file.sync_data().map_err(|e| e.to_string())?;

    let mut verified: HashSet<i64> = tr.verified_chunks.into_iter().collect();
    verified.insert(chunk_index);
    let mut verified_vec: Vec<i64> = verified.into_iter().collect();
    verified_vec.sort_unstable();

    let mut transferred = 0i64;
    for idx in &verified_vec {
        if *idx == tr.total_chunks - 1 {
            let rem = tr.total_bytes - (*idx) * tr.chunk_size;
            transferred += rem.max(0);
        } else {
            transferred += tr.chunk_size;
        }
    }
    transferred = transferred.min(tr.total_bytes);

    let verified_json = serde_json::to_string(&verified_vec).unwrap_or_else(|_| "[]".to_string());
    let now = Utc::now().to_rfc3339();
    {
        let guard = db.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or("Database not initialized")?;
        conn.execute(
            "UPDATE transfers SET verified_chunks_json = ?1, transferred_bytes = ?2, status = 'active', updated_at = ?3 WHERE id = ?4",
            params![verified_json, transferred, now, tr.id],
        )
        .map_err(|e| e.to_string())?;
    }

    db.get_transfer_by_id(transfer_id)
        .ok_or_else(|| "Transfer missing".to_string())
}

pub fn finalize_upload(
    db: &DbManager,
    storage_root: &Path,
    transfer_id: &str,
) -> Result<(TransferRecord, FileRecord), String> {
    let tr = db
        .get_transfer_by_id(transfer_id)
        .ok_or_else(|| "Transfer session not found".to_string())?;
    if (tr.verified_chunks.len() as i64) < tr.total_chunks {
        return Err("Upload is incomplete; missing chunks".to_string());
    }

    let part_path = storage_root.join("Temp").join(format!("{}.part", tr.id));
    if !part_path.exists() {
        return Err("Temporary upload payload missing".to_string());
    }
    if tr.total_bytes > 0 {
        let f = OpenOptions::new().write(true).open(&part_path).map_err(|e| e.to_string())?;
        f.set_len(tr.total_bytes as u64).map_err(|e| e.to_string())?;
    }

    let sha_actual = sha256_file(&part_path)?;
    if let Some(ref exp) = tr.sha256_expected {
        if !exp.eq_ignore_ascii_case(&sha_actual) {
            return Err("Final file SHA-256 verification failed".to_string());
        }
    }

    let dir_rel = Path::new(&tr.target_relative_path)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("Files");
    let (final_rel, final_name) = allocate_unique_path(storage_root, dir_rel, &tr.file_name)?;
    let final_abs = resolve_inside_root(storage_root, &final_rel)?;
    if let Some(parent) = final_abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::rename(&part_path, &final_abs).is_err() {
        fs::copy(&part_path, &final_abs).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&part_path);
    }

    let (cat, ext, mime) = classify_file(&final_name);
    let file_id = DbManager::new_id();
    let thumb = generate_thumbnail(storage_root, &final_abs, &file_id, cat);
    let now = Utc::now().to_rfc3339();
    let origin = if tr.device_id.is_some() {
        "mobile-device"
    } else {
        "windows-pc"
    };

    {
        let guard = db.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or("Database not initialized")?;
        conn.execute(
            "INSERT INTO files (id, name, relative_path, folder_id, size, mime_type, category, extension, created_at, modified_at, imported_at, sha256, thumbnail_path, is_favorite, tags_json, backup_status, device_origin, transfer_status, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9, ?10, ?11, 0, '[]', 'local_only', ?12, 'complete', 0)",
            params![
                file_id,
                final_name,
                final_rel,
                tr.folder_id,
                tr.total_bytes,
                mime,
                cat,
                ext,
                now,
                sha_actual,
                thumb,
                origin
            ],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE transfers SET status = 'completed', file_id = ?1, target_relative_path = ?2, sha256_actual = ?3, updated_at = ?4, completed_at = ?4 WHERE id = ?5",
            params![file_id, final_rel, sha_actual, now, tr.id],
        )
        .map_err(|e| e.to_string())?;
    }

    db.log_event(
        "info",
        "transfer",
        &format!("Imported {} ({} bytes)", final_name, tr.total_bytes),
    );
    let updated_tr = db.get_transfer_by_id(&tr.id).unwrap();
    let file_rec = db.get_file_by_id(&file_id).unwrap();
    Ok((updated_tr, file_rec))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunked_upload_resume_and_checksum() {
        let dir = std::env::temp_dir().join(format!("haven-tr-{}", DbManager::new_id()));
        let cfg = dir.join("cfg");
        let root = dir.join("HavenStorage");
        for s in ["Files", "Thumbnails", "Database", "Temp", "Backups", "RecycleBin"] {
            fs::create_dir_all(root.join(s)).unwrap();
        }
        let db = DbManager::new(cfg);
        db.open(&root.join("Database").join("haven.db")).unwrap();

        let payload = b"0123456789ABCDEFhello-haven-chunk-test";
        let full_hash = hex::encode(Sha256::digest(payload));
        let tr = create_upload_session(
            &db,
            &root,
            "chunked.txt",
            payload.len() as i64,
            None,
            Some(16),
            Some(full_hash.clone()),
            None,
        )
        .unwrap();
        assert_eq!(tr.total_chunks, 3);

        // Bad chunk hash rejected
        let bad = write_chunk(
            &db,
            &root,
            &tr.id,
            0,
            &payload[0..16],
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
        );
        assert!(bad.is_err());

        // Write valid chunks
        write_chunk(&db, &root, &tr.id, 0, &payload[0..16], None).unwrap();
        write_chunk(&db, &root, &tr.id, 1, &payload[16..32], None).unwrap();
        write_chunk(&db, &root, &tr.id, 2, &payload[32..], None).unwrap();

        let (done_tr, file) = finalize_upload(&db, &root, &tr.id).unwrap();
        assert_eq!(done_tr.status, "completed");
        assert_eq!(file.sha256.as_deref(), Some(full_hash.as_str()));
        assert_eq!(
            fs::read(resolve_inside_root(&root, &file.relative_path).unwrap()).unwrap(),
            payload
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
