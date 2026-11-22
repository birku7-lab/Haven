import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  ActivityLogRecord,
  AppSettings,
  DevicePermissions,
  DeviceRecord,
  FileCategory,
  FileRecord,
  FolderRecord,
  SyncRuleRecord,
  TransferRecord,
} from './types.ts';

export const DEFAULT_SETTINGS: AppSettings = {
  storageRoot: null,
  setupCompleted: false,
  theme: 'dark',
  language: 'en',
  startWithWindows: false,
  minimizeToTray: true,
  closeToTray: true,
  warningThresholdPct: 85,
  serverEnabled: false,
  serverAutoStart: false,
  serverPort: 48720,
  serverBindLan: true,
  maxConcurrentTransfers: 3,
  transferRetryLimit: 3,
  scheduledScanMinutes: 60,
};

export interface BootstrapConfig {
  storageRoot: string | null;
  adminPasscodeHash: string | null;
  adminPasscodeSalt: string | null;
  sessionSecret: string;
}

export class HavenDatabase {
  private db: Database.Database | null = null;
  private dbPath: string | null = null;
  private configDir: string;
  private bootstrapPath: string;
  private bootstrap: BootstrapConfig;

  constructor(configDir?: string) {
    this.configDir =
      configDir ||
      process.env.HAVEN_CONFIG_DIR ||
      path.join(os.homedir(), '.haven-storage');
    fs.mkdirSync(this.configDir, { recursive: true });
    this.bootstrapPath = path.join(this.configDir, 'bootstrap.json');
    this.bootstrap = this.loadBootstrap();

    if (this.bootstrap.storageRoot) {
      const candidateDb = path.join(this.bootstrap.storageRoot, 'Database', 'haven.db');
      if (fs.existsSync(candidateDb)) {
        this.open(candidateDb);
      }
    }
  }

