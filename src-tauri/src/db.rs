use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapConfig {
    pub storage_root: Option<String>,
    pub admin_passcode_hash: Option<String>,
    pub admin_passcode_salt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub storage_root: Option<String>,
    pub setup_completed: bool,
    pub theme: String,
    pub language: String,
    pub start_with_windows: bool,
    pub minimize_to_tray: bool,
    pub close_to_tray: bool,
    pub warning_threshold_pct: i64,
    pub server_enabled: bool,
    pub server_auto_start: bool,
    pub server_port: u16,
    pub server_bind_lan: bool,
    pub max_concurrent_transfers: i64,
    pub transfer_retry_limit: i64,
    pub scheduled_scan_minutes: i64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            storage_root: None,
            setup_completed: false,
            theme: "dark".to_string(),
            language: "en".to_string(),
            start_with_windows: false,
            minimize_to_tray: true,
            close_to_tray: true,
            warning_threshold_pct: 85,
            server_enabled: false,
            server_auto_start: false,
            server_port: 48720,
            server_bind_lan: true,
            max_concurrent_transfers: 3,
            transfer_retry_limit: 3,
            scheduled_scan_minutes: 60,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRecord {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub modified_at: String,
    pub is_favorite: bool,
    pub device_origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRecord {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub folder_id: Option<String>,
    pub size: i64,
    pub mime_type: String,
    pub category: String,
    pub extension: String,
    pub created_at: String,
    pub modified_at: String,
    pub imported_at: String,
    pub sha256: Option<String>,
    pub thumbnail_path: Option<String>,
    pub is_favorite: bool,
    pub tags: Vec<String>,
    pub backup_status: String,
    pub device_origin: String,
    pub transfer_status: String,
    pub is_deleted: bool,
    pub deleted_at: Option<String>,
    pub original_relative_path: Option<String>,
    pub original_folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRecord {
    pub id: String,
    pub direction: String,
    pub file_id: Option<String>,
    pub file_name: String,
    pub target_relative_path: String,
    pub folder_id: Option<String>,
    pub total_bytes: i64,
    pub transferred_bytes: i64,
    pub chunk_size: i64,
    pub total_chunks: i64,
    pub verified_chunks: Vec<i64>,
    pub status: String,
    pub speed_bps: i64,
    pub eta_seconds: Option<i64>,
    pub sha256_expected: Option<String>,
    pub sha256_actual: Option<String>,
    pub retry_count: i64,
    pub max_retries: i64,
    pub error_message: Option<String>,
    pub device_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePermissions {
    pub read_files: bool,
    pub upload_files: bool,
    pub delete_files: bool,
    pub stream_media: bool,
    pub sync_folders: bool,
}

impl Default for DevicePermissions {
    fn default() -> Self {
        Self {
            read_files: true,
            upload_files: true,
            delete_files: false,
            stream_media: true,
            sync_folders: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    pub device_type: String,
    pub os_version: String,
    pub permissions: DevicePermissions,
    pub status: String,
    pub is_revoked: bool,
    pub paired_at: String,
    pub last_connected_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub ip_address: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRuleRecord {
    pub id: String,
    pub device_id: Option<String>,
    pub name: String,
    pub direction: String,
    pub local_folder_id: Option<String>,
    pub local_folder_path: String,
    pub remote_path: String,
    pub exclusions: Vec<String>,
    pub conflict_policy: String,
    pub enabled: bool,
    pub status: String,
    pub last_sync_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistoryRecord {
    pub id: String,
    pub rule_id: String,
    pub status: String,
    pub files_synced: i64,
    pub conflicts_detected: i64,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLogRecord {
    pub id: i64,
    pub level: String,
    pub category: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
    pub created_at: String,
}

pub struct DbManager {
    pub config_dir: PathBuf,
    pub bootstrap_path: PathBuf,
    pub conn: Arc<Mutex<Option<Connection>>>,
    pub db_path: Arc<Mutex<Option<PathBuf>>>,
}

impl DbManager {
    pub fn new(config_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&config_dir);
        let bootstrap_path = config_dir.join("bootstrap.json");
        let mgr = Self {
            config_dir,
            bootstrap_path,
            conn: Arc::new(Mutex::new(None)),
            db_path: Arc::new(Mutex::new(None)),
        };

        let boot = mgr.load_bootstrap();
        if let Some(root) = boot.storage_root {
            let db_file = PathBuf::from(root).join("Database").join("haven.db");
            if db_file.exists() {
                let _ = mgr.open(&db_file);
            }
        }
        mgr
    }

    pub fn load_bootstrap(&self) -> BootstrapConfig {
        if let Ok(raw) = fs::read_to_string(&self.bootstrap_path) {
            if let Ok(parsed) = serde_json::from_str::<BootstrapConfig>(&raw) {
                return parsed;
            }
        }
        let fresh = BootstrapConfig {
            storage_root: None,
            admin_passcode_hash: None,
            admin_passcode_salt: None,
        };
        let _ = self.save_bootstrap(&fresh);
        fresh
    }

    pub fn save_bootstrap(&self, cfg: &BootstrapConfig) -> Result<(), String> {
        let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
        let tmp = self.bootstrap_path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.bootstrap_path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn open(&self, db_file: &Path) -> Result<(), String> {
        if let Some(parent) = db_file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(db_file).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                relative_path TEXT NOT NULL UNIQUE,
                parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                modified_at TEXT NOT NULL,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                device_origin TEXT NOT NULL DEFAULT 'windows-pc'
            );

            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                relative_path TEXT NOT NULL UNIQUE,
                folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
                size INTEGER NOT NULL DEFAULT 0,
                mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
                category TEXT NOT NULL DEFAULT 'other',
                extension TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                modified_at TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                sha256 TEXT,
                thumbnail_path TEXT,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                tags_json TEXT NOT NULL DEFAULT '[]',
                backup_status TEXT NOT NULL DEFAULT 'local_only',
                device_origin TEXT NOT NULL DEFAULT 'windows-pc',
                transfer_status TEXT NOT NULL DEFAULT 'complete',
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT,
                original_relative_path TEXT,
                original_folder_id TEXT
            );

            CREATE TABLE IF NOT EXISTS transfers (
                id TEXT PRIMARY KEY,
                direction TEXT NOT NULL,
                file_id TEXT,
                file_name TEXT NOT NULL,
                target_relative_path TEXT NOT NULL,
                folder_id TEXT,
                total_bytes INTEGER NOT NULL,
                transferred_bytes INTEGER NOT NULL DEFAULT 0,
                chunk_size INTEGER NOT NULL,
                total_chunks INTEGER NOT NULL,
                verified_chunks_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL,
                speed_bps INTEGER NOT NULL DEFAULT 0,
                eta_seconds INTEGER,
                sha256_expected TEXT,
                sha256_actual TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                max_retries INTEGER NOT NULL DEFAULT 3,
                error_message TEXT,
                device_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                device_type TEXT NOT NULL DEFAULT 'android',
                os_version TEXT NOT NULL DEFAULT '',
                token_hash TEXT NOT NULL,
                permissions_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'offline',
                is_revoked INTEGER NOT NULL DEFAULT 0,
                paired_at TEXT NOT NULL,
                last_connected_at TEXT,
                last_seen_at TEXT,
                ip_address TEXT
            );

            CREATE TABLE IF NOT EXISTS pairing_sessions (
                id TEXT PRIMARY KEY,
                code TEXT NOT NULL UNIQUE,
                secret TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_rules (
                id TEXT PRIMARY KEY,
                device_id TEXT,
                name TEXT NOT NULL,
                direction TEXT NOT NULL,
                local_folder_id TEXT,
                local_folder_path TEXT NOT NULL,
                remote_path TEXT NOT NULL,
                exclusions_json TEXT NOT NULL DEFAULT '[]',
                conflict_policy TEXT NOT NULL DEFAULT 'keep_both',
                enabled INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'awaiting_device',
                last_sync_at TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_history (
                id TEXT PRIMARY KEY,
                rule_id TEXT NOT NULL REFERENCES sync_rules(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                files_synced INTEGER NOT NULL DEFAULT 0,
                conflicts_detected INTEGER NOT NULL DEFAULT 0,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level TEXT NOT NULL,
                category TEXT NOT NULL,
                message TEXT NOT NULL,
                details_json TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS storage_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                used_bytes INTEGER NOT NULL,
                total_bytes INTEGER NOT NULL,
                file_count INTEGER NOT NULL,
                recorded_at TEXT NOT NULL
            );
            ",
        )
        .map_err(|e| e.to_string())?;

        *self.conn.lock().unwrap() = Some(conn);
        *self.db_path.lock().unwrap() = Some(db_file.to_path_buf());
        Ok(())
    }

    pub fn close(&self) {
        *self.conn.lock().unwrap() = None;
    }

    pub fn is_open(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }

    pub fn get_db_path(&self) -> Option<PathBuf> {
        self.db_path.lock().unwrap().clone()
    }

    pub fn get_settings(&self) -> AppSettings {
        let mut settings = AppSettings::default();
        let boot = self.load_bootstrap();
        settings.storage_root = boot.storage_root;
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else {
            return settings;
        };
        if let Ok(mut stmt) = conn.prepare("SELECT key, value FROM config") {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }) {
                for row in rows.flatten() {
                    match row.0.as_str() {
                        "storageRoot" if !row.1.is_empty() => settings.storage_root = Some(row.1),
                        "setupCompleted" => settings.setup_completed = row.1 == "true",
                        "theme" => {
                            settings.theme = if row.1 == "light" {
                                "light".into()
                            } else {
                                "dark".into()
                            }
                        }
                        "language" => settings.language = row.1,
                        "startWithWindows" => settings.start_with_windows = row.1 == "true",
                        "minimizeToTray" => settings.minimize_to_tray = row.1 == "true",
                        "closeToTray" => settings.close_to_tray = row.1 == "true",
                        "warningThresholdPct" => {
                            if let Ok(v) = row.1.parse() {
                                settings.warning_threshold_pct = v;
                            }
                        }
                        "serverEnabled" => settings.server_enabled = row.1 == "true",
                        "serverAutoStart" => settings.server_auto_start = row.1 == "true",
                        "serverPort" => {
                            if let Ok(v) = row.1.parse() {
                                settings.server_port = v;
                            }
                        }
                        "serverBindLan" => settings.server_bind_lan = row.1 == "true",
                        "maxConcurrentTransfers" => {
                            if let Ok(v) = row.1.parse() {
                                settings.max_concurrent_transfers = v;
                            }
                        }
                        "transferRetryLimit" => {
                            if let Ok(v) = row.1.parse() {
                                settings.transfer_retry_limit = v;
                            }
                        }
                        "scheduledScanMinutes" => {
                            if let Ok(v) = row.1.parse() {
                                settings.scheduled_scan_minutes = v;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        settings
    }

    pub fn set_config_kv(&self, key: &str, value: &str) -> Result<(), String> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or("Database not initialized")?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO config (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_config_kv(&self, key: &str) -> Option<String> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref()?;
        conn.query_row("SELECT value FROM config WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn log_event(&self, level: &str, category: &str, message: &str) {
        self.log_event_details(level, category, message, None);
    }

    pub fn log_event_details(
        &self,
        level: &str,
        category: &str,
        message: &str,
        details: Option<serde_json::Value>,
    ) {
        let guard = self.conn.lock().unwrap();
        if let Some(conn) = guard.as_ref() {
            let det = details.map(|d| d.to_string());
            let _ = conn.execute(
                "INSERT INTO activity_logs (level, category, message, details_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![level, category, message, det, Utc::now().to_rfc3339()],
            );
        }
    }

    pub fn hash_passcode(passcode: &str, salt: &str) -> String {
        let mut digest = Sha256::new();
        digest.update(salt.as_bytes());
        digest.update(b":");
        digest.update(passcode.as_bytes());
        let mut cur = digest.finalize();
        for _ in 0..10_000 {
            let mut next = Sha256::new();
            next.update(&cur);
            next.update(salt.as_bytes());
            cur = next.finalize();
        }
        hex::encode(cur)
    }

    pub fn new_id() -> String {
        Uuid::new_v4().to_string()
    }

    pub fn row_to_folder(row: &rusqlite::Row) -> rusqlite::Result<FolderRecord> {
        Ok(FolderRecord {
            id: row.get("id")?,
            name: row.get("name")?,
            relative_path: row.get("relative_path")?,
            parent_id: row.get("parent_id")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
            is_favorite: row.get::<_, i64>("is_favorite")? == 1,
            device_origin: row.get("device_origin")?,
        })
    }

    pub fn row_to_file(row: &rusqlite::Row) -> rusqlite::Result<FileRecord> {
        let tags_raw: String = row.get("tags_json")?;
        let tags: Vec<String> = serde_json::from_str(&tags_raw).unwrap_or_default();
        Ok(FileRecord {
            id: row.get("id")?,
            name: row.get("name")?,
            relative_path: row.get("relative_path")?,
            folder_id: row.get("folder_id")?,
            size: row.get("size")?,
            mime_type: row.get("mime_type")?,
            category: row.get("category")?,
            extension: row.get("extension")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
            imported_at: row.get("imported_at")?,
            sha256: row.get("sha256")?,
            thumbnail_path: row.get("thumbnail_path")?,
            is_favorite: row.get::<_, i64>("is_favorite")? == 1,
            tags,
            backup_status: row.get("backup_status")?,
            device_origin: row.get("device_origin")?,
            transfer_status: row.get("transfer_status")?,
            is_deleted: row.get::<_, i64>("is_deleted")? == 1,
            deleted_at: row.get("deleted_at")?,
            original_relative_path: row.get("original_relative_path")?,
            original_folder_id: row.get("original_folder_id")?,
        })
    }

    pub fn row_to_transfer(row: &rusqlite::Row) -> rusqlite::Result<TransferRecord> {
        let verified_raw: String = row.get("verified_chunks_json")?;
        let verified_chunks: Vec<i64> = serde_json::from_str(&verified_raw).unwrap_or_default();
        Ok(TransferRecord {
            id: row.get("id")?,
            direction: row.get("direction")?,
            file_id: row.get("file_id")?,
            file_name: row.get("file_name")?,
            target_relative_path: row.get("target_relative_path")?,
            folder_id: row.get("folder_id")?,
            total_bytes: row.get("total_bytes")?,
            transferred_bytes: row.get("transferred_bytes")?,
            chunk_size: row.get("chunk_size")?,
            total_chunks: row.get("total_chunks")?,
            verified_chunks,
            status: row.get("status")?,
            speed_bps: row.get("speed_bps")?,
            eta_seconds: row.get("eta_seconds")?,
            sha256_expected: row.get("sha256_expected")?,
            sha256_actual: row.get("sha256_actual")?,
            retry_count: row.get("retry_count")?,
            max_retries: row.get("max_retries")?,
            error_message: row.get("error_message")?,
            device_id: row.get("device_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            completed_at: row.get("completed_at")?,
        })
    }

    pub fn get_folder_by_id(&self, id: &str) -> Option<FolderRecord> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref()?;
        conn.query_row(
            "SELECT * FROM folders WHERE id = ?1",
            params![id],
            Self::row_to_folder,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_folder_by_rel(&self, rel: &str) -> Option<FolderRecord> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref()?;
        conn.query_row(
            "SELECT * FROM folders WHERE relative_path = ?1",
            params![rel],
            Self::row_to_folder,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn list_folders(&self, parent_id: Option<&str>, include_all: bool) -> Vec<FolderRecord> {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else {
            return vec![];
        };
        if include_all {
            let Ok(mut stmt) = conn.prepare("SELECT * FROM folders ORDER BY name COLLATE NOCASE ASC") else {
                return vec![];
            };
            return stmt
                .query_map([], Self::row_to_folder)
                .ok()
                .map(|r| r.flatten().collect())
                .unwrap_or_default();
        }
        match parent_id {
            Some(pid) => {
                let Ok(mut stmt) = conn.prepare(
                    "SELECT * FROM folders WHERE parent_id = ?1 ORDER BY name COLLATE NOCASE ASC",
                ) else {
                    return vec![];
                };
                stmt.query_map(params![pid], Self::row_to_folder)
                    .ok()
                    .map(|r| r.flatten().collect())
                    .unwrap_or_default()
            }
            None => {
                let Ok(mut stmt) = conn.prepare(
                    "SELECT * FROM folders WHERE parent_id IS NULL ORDER BY name COLLATE NOCASE ASC",
                ) else {
                    return vec![];
                };
                stmt.query_map([], Self::row_to_folder)
                    .ok()
                    .map(|r| r.flatten().collect())
                    .unwrap_or_default()
            }
        }
    }

    pub fn get_file_by_id(&self, id: &str) -> Option<FileRecord> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref()?;
        conn.query_row(
            "SELECT * FROM files WHERE id = ?1",
            params![id],
            Self::row_to_file,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_file_by_rel(&self, rel: &str) -> Option<FileRecord> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref()?;
        conn.query_row(
            "SELECT * FROM files WHERE relative_path = ?1",
            params![rel],
            Self::row_to_file,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn list_files(
        &self,
        folder_id: Option<&str>,
        filter_folder: bool,
        only_deleted: bool,
        category: Option<&str>,
        search: Option<&str>,
        favorite_only: bool,
        sort_by: &str,
        sort_dir: &str,
        limit: Option<usize>,
    ) -> Vec<FileRecord> {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else {
            return vec![];
        };
        let mut clauses = Vec::new();
        let mut binds: Vec<rusqlite::types::Value> = Vec::new();

        if only_deleted {
            clauses.push("is_deleted = 1".to_string());
        } else {
            clauses.push("is_deleted = 0".to_string());
        }

        if filter_folder {
            match folder_id {
                Some(fid) => {
                    binds.push(fid.to_string().into());
                    clauses.push(format!("folder_id = ?{}", binds.len()));
                }
                None => clauses.push("folder_id IS NULL".to_string()),
            }
        }

        if let Some(cat) = category {
            binds.push(cat.to_string().into());
            clauses.push(format!("category = ?{}", binds.len()));
        }
        if favorite_only {
            clauses.push("is_favorite = 1".to_string());
        }
        if let Some(q) = search {
            let trimmed = q.trim();
            if !trimmed.is_empty() {
                binds.push(format!("%{}%", trimmed).into());
                clauses.push(format!("name LIKE ?{} COLLATE NOCASE", binds.len()));
            }
        }

        let order_col = match sort_by {
            "size" => "size",
            "modifiedAt" => "modified_at",
            "importedAt" => "imported_at",
            _ => "name COLLATE NOCASE",
        };
        let dir = if sort_dir.eq_ignore_ascii_case("desc") {
            "DESC"
        } else {
            "ASC"
        };
        let lim = limit.map(|l| format!(" LIMIT {}", l)).unwrap_or_default();
        let sql = format!(
            "SELECT * FROM files WHERE {} ORDER BY {} {}{}",
            clauses.join(" AND "),
            order_col,
            dir,
            lim
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return vec![];
        };
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            binds.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        stmt.query_map(params_refs.as_slice(), Self::row_to_file)
            .ok()
            .map(|r| r.flatten().collect())
            .unwrap_or_default()
    }

    pub fn list_transfers(&self) -> Vec<TransferRecord> {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else {
            return vec![];
        };
        let Ok(mut stmt) = conn.prepare("SELECT * FROM transfers ORDER BY created_at DESC LIMIT 200") else {
            return vec![];
        };
        stmt.query_map([], Self::row_to_transfer)
            .ok()
            .map(|r| r.flatten().collect())
            .unwrap_or_default()
    }

    pub fn get_transfer_by_id(&self, id: &str) -> Option<TransferRecord> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref()?;
        conn.query_row(
            "SELECT * FROM transfers WHERE id = ?1",
            params![id],
            Self::row_to_transfer,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn list_devices(&self) -> Vec<DeviceRecord> {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else {
            return vec![];
        };
        let Ok(mut stmt) = conn.prepare("SELECT * FROM devices ORDER BY paired_at DESC") else {
            return vec![];
        };
        stmt.query_map([], |row| {
            let p_raw: String = row.get("permissions_json")?;
            let permissions: DevicePermissions = serde_json::from_str(&p_raw).unwrap_or_default();
            Ok(DeviceRecord {
                id: row.get("id")?,
                name: row.get("name")?,
                device_type: row.get("device_type")?,
                os_version: row.get("os_version")?,
                permissions,
                status: row.get("status")?,
                is_revoked: row.get::<_, i64>("is_revoked")? == 1,
                paired_at: row.get("paired_at")?,
                last_connected_at: row.get("last_connected_at")?,
                last_seen_at: row.get("last_seen_at")?,
                ip_address: row.get("ip_address")?,
            })
        })
        .ok()
        .map(|r| r.flatten().collect())
        .unwrap_or_default()
    }

    pub fn find_device_by_token_hash(&self, token_hash: &str) -> Option<DeviceRecord> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref()?;
        conn.query_row(
            "SELECT * FROM devices WHERE token_hash = ?1 AND is_revoked = 0",
            params![token_hash],
            |row| {
                let p_raw: String = row.get("permissions_json")?;
                let permissions: DevicePermissions = serde_json::from_str(&p_raw).unwrap_or_default();
                Ok(DeviceRecord {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    device_type: row.get("device_type")?,
                    os_version: row.get("os_version")?,
                    permissions,
                    status: row.get("status")?,
                    is_revoked: row.get::<_, i64>("is_revoked")? == 1,
                    paired_at: row.get("paired_at")?,
                    last_connected_at: row.get("last_connected_at")?,
                    last_seen_at: row.get("last_seen_at")?,
                    ip_address: row.get("ip_address")?,
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn check_integrity(&self) -> (bool, Vec<String>) {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else {
            return (false, vec!["Database not open".to_string()]);
        };
        let mut results = Vec::new();
        if let Ok(mut stmt) = conn.prepare("PRAGMA integrity_check") {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                for r in rows.flatten() {
                    results.push(r);
                }
            }
        }
        let ok = !results.is_empty() && results.iter().all(|s| s.eq_ignore_ascii_case("ok"));
        (ok, results)
    }

    pub fn backup_database(&self, storage_root: &Path) -> Result<(String, u64, String), String> {
        let backups_dir = storage_root.join("Backups");
        fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;
        let ts = Utc::now().format("%Y%m%d-%H%M%S-%3f");
        let backup_path = backups_dir.join(format!("haven-backup-{}.sqlite", ts));

        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or("Database not initialized")?;
        let mut dest = Connection::open(&backup_path).map_err(|e| e.to_string())?;
        let backup = rusqlite::backup::Backup::new(conn, &mut dest).map_err(|e| e.to_string())?;
        backup
            .run_to_completion(128, std::time::Duration::from_millis(5), None)
            .map_err(|e| e.to_string())?;
        drop(backup);
        drop(dest);
        drop(guard);

        let now = Utc::now().to_rfc3339();
        let _ = self.set_config_kv("lastBackupAt", &now);
        let size = fs::metadata(&backup_path).map(|m| m.len()).unwrap_or(0);
        self.log_event(
            "info",
            "database",
            &format!("Created database backup {}", backup_path.display()),
        );
        Ok((backup_path.to_string_lossy().to_string(), size, now))
    }

    pub fn restore_database(&self, backup_path: &Path) -> Result<String, String> {
        if !backup_path.exists() {
            return Err("Backup file does not exist".to_string());
        }
        {
            let probe = Connection::open(backup_path).map_err(|e| e.to_string())?;
            let res: String = probe
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if !res.eq_ignore_ascii_case("ok") {
                return Err(format!("Backup integrity check failed: {}", res));
            }
        }
        let db_file = self.get_db_path().ok_or("Database path unknown")?;
        if let Some(root) = db_file.parent().and_then(|p| p.parent()) {
            let _ = self.backup_database(root);
        }
        self.close();
        for ext in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{}", db_file.display(), ext));
            let _ = fs::remove_file(sidecar);
        }
        fs::copy(backup_path, &db_file).map_err(|e| e.to_string())?;
        self.open(&db_file)?;
        self.log_event(
            "warn",
            "database",
            &format!("Restored database from {}", backup_path.display()),
        );
        Ok("Database restored successfully".to_string())
    }

    pub fn list_logs(&self, limit: usize, category: Option<&str>, level: Option<&str>) -> Vec<ActivityLogRecord> {
        let guard = self.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else {
            return vec![];
        };
        let mut clauses = Vec::new();
        let mut binds: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(c) = category {
            if !c.is_empty() {
                binds.push(c.to_string().into());
                clauses.push(format!("category = ?{}", binds.len()));
            }
        }
        if let Some(l) = level {
            if !l.is_empty() {
                binds.push(l.to_string().into());
                clauses.push(format!("level = ?{}", binds.len()));
            }
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let sql = format!(
            "SELECT id, level, category, message, details_json, created_at FROM activity_logs {} ORDER BY id DESC LIMIT {}",
            where_sql, limit
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return vec![];
        };
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            binds.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        stmt.query_map(params_refs.as_slice(), |row| {
            let det: Option<String> = row.get(4)?;
            Ok(ActivityLogRecord {
                id: row.get(0)?,
                level: row.get(1)?,
                category: row.get(2)?,
                message: row.get(3)?,
                details: det.and_then(|s| serde_json::from_str(&s).ok()),
                created_at: row.get(5)?,
            })
        })
        .ok()
        .map(|r| r.flatten().collect())
        .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_db_init_backup_restore_and_integrity() {
        let dir = std::env::temp_dir().join(format!("haven-rust-db-{}", Uuid::new_v4()));
        let cfg = dir.join("config");
        let root = dir.join("HavenStorage");
        fs::create_dir_all(root.join("Database")).unwrap();
        fs::create_dir_all(root.join("Backups")).unwrap();

        let db = DbManager::new(cfg);
        let db_file = root.join("Database").join("haven.db");
        db.open(&db_file).unwrap();
        assert!(db.is_open());

        db.set_config_kv("storageRoot", &root.to_string_lossy()).unwrap();
        db.set_config_kv("setupCompleted", "true").unwrap();
        let (ok, _) = db.check_integrity();
        assert!(ok);

        let (backup_path, size, _) = db.backup_database(&root).unwrap();
        assert!(size > 0);
        assert!(Path::new(&backup_path).exists());

        db.set_config_kv("theme", "light").unwrap();
        assert_eq!(db.get_settings().theme, "light");

        db.restore_database(Path::new(&backup_path)).unwrap();
        assert_eq!(db.get_settings().theme, "dark");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_passcode_hashing_determinism() {
        let h1 = DbManager::hash_passcode("my-vault-99", "salt-abc");
        let h2 = DbManager::hash_passcode("my-vault-99", "salt-abc");
        let h3 = DbManager::hash_passcode("wrong-pass", "salt-abc");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
    }
}