  private loadBootstrap(): BootstrapConfig {
    if (fs.existsSync(this.bootstrapPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.bootstrapPath, 'utf8'));
        return {
          storageRoot: typeof raw.storageRoot === 'string' ? raw.storageRoot : null,
          adminPasscodeHash:
            typeof raw.adminPasscodeHash === 'string' ? raw.adminPasscodeHash : null,
          adminPasscodeSalt:
            typeof raw.adminPasscodeSalt === 'string' ? raw.adminPasscodeSalt : null,
          sessionSecret:
            typeof raw.sessionSecret === 'string' && raw.sessionSecret.length >= 32
              ? raw.sessionSecret
              : crypto.randomBytes(32).toString('hex'),
        };
      } catch {
        // Fallback below
      }
    }
    const fresh: BootstrapConfig = {
      storageRoot: null,
      adminPasscodeHash: null,
      adminPasscodeSalt: null,
      sessionSecret: crypto.randomBytes(32).toString('hex'),
    };
    this.saveBootstrap(fresh);
    return fresh;
  }

  private saveBootstrap(next: BootstrapConfig): void {
    this.bootstrap = next;
    const tmp = `${this.bootstrapPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, this.bootstrapPath);
  }

  getBootstrap(): BootstrapConfig {
    return this.bootstrap;
  }

  setAdminPasscode(hash: string, salt: string): void {
    this.saveBootstrap({
      ...this.bootstrap,
      adminPasscodeHash: hash,
      adminPasscodeSalt: salt,
    });
  }

  setStorageRootPointer(storageRoot: string | null): void {
    this.saveBootstrap({
      ...this.bootstrap,
      storageRoot,
    });
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  getDbPath(): string | null {
    return this.dbPath;
  }

  getConfigDir(): string {
    return this.configDir;
  }

  open(dbFilePath: string): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
    const db = new Database(dbFilePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    this.db = db;
    this.dbPath = dbFilePath;
    this.initSchema();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error('Storage database is not initialized. Complete storage setup first.');
    }
    return this.db;
  }

  private initSchema(): void {
    const db = this.requireDb();
    db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
      CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(relative_path);

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

      CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
      CREATE INDEX IF NOT EXISTS idx_files_category ON files(category);
      CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(is_deleted);
      CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);
      CREATE INDEX IF NOT EXISTS idx_files_imported ON files(imported_at);

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

      CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);

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
    `);

    db.prepare(
      `UPDATE transfers SET status = 'paused', updated_at = ? WHERE status IN ('active', 'verifying')`
    ).run(new Date().toISOString());
  }

  getSettings(): AppSettings {
    if (!this.db) {
      return {
        ...DEFAULT_SETTINGS,
        storageRoot: this.bootstrap.storageRoot,
        setupCompleted: false,
      };
    }
    const rows = this.db.prepare('SELECT key, value FROM config').all() as Array<{
      key: string;
      value: string;
    }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const parseBool = (k: string, fallback: boolean) =>
      map.has(k) ? map.get(k) === 'true' : fallback;
    const parseNum = (k: string, fallback: number) => {
      if (!map.has(k)) return fallback;
      const n = Number(map.get(k));
      return Number.isFinite(n) ? n : fallback;
    };

    return {
      storageRoot: map.get('storageRoot') ?? this.bootstrap.storageRoot,
      setupCompleted: parseBool('setupCompleted', false),
      theme: map.get('theme') === 'light' ? 'light' : 'dark',
      language: map.get('language') || 'en',
      startWithWindows: parseBool('startWithWindows', DEFAULT_SETTINGS.startWithWindows),
      minimizeToTray: parseBool('minimizeToTray', DEFAULT_SETTINGS.minimizeToTray),
      closeToTray: parseBool('closeToTray', DEFAULT_SETTINGS.closeToTray),
      warningThresholdPct: parseNum('warningThresholdPct', DEFAULT_SETTINGS.warningThresholdPct),
      serverEnabled: parseBool('serverEnabled', DEFAULT_SETTINGS.serverEnabled),
      serverAutoStart: parseBool('serverAutoStart', DEFAULT_SETTINGS.serverAutoStart),
      serverPort: parseNum('serverPort', DEFAULT_SETTINGS.serverPort),
      serverBindLan: parseBool('serverBindLan', DEFAULT_SETTINGS.serverBindLan),
      maxConcurrentTransfers: parseNum(
        'maxConcurrentTransfers',
        DEFAULT_SETTINGS.maxConcurrentTransfers
      ),
      transferRetryLimit: parseNum('transferRetryLimit', DEFAULT_SETTINGS.transferRetryLimit),
      scheduledScanMinutes: parseNum(
        'scheduledScanMinutes',
        DEFAULT_SETTINGS.scheduledScanMinutes
      ),
    };
  }

  updateSettings(partial: Partial<AppSettings>): AppSettings {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    const tx = db.transaction((entries: Array<[string, unknown]>) => {
      for (const [k, v] of entries) {
        if (v !== undefined) {
          stmt.run(k, v === null ? '' : String(v), now);
        }
      }
    });
    tx(Object.entries(partial));
    if (partial.storageRoot !== undefined) {
      this.setStorageRootPointer(partial.storageRoot);
    }
    return this.getSettings();
  }

  log(
    level: ActivityLogRecord['level'],
    category: ActivityLogRecord['category'],
    message: string,
    details: Record<string, unknown> | null = null
  ): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO activity_logs (level, category, message, details_json, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(level, category, message, details ? JSON.stringify(details) : null, new Date().toISOString());
  }

  getLogs(limit = 200, category?: string, level?: string): ActivityLogRecord[] {
    if (!this.db) return [];
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (category && category !== 'all') {
      clauses.push('category = ?');
      params.push(category);
    }
    if (level && level !== 'all') {
      clauses.push('level = ?');
      params.push(level);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM activity_logs ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as Array<{
      id: number;
      level: ActivityLogRecord['level'];
      category: ActivityLogRecord['category'];
      message: string;
      details_json: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      level: r.level,
      category: r.category,
      message: r.message,
      details: r.details_json ? JSON.parse(r.details_json) : null,
      createdAt: r.created_at,
    }));
  }

  upsertFolder(folder: Omit<FolderRecord, 'itemCount' | 'totalSize'>): void {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO folders (id, name, relative_path, parent_id, created_at, modified_at, is_favorite, device_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(relative_path) DO UPDATE SET
         name = excluded.name,
         parent_id = excluded.parent_id,
         modified_at = excluded.modified_at`
    ).run(
      folder.id,
      folder.name,
      folder.relativePath,
      folder.parentId,
      folder.createdAt,
      folder.modifiedAt,
      folder.isFavorite ? 1 : 0,
      folder.deviceOrigin
    );
  }

  getFolderById(id: string): FolderRecord | null {
    const db = this.requireDb();
    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapFolderRow(row) : null;
  }

  getFolderByPath(relativePath: string): FolderRecord | null {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM folders WHERE relative_path = ?')
      .get(relativePath) as Record<string, unknown> | undefined;
    return row ? this.mapFolderRow(row) : null;
  }

  listFolders(parentId: string | null = null, includeAll = false): FolderRecord[] {
    const db = this.requireDb();
    const rows = includeAll
      ? (db
          .prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE ASC')
          .all() as Array<Record<string, unknown>>)
      : parentId === null
        ? (db
            .prepare('SELECT * FROM folders WHERE parent_id IS NULL ORDER BY name COLLATE NOCASE ASC')
            .all() as Array<Record<string, unknown>>)
        : (db
            .prepare('SELECT * FROM folders WHERE parent_id = ? ORDER BY name COLLATE NOCASE ASC')
            .all(parentId) as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapFolderRow(r));
  }

  renameFolder(id: string, newName: string, newRelPath: string): void {
    const db = this.requireDb();
    const existing = this.getFolderById(id);
    if (!existing) return;
    const oldPrefix = existing.relativePath;
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      db.prepare('UPDATE folders SET name = ?, relative_path = ?, modified_at = ? WHERE id = ?').run(
        newName,
        newRelPath,
        now,
        id
      );

      const childFolders = db
        .prepare('SELECT id, relative_path FROM folders WHERE relative_path LIKE ?')
        .all(`${oldPrefix}/%`) as Array<{ id: string; relative_path: string }>;
      for (const cf of childFolders) {
        const updated = `${newRelPath}${cf.relative_path.slice(oldPrefix.length)}`;
        db.prepare('UPDATE folders SET relative_path = ?, modified_at = ? WHERE id = ?').run(
          updated,
          now,
          cf.id
        );
      }

      const childFiles = db
        .prepare('SELECT id, relative_path FROM files WHERE relative_path LIKE ?')
        .all(`${oldPrefix}/%`) as Array<{ id: string; relative_path: string }>;
      for (const fl of childFiles) {
        const updated = `${newRelPath}${fl.relative_path.slice(oldPrefix.length)}`;
        db.prepare('UPDATE files SET relative_path = ?, modified_at = ? WHERE id = ?').run(
          updated,
          now,
          fl.id
        );
      }
    });
    tx();
  }

  deleteFolderRecord(id: string): void {
    const db = this.requireDb();
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  }

  upsertFile(file: FileRecord): void {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO files (
        id, name, relative_path, folder_id, size, mime_type, category, extension,
        created_at, modified_at, imported_at, sha256, thumbnail_path, is_favorite,
        tags_json, backup_status, device_origin, transfer_status, is_deleted,
        deleted_at, original_relative_path, original_folder_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(relative_path) DO UPDATE SET
        name = excluded.name,
        folder_id = excluded.folder_id,
        size = excluded.size,
        mime_type = excluded.mime_type,
        category = excluded.category,
        modified_at = excluded.modified_at,
        sha256 = COALESCE(excluded.sha256, files.sha256),
        thumbnail_path = COALESCE(excluded.thumbnail_path, files.thumbnail_path),
        transfer_status = excluded.transfer_status`
    ).run(
      file.id,
      file.name,
      file.relativePath,
      file.folderId,
      file.size,
      file.mimeType,
      file.category,
      file.extension,
      file.createdAt,
      file.modifiedAt,
      file.importedAt,
      file.sha256,
      file.thumbnailPath,
      file.isFavorite ? 1 : 0,
      JSON.stringify(file.tags || []),
      file.backupStatus,
      file.deviceOrigin,
      file.transferStatus,
      file.isDeleted ? 1 : 0,
      file.deletedAt,
      file.originalRelativePath,
      file.originalFolderId
    );
  }

  getFileById(id: string): FileRecord | null {
    const db = this.requireDb();
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapFileRow(row) : null;
  }

  getFileByPath(relativePath: string): FileRecord | null {
    const db = this.requireDb();
    const row = db.prepare('SELECT * FROM files WHERE relative_path = ?').get(relativePath) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapFileRow(row) : null;
  }

  listFiles(options: {
    folderId?: string | null;
    includeDeleted?: boolean;
    onlyDeleted?: boolean;
    category?: FileCategory | 'all';
    search?: string;
    favoriteOnly?: boolean;
    sortBy?: 'name' | 'size' | 'modifiedAt' | 'importedAt';
    sortDir?: 'asc' | 'desc';
    limit?: number;
  }): FileRecord[] {
    const db = this.requireDb();
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.onlyDeleted) {
      clauses.push('is_deleted = 1');
    } else if (!options.includeDeleted) {
      clauses.push('is_deleted = 0');
    }

    if (options.folderId !== undefined) {
      if (options.folderId === null) {
        clauses.push('folder_id IS NULL');
      } else {
        clauses.push('folder_id = ?');
        params.push(options.folderId);
      }
    }

    if (options.category && options.category !== 'all') {
      clauses.push('category = ?');
      params.push(options.category);
    }

    if (options.favoriteOnly) {
      clauses.push('is_favorite = 1');
    }

    if (options.search && options.search.trim().length > 0) {
      clauses.push('(name LIKE ? OR relative_path LIKE ?)');
      const term = `%${options.search.trim()}%`;
      params.push(term, term);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sortColMap: Record<string, string> = {
      name: 'name COLLATE NOCASE',
      size: 'size',
      modifiedAt: 'modified_at',
      importedAt: 'imported_at',
    };
    const sortCol = sortColMap[options.sortBy || 'modifiedAt'] || 'modified_at';
    const sortDir = options.sortDir === 'asc' ? 'ASC' : 'DESC';
    const limitClause = options.limit ? `LIMIT ${Number(options.limit)}` : '';

    const rows = db
      .prepare(`SELECT * FROM files ${where} ORDER BY ${sortCol} ${sortDir} ${limitClause}`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapFileRow(r));
  }

  updateFileFields(
    id: string,
    fields: Partial<{
      name: string;
      relativePath: string;
      folderId: string | null;
      size: number;
      modifiedAt: string;
      sha256: string | null;
      thumbnailPath: string | null;
      isFavorite: boolean;
      tags: string[];
      backupStatus: FileRecord['backupStatus'];
      transferStatus: FileRecord['transferStatus'];
      isDeleted: boolean;
      deletedAt: string | null;
      originalRelativePath: string | null;
      originalFolderId: string | null;
    }>
  ): void {
    const db = this.requireDb();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (fields.name !== undefined) {
      sets.push('name = ?');
      params.push(fields.name);
    }
    if (fields.relativePath !== undefined) {
      sets.push('relative_path = ?');
      params.push(fields.relativePath);
    }
    if (fields.folderId !== undefined) {
      sets.push('folder_id = ?');
      params.push(fields.folderId);
    }
    if (fields.size !== undefined) {
      sets.push('size = ?');
      params.push(fields.size);
    }
    if (fields.modifiedAt !== undefined) {
      sets.push('modified_at = ?');
      params.push(fields.modifiedAt);
    }
    if (fields.sha256 !== undefined) {
      sets.push('sha256 = ?');
      params.push(fields.sha256);
    }
    if (fields.thumbnailPath !== undefined) {
      sets.push('thumbnail_path = ?');
      params.push(fields.thumbnailPath);
    }
    if (fields.isFavorite !== undefined) {
      sets.push('is_favorite = ?');
      params.push(fields.isFavorite ? 1 : 0);
    }
    if (fields.tags !== undefined) {
      sets.push('tags_json = ?');
      params.push(JSON.stringify(fields.tags));
    }
    if (fields.backupStatus !== undefined) {
      sets.push('backup_status = ?');
      params.push(fields.backupStatus);
    }
    if (fields.transferStatus !== undefined) {
      sets.push('transfer_status = ?');
      params.push(fields.transferStatus);
    }
    if (fields.isDeleted !== undefined) {
      sets.push('is_deleted = ?');
      params.push(fields.isDeleted ? 1 : 0);
    }
    if (fields.deletedAt !== undefined) {
      sets.push('deleted_at = ?');
      params.push(fields.deletedAt);
    }
    if (fields.originalRelativePath !== undefined) {
      sets.push('original_relative_path = ?');
      params.push(fields.originalRelativePath);
    }
    if (fields.originalFolderId !== undefined) {
      sets.push('original_folder_id = ?');
      params.push(fields.originalFolderId);
    }

    if (sets.length === 0) return;
    params.push(id);
    db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteFilePermanently(id: string): void {
    const db = this.requireDb();
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
  }

  upsertTransfer(t: TransferRecord): void {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO transfers (
        id, direction, file_id, file_name, target_relative_path, folder_id,
        total_bytes, transferred_bytes, chunk_size, total_chunks, verified_chunks_json,
        status, speed_bps, eta_seconds, sha256_expected, sha256_actual,
        retry_count, max_retries, error_message, device_id, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_id = excluded.file_id,
        transferred_bytes = excluded.transferred_bytes,
        verified_chunks_json = excluded.verified_chunks_json,
        status = excluded.status,
        speed_bps = excluded.speed_bps,
        eta_seconds = excluded.eta_seconds,
        sha256_actual = excluded.sha256_actual,
        retry_count = excluded.retry_count,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at`
    ).run(
      t.id,
      t.direction,
      t.fileId,
      t.fileName,
      t.targetRelativePath,
      t.folderId,
      t.totalBytes,
      t.transferredBytes,
      t.chunkSize,
      t.totalChunks,
      JSON.stringify(t.verifiedChunks),
      t.status,
      t.speedBps,
      t.etaSeconds,
      t.sha256Expected,
      t.sha256Actual,
      t.retryCount,
      t.maxRetries,
      t.errorMessage,
      t.deviceId,
      t.createdAt,
      t.updatedAt,
      t.completedAt
    );
  }

  getTransfer(id: string): TransferRecord | null {
    const db = this.requireDb();
    const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapTransferRow(row) : null;
  }

  listTransfers(): TransferRecord[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare('SELECT * FROM transfers ORDER BY created_at DESC LIMIT 200')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTransferRow(r));
  }

  clearCompletedTransfers(): void {
    const db = this.requireDb();
    db.prepare(`DELETE FROM transfers WHERE status IN ('completed', 'cancelled')`).run();
  }

  listDevices(): DeviceRecord[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare('SELECT * FROM devices ORDER BY paired_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapDeviceRow(r));
  }

  createDevice(device: DeviceRecord & { tokenHash: string }): void {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO devices (
        id, name, device_type, os_version, token_hash, permissions_json,
        status, is_revoked, paired_at, last_connected_at, last_seen_at, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      device.id,
      device.name,
      device.deviceType,
      device.osVersion,
      device.tokenHash,
      JSON.stringify(device.permissions),
      device.status,
      device.isRevoked ? 1 : 0,
      device.pairedAt,
      device.lastConnectedAt,
      device.lastSeenAt,
      device.ipAddress
    );
  }

  findDeviceByTokenHash(tokenHash: string): DeviceRecord | null {
    if (!this.db) return null;
    const row = this.db
      .prepare('SELECT * FROM devices WHERE token_hash = ? AND is_revoked = 0')
      .get(tokenHash) as Record<string, unknown> | undefined;
    return row ? this.mapDeviceRow(row) : null;
  }

  updateDevicePermissions(id: string, permissions: DevicePermissions): void {
    const db = this.requireDb();
    db.prepare('UPDATE devices SET permissions_json = ? WHERE id = ?').run(
      JSON.stringify(permissions),
      id
    );
  }

  touchDevice(id: string, ipAddress: string | null): void {
    if (!this.db) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE devices SET last_seen_at = ?, last_connected_at = COALESCE(last_connected_at, ?), ip_address = COALESCE(?, ip_address) WHERE id = ?`
      )
      .run(now, now, ipAddress, id);
  }

  revokeDevice(id: string): void {
    const db = this.requireDb();
    db.prepare(`UPDATE devices SET is_revoked = 1, status = 'revoked' WHERE id = ?`).run(id);
  }

  deleteDevice(id: string): void {
    const db = this.requireDb();
    db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  createPairingSession(id: string, code: string, secret: string, expiresAt: string): void {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO pairing_sessions (id, code, secret, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)`
    ).run(id, code, secret, expiresAt, new Date().toISOString());
  }

  consumePairingSession(
    code: string,
    secret: string
  ): { valid: boolean; reason?: string } {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM pairing_sessions WHERE code = ?')
      .get(code) as
      | { id: string; secret: string; expires_at: string; used: number }
      | undefined;
    if (!row) return { valid: false, reason: 'Invalid pairing code' };
    if (row.used) return { valid: false, reason: 'Pairing code already used' };
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { valid: false, reason: 'Pairing code expired' };
    }
    const a = Buffer.from(row.secret);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { valid: false, reason: 'Invalid pairing secret' };
    }
    db.prepare('UPDATE pairing_sessions SET used = 1 WHERE id = ?').run(row.id);
    return { valid: true };
  }

  listSyncRules(): SyncRuleRecord[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare('SELECT * FROM sync_rules ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      deviceId: r.device_id ? String(r.device_id) : null,
      name: String(r.name),
      direction: r.direction as SyncRuleRecord['direction'],
      localFolderId: r.local_folder_id ? String(r.local_folder_id) : null,
      localFolderPath: String(r.local_folder_path),
      remotePath: String(r.remote_path),
      exclusions: JSON.parse(String(r.exclusions_json || '[]')),
      conflictPolicy: r.conflict_policy as SyncRuleRecord['conflictPolicy'],
      enabled: Boolean(r.enabled),
      status: r.status as SyncRuleRecord['status'],
      lastSyncAt: r.last_sync_at ? String(r.last_sync_at) : null,
      createdAt: String(r.created_at),
    }));
  }

  createSyncRule(rule: SyncRuleRecord): void {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO sync_rules (
        id, device_id, name, direction, local_folder_id, local_folder_path,
        remote_path, exclusions_json, conflict_policy, enabled, status, last_sync_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rule.id,
      rule.deviceId,
      rule.name,
      rule.direction,
      rule.localFolderId,
      rule.localFolderPath,
      rule.remotePath,
      JSON.stringify(rule.exclusions),
      rule.conflictPolicy,
      rule.enabled ? 1 : 0,
      rule.status,
      rule.lastSyncAt,
      rule.createdAt
    );
  }

  getSyncRuleById(id: string): SyncRuleRecord | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM sync_rules WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      deviceId: row.device_id ? String(row.device_id) : null,
      name: String(row.name),
      direction: row.direction as SyncRuleRecord['direction'],
      localFolderId: row.local_folder_id ? String(row.local_folder_id) : null,
      localFolderPath: String(row.local_folder_path),
      remotePath: String(row.remote_path),
      exclusions: JSON.parse(String(row.exclusions_json || '[]')),
      conflictPolicy: row.conflict_policy as SyncRuleRecord['conflictPolicy'],
      enabled: Boolean(row.enabled),
      status: row.status as SyncRuleRecord['status'],
      lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
      createdAt: String(row.created_at),
    };
  }

  updateSyncRule(
    id: string,
    fields: Partial<{
      deviceId: string | null;
      enabled: boolean;
      status: SyncRuleRecord['status'];
      lastSyncAt: string | null;
    }>
  ): SyncRuleRecord | null {
    const db = this.requireDb();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.deviceId !== undefined) {
      sets.push('device_id = ?');
      params.push(fields.deviceId);
    }
    if (fields.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(fields.enabled ? 1 : 0);
    }
    if (fields.status !== undefined) {
      sets.push('status = ?');
      params.push(fields.status);
    }
    if (fields.lastSyncAt !== undefined) {
      sets.push('last_sync_at = ?');
      params.push(fields.lastSyncAt);
    }
    if (sets.length > 0) {
      params.push(id);
      db.prepare(`UPDATE sync_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    return this.getSyncRuleById(id);
  }

  deleteSyncRule(id: string): void {
    const db = this.requireDb();
    db.prepare('DELETE FROM sync_rules WHERE id = ?').run(id);
  }

  addSyncHistory(entry: {
    id: string;
    ruleId: string;
    status: string;
    filesSynced: number;
    conflictsDetected: number;
    message: string;
    createdAt: string;
  }): void {
    const db = this.requireDb();
    db.prepare(
      `INSERT INTO sync_history (id, rule_id, status, files_synced, conflicts_detected, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.id,
      entry.ruleId,
      entry.status,
      entry.filesSynced,
      entry.conflictsDetected,
      entry.message,
      entry.createdAt
    );
  }

  listSyncHistory(): Array<{
    id: string;
    ruleId: string;
    status: string;
    filesSynced: number;
    conflictsDetected: number;
    message: string;
    createdAt: string;
  }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare('SELECT * FROM sync_history ORDER BY created_at DESC LIMIT 50')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      ruleId: String(r.rule_id),
      status: String(r.status),
      filesSynced: Number(r.files_synced),
      conflictsDetected: Number(r.conflicts_detected),
      message: String(r.message),
      createdAt: String(r.created_at),
    }));
  }

  recordStorageSnapshot(usedBytes: number, totalBytes: number, fileCount: number): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO storage_history (used_bytes, total_bytes, file_count, recorded_at) VALUES (?, ?, ?, ?)`
      )
      .run(usedBytes, totalBytes, fileCount, new Date().toISOString());
  }

  getStorageHistory(limit = 30): Array<{
    usedBytes: number;
    totalBytes: number;
    fileCount: number;
    recordedAt: string;
  }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare('SELECT * FROM storage_history ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{
      used_bytes: number;
      total_bytes: number;
      file_count: number;
      recorded_at: string;
    }>;
    return rows.reverse().map((r) => ({
      usedBytes: r.used_bytes,
      totalBytes: r.total_bytes,
      fileCount: r.file_count,
      recordedAt: r.recorded_at,
    }));
  }

  getAnalyticsSummary(): {
    totalFiles: number;
    totalFolders: number;
    totalManagedBytes: number;
    byCategory: Array<{ category: FileCategory; count: number; bytes: number }>;
    largestFiles: FileRecord[];
    largestFolders: Array<{ id: string; name: string; relativePath: string; bytes: number; fileCount: number }>;
    duplicates: Array<{ sha256: string; size: number; files: FileRecord[] }>;
    emptyFolders: FolderRecord[];
  } {
    const db = this.requireDb();
    const totals = db
      .prepare(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(size), 0) as totalBytes FROM files WHERE is_deleted = 0`
      )
      .get() as { cnt: number; totalBytes: number };
    const folderCount = db.prepare(`SELECT COUNT(*) as cnt FROM folders`).get() as { cnt: number };

    const byCategory = db
      .prepare(
        `SELECT category, COUNT(*) as count, COALESCE(SUM(size), 0) as bytes
         FROM files WHERE is_deleted = 0 GROUP BY category ORDER BY bytes DESC`
      )
      .all() as Array<{ category: FileCategory; count: number; bytes: number }>;

    const largestFiles = (
      db
        .prepare(`SELECT * FROM files WHERE is_deleted = 0 ORDER BY size DESC LIMIT 20`)
        .all() as Array<Record<string, unknown>>
    ).map((r) => this.mapFileRow(r));

    const allFolders = this.listFolders(null, true);
    const allFiles = this.listFiles({ includeDeleted: false });
    const folderSizes = new Map<string, { bytes: number; count: number }>();
    for (const f of allFiles) {
      if (f.folderId) {
        const cur = folderSizes.get(f.folderId) || { bytes: 0, count: 0 };
        cur.bytes += f.size;
        cur.count += 1;
        folderSizes.set(f.folderId, cur);
      }
    }

    const largestFolders = allFolders
      .map((fld) => {
        const stat = folderSizes.get(fld.id) || { bytes: 0, count: 0 };
        return {
          id: fld.id,
          name: fld.name,
          relativePath: fld.relativePath,
          bytes: stat.bytes,
          fileCount: stat.count,
        };
      })
      .filter((x) => x.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 15);

    const dupHashes = db
      .prepare(
        `SELECT sha256, COUNT(*) as cnt FROM files
         WHERE is_deleted = 0 AND sha256 IS NOT NULL AND sha256 != ''
         GROUP BY sha256 HAVING cnt > 1 ORDER BY SUM(size) DESC LIMIT 25`
      )
      .all() as Array<{ sha256: string; cnt: number }>;

    const duplicates = dupHashes.map((d) => {
      const files = (
        db
          .prepare(`SELECT * FROM files WHERE is_deleted = 0 AND sha256 = ?`)
          .all(d.sha256) as Array<Record<string, unknown>>
      ).map((r) => this.mapFileRow(r));
      return {
        sha256: d.sha256,
        size: files[0]?.size || 0,
        files,
      };
    });

    const parentIds = new Set(allFolders.map((f) => f.parentId).filter(Boolean));
    const emptyFolders = allFolders.filter(
      (fld) => !parentIds.has(fld.id) && (folderSizes.get(fld.id)?.count || 0) === 0
    );

    return {
      totalFiles: totals.cnt,
      totalFolders: folderCount.cnt,
      totalManagedBytes: totals.totalBytes,
      byCategory,
      largestFiles,
      largestFolders,
      duplicates,
      emptyFolders,
    };
  }

  checkIntegrity(): { ok: boolean; result: string[] } {
    const db = this.requireDb();
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const results = rows.map((r) => r.integrity_check);
    return {
      ok: results.length === 1 && results[0] === 'ok',
      result: results,
    };
  }

  async backupDatabase(storageRoot: string): Promise<{ backupPath: string; size: number; createdAt: string }> {
    const db = this.requireDb();
    const backupsDir = path.join(storageRoot, 'Backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupsDir, `haven-db-${stamp}.sqlite`);
    await db.backup(backupPath);
    const stat = fs.statSync(backupPath);
    this.log('info', 'database', `Database backup created: ${path.basename(backupPath)}`, {
      backupPath,
      size: stat.size,
    });
    return { backupPath, size: stat.size, createdAt: new Date().toISOString() };
  }

  restoreDatabase(backupFilePath: string): { ok: boolean; message: string } {
    if (!this.dbPath) {
      throw new Error('No active database path configured');
    }
    if (!fs.existsSync(backupFilePath)) {
      throw new Error('Backup file not found');
    }
    const probe = new Database(backupFilePath, { readonly: true });
    const check = probe.pragma('integrity_check') as Array<{ integrity_check: string }>;
    probe.close();
    if (!(check.length === 1 && check[0].integrity_check === 'ok')) {
      throw new Error('Backup database failed integrity verification');
    }

    const activePath = this.dbPath;
    this.close();
    const safetyCopy = `${activePath}.pre-restore-${Date.now()}`;
    if (fs.existsSync(activePath)) {
      fs.copyFileSync(activePath, safetyCopy);
    }
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(activePath + suffix)) {
        fs.unlinkSync(activePath + suffix);
      }
    }
    fs.copyFileSync(backupFilePath, activePath);
    this.open(activePath);
    this.log('info', 'database', `Database restored from ${path.basename(backupFilePath)}`);
    return { ok: true, message: 'Database restored and verified successfully' };
  }

  private mapFolderRow(r: Record<string, unknown>): FolderRecord {
    return {
      id: String(r.id),
      name: String(r.name),
      relativePath: String(r.relative_path),
      parentId: r.parent_id ? String(r.parent_id) : null,
      createdAt: String(r.created_at),
      modifiedAt: String(r.modified_at),
      isFavorite: Boolean(r.is_favorite),
      deviceOrigin: String(r.device_origin || 'windows-pc'),
    };
  }

  private mapFileRow(r: Record<string, unknown>): FileRecord {
    return {
      id: String(r.id),
      name: String(r.name),
      relativePath: String(r.relative_path),
      folderId: r.folder_id ? String(r.folder_id) : null,
      size: Number(r.size || 0),
      mimeType: String(r.mime_type || 'application/octet-stream'),
      category: (r.category as FileCategory) || 'other',
      extension: String(r.extension || ''),
      createdAt: String(r.created_at),
      modifiedAt: String(r.modified_at),
      importedAt: String(r.imported_at),
      sha256: r.sha256 ? String(r.sha256) : null,
      thumbnailPath: r.thumbnail_path ? String(r.thumbnail_path) : null,
      isFavorite: Boolean(r.is_favorite),
      tags: JSON.parse(String(r.tags_json || '[]')),
      backupStatus: (r.backup_status as FileRecord['backupStatus']) || 'local_only',
      deviceOrigin: String(r.device_origin || 'windows-pc'),
      transferStatus: (r.transfer_status as FileRecord['transferStatus']) || 'complete',
      isDeleted: Boolean(r.is_deleted),
      deletedAt: r.deleted_at ? String(r.deleted_at) : null,
      originalRelativePath: r.original_relative_path ? String(r.original_relative_path) : null,
      originalFolderId: r.original_folder_id ? String(r.original_folder_id) : null,
    };
  }

  private mapTransferRow(r: Record<string, unknown>): TransferRecord {
    return {
      id: String(r.id),
      direction: r.direction as TransferRecord['direction'],
      fileId: r.file_id ? String(r.file_id) : null,
      fileName: String(r.file_name),
      targetRelativePath: String(r.target_relative_path),
      folderId: r.folder_id ? String(r.folder_id) : null,
      totalBytes: Number(r.total_bytes || 0),
      transferredBytes: Number(r.transferred_bytes || 0),
      chunkSize: Number(r.chunk_size || 4 * 1024 * 1024),
      totalChunks: Number(r.total_chunks || 1),
      verifiedChunks: JSON.parse(String(r.verified_chunks_json || '[]')),
      status: r.status as TransferRecord['status'],
      speedBps: Number(r.speed_bps || 0),
      etaSeconds: r.eta_seconds !== null && r.eta_seconds !== undefined ? Number(r.eta_seconds) : null,
      sha256Expected: r.sha256_expected ? String(r.sha256_expected) : null,
      sha256Actual: r.sha256_actual ? String(r.sha256_actual) : null,
      retryCount: Number(r.retry_count || 0),
      maxRetries: Number(r.max_retries || 3),
      errorMessage: r.error_message ? String(r.error_message) : null,
      deviceId: r.device_id ? String(r.device_id) : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      completedAt: r.completed_at ? String(r.completed_at) : null,
    };
  }

  private mapDeviceRow(r: Record<string, unknown>): DeviceRecord {
    const perms: DevicePermissions = JSON.parse(
      String(
        r.permissions_json ||
          '{"readFiles":true,"uploadFiles":true,"deleteFiles":false,"streamMedia":true,"syncFolders":true}'
      )
    );
    return {
      id: String(r.id),
      name: String(r.name),
      deviceType: (r.device_type as DeviceRecord['deviceType']) || 'android',
      osVersion: String(r.os_version || ''),
      permissions: perms,
      status: (r.status as DeviceRecord['status']) || 'offline',
      isRevoked: Boolean(r.is_revoked),
      pairedAt: String(r.paired_at),
      lastConnectedAt: r.last_connected_at ? String(r.last_connected_at) : null,
      lastSeenAt: r.last_seen_at ? String(r.last_seen_at) : null,
      ipAddress: r.ip_address ? String(r.ip_address) : null,
    };
  }
}
