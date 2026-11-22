import crypto from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import os from 'os';
import path from 'path';
import QRCode from 'qrcode';
import { HavenDatabase } from './db.ts';
import { getLanIpv4Addresses, LocalStorageServer, streamFileWithRange } from './lan-server.ts';
import { StorageScanner } from './scanner.ts';
import {
  assertInsideRoot,
  checkPathWritable,
  detectAvailableDrives,
  getVolumeStats,
  StorageEngine,
} from './storage.ts';
import { TransferEngine } from './transfers.ts';
import type { DevicePermissions, FileCategory } from './types.ts';

export interface SessionEntry {
  id: string;
  tokenHash: string;
  createdAt: string;
  lastActiveAt: string;
  userAgent: string;
}

export interface HavenContext {
  db: HavenDatabase;
  storage: StorageEngine;
  transfers: TransferEngine;
  scanner: StorageScanner;
  lanServer: LocalStorageServer;
  sessions: Map<string, SessionEntry>;
  close: () => Promise<void>;
}

function hashPasscode(passcode: string, salt: string): string {
  return crypto.scryptSync(passcode, salt, 64).toString('hex');
}

function verifyPasscodeHash(passcode: string, salt: string, expectedHex: string): boolean {
  const actual = crypto.scryptSync(passcode, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createHavenContext(configDir?: string): HavenContext {
  const db = new HavenDatabase(configDir);
  const storage = new StorageEngine(db);
  const transfers = new TransferEngine(db, storage);
  const scanner = new StorageScanner(db, storage);
  const lanServer = new LocalStorageServer(db, storage, transfers);
  const sessions = new Map<string, SessionEntry>();

  if (db.isOpen()) {
    const settings = db.getSettings();
    if (settings.scheduledScanMinutes > 0) {
      scanner.configureSchedule(settings.scheduledScanMinutes);
    }
    if (settings.serverAutoStart && settings.serverEnabled) {
      void lanServer.start().catch(() => {
        // Error recorded in lanServer status & logs
      });
    }
  }

  return {
    db,
    storage,
    transfers,
    scanner,
    lanServer,
    sessions,
    close: async () => {
      scanner.stopSchedule();
      await lanServer.stop();
      db.close();
    },
  };
}

export function createApiRouter(ctx: HavenContext): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '4mb' }));

  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, forwardedHeader: false },
    message: { error: 'Too many authentication attempts. Please wait a moment.' },
  });

  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    const rawToken =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : queryToken;

    if (!rawToken) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const session = ctx.sessions.get(tokenHash);
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session token' });
      return;
    }
    session.lastActiveAt = new Date().toISOString();
    (req as Request & { session: SessionEntry }).session = session;
    next();
  };

  const requireStorageReady = (_req: Request, res: Response, next: NextFunction) => {
    if (!ctx.db.isOpen()) {
      res.status(409).json({
        error: 'Storage is not configured yet. Please complete the storage setup wizard.',
        code: 'STORAGE_NOT_INITIALIZED',
      });
      return;
    }
    next();
  };

  // --- Health & Docs ---
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'haven-desktop-core',
      storageInitialized: ctx.db.isOpen(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/docs', (_req, res) => {
    res.json({
      name: 'Haven Personal Storage Ecosystem API',
      version: '1.0.0',
      authentication: {
        desktop: 'Bearer session token obtained via POST /api/v1/auth/login or /auth/setup',
        mobileClient: 'Bearer device token obtained via QR pairing POST /api/v1/pair on LAN server',
      },
      endpoints: [
        { method: 'GET', path: '/api/v1/health', auth: 'Public', description: 'Service health check' },
        { method: 'POST', path: '/api/v1/pair', auth: 'Pairing Code + Secret', description: 'Pair Android client and issue scoped Bearer token' },
        { method: 'GET', path: '/api/v1/storage/info', auth: 'Device Bearer', description: 'Volume capacity, free space, and file totals' },
        { method: 'GET', path: '/api/v1/files', auth: 'Bearer (readFiles)', description: 'Browse folders and search files' },
        { method: 'GET', path: '/api/v1/files/:id/content', auth: 'Bearer (readFiles/streamMedia)', description: 'Stream or download file with HTTP Range support' },
        { method: 'GET', path: '/api/v1/files/:id/thumbnail', auth: 'Bearer (readFiles)', description: 'Retrieve generated WebP media thumbnail' },
        { method: 'POST', path: '/api/v1/transfers/upload', auth: 'Bearer (uploadFiles)', description: 'Create chunked resumable upload session' },
        { method: 'PUT', path: '/api/v1/transfers/:id/chunks/:index', auth: 'Bearer (uploadFiles)', description: 'Upload binary chunk with optional X-Chunk-Sha256 header' },
        { method: 'POST', path: '/api/v1/transfers/:id/complete', auth: 'Bearer (uploadFiles)', description: 'Verify final SHA-256 and commit file to HavenStorage' },
      ],
    });
  });

  // --- Auth ---
  router.get('/auth/status', (_req, res) => {
    const envPasscode = (process.env.HAVEN_ADMIN_PASSCODE || '').trim();
    const bootstrap = ctx.db.getBootstrap();
    const hasPasscode = Boolean(envPasscode || bootstrap.adminPasscodeHash);
    res.json({
      passcodeConfigured: hasPasscode,
      managedByEnv: Boolean(envPasscode),
      setupCompleted: ctx.db.isOpen(),
    });
  });

  router.post('/auth/setup', authLimiter, (req, res) => {
    const envPasscode = (process.env.HAVEN_ADMIN_PASSCODE || '').trim();
    const bootstrap = ctx.db.getBootstrap();
    if (envPasscode || bootstrap.adminPasscodeHash) {
      res.status(409).json({ error: 'Admin passcode is already configured' });
      return;
    }
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (passcode.length < 4) {
      res.status(400).json({ error: 'Passcode must be at least 4 characters' });
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPasscode(passcode, salt);
    ctx.db.setAdminPasscode(hash, salt);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const session: SessionEntry = {
      id: crypto.randomUUID(),
      tokenHash,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      userAgent: String(req.headers['user-agent'] || 'Haven Desktop'),
    };
    ctx.sessions.set(tokenHash, session);
    ctx.db.log('info', 'auth', 'Initial vault passcode configured and session started');
    res.status(201).json({ token: rawToken, sessionId: session.id });
  });

  router.post('/auth/login', authLimiter, (req, res) => {
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    const envPasscode = (process.env.HAVEN_ADMIN_PASSCODE || '').trim();
    const bootstrap = ctx.db.getBootstrap();

    let valid = false;
    if (envPasscode) {
      const a = Buffer.from(passcode);
      const b = Buffer.from(envPasscode);
      valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } else if (bootstrap.adminPasscodeHash && bootstrap.adminPasscodeSalt) {
      valid = verifyPasscodeHash(passcode, bootstrap.adminPasscodeSalt, bootstrap.adminPasscodeHash);
    } else {
      res.status(400).json({ error: 'Vault passcode not set yet' });
      return;
    }

    if (!valid) {
      ctx.db.log('warn', 'auth', 'Failed unlock attempt on desktop console');
      res.status(401).json({ error: 'Invalid passcode' });
      return;
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const session: SessionEntry = {
      id: crypto.randomUUID(),
      tokenHash,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      userAgent: String(req.headers['user-agent'] || 'Haven Desktop'),
    };
    ctx.sessions.set(tokenHash, session);
    ctx.db.log('info', 'auth', 'Desktop session authenticated');
    res.json({ token: rawToken, sessionId: session.id });
  });

  router.post('/auth/logout', requireSession, (req, res) => {
    const session = (req as Request & { session: SessionEntry }).session;
    ctx.sessions.delete(session.tokenHash);
    res.json({ ok: true });
  });

  router.get('/auth/sessions', requireSession, (_req, res) => {
    res.json({
      sessions: Array.from(ctx.sessions.values()).map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        userAgent: s.userAgent,
      })),
    });
  });

  router.delete('/auth/sessions/:id', requireSession, (req, res) => {
    const targetId = String(req.params.id);
    for (const [k, v] of ctx.sessions.entries()) {
      if (v.id === targetId) {
        ctx.sessions.delete(k);
        res.json({ ok: true });
        return;
      }
    }
    res.status(404).json({ error: 'Session not found' });
  });

  // --- Setup & Storage Location ---
  router.get('/setup/drives', requireSession, async (_req, res) => {
    try {
      const drives = await detectAvailableDrives();
      res.json({
        drives,
        platform: process.platform,
        defaultPath:
          process.platform === 'win32'
            ? 'D:\\HavenStorage'
            : path.join(os.homedir(), 'HavenStorage'),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Drive detection failed' });
    }
  });

  router.post('/setup/validate', requireSession, (req, res) => {
    const targetPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!targetPath) {
      res.status(400).json({ error: 'Storage path is required' });
      return;
    }
    const writeCheck = checkPathWritable(targetPath);
    const stats = getVolumeStats(targetPath);
    res.json({
      path: path.resolve(targetPath),
      writable: writeCheck.writable,
      exists: writeCheck.exists,
      error: writeCheck.error || stats.error || null,
      volume: stats,
    });
  });

  router.post('/setup/initialize', requireSession, (req, res) => {
    try {
      const targetPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!targetPath) {
        res.status(400).json({ error: 'Storage path is required' });
        return;
      }
      const result = ctx.storage.initializeStorage(targetPath);
      const settings = ctx.db.getSettings();
      if (settings.scheduledScanMinutes > 0) {
        ctx.scanner.configureSchedule(settings.scheduledScanMinutes);
      }
      res.status(201).json({ ...result, settings });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Initialization failed' });
    }
  });

  router.post('/storage/relocate', requireSession, requireStorageReady, async (req, res) => {
    try {
      const newPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      const mode = req.body?.mode === 'switch_existing' ? 'switch_existing' : 'copy_and_switch';
      if (!newPath) {
        res.status(400).json({ error: 'Destination path is required' });
        return;
      }
      const result = await ctx.storage.relocateStorage(newPath, mode);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Relocation failed' });
    }
  });

  // --- Dashboard ---
  router.get('/dashboard', requireSession, (_req, res) => {
    if (!ctx.db.isOpen()) {
      res.json({
        setupCompleted: false,
        settings: ctx.db.getSettings(),
        server: ctx.lanServer.getStatus(),
      });
      return;
    }

    const settings = ctx.db.getSettings();
    const root = ctx.storage.getRoot();
    const volume = getVolumeStats(root);
    const analytics = ctx.db.getAnalyticsSummary();
    const recentFiles = ctx.db.listFiles({
      includeDeleted: false,
      sortBy: 'importedAt',
      sortDir: 'desc',
      limit: 8,
    });
    const transfers = ctx.db.listTransfers();
    const activeTransfers = transfers.filter(
      (t) => t.status === 'active' || t.status === 'queued' || t.status === 'verifying'
    );
    const devices = ctx.db.listDevices();
    const connectedDevices = devices.filter((d) => d.status === 'connected' && !d.isRevoked);
    const recentActivity = ctx.db.getLogs(12);
    const missingCount = ctx.db
      .listFiles({ includeDeleted: false })
      .filter((f) => f.transferStatus === 'missing').length;

    const usedPct =
      volume.available && volume.totalBytes > 0
        ? Math.round((volume.usedBytes / volume.totalBytes) * 1000) / 10
        : 0;

    const warnings: Array<{ code: string; level: 'warn' | 'error'; message: string }> = [];
    if (!volume.available) {
      warnings.push({
        code: 'DRIVE_UNAVAILABLE',
        level: 'error',
        message: `Configured storage drive at ${root} is unavailable or disconnected.`,
      });
    } else if (usedPct >= settings.warningThresholdPct) {
      warnings.push({
        code: 'LOW_DISK_SPACE',
        level: 'warn',
        message: `Drive utilization (${usedPct}%) exceeded your ${settings.warningThresholdPct}% threshold.`,
      });
    }
    if (missingCount > 0) {
      warnings.push({
        code: 'MISSING_FILES',
        level: 'warn',
        message: `${missingCount} indexed file(s) are missing from disk. Run a storage scan to reconcile.`,
      });
    }

    const backupsDir = path.join(root, 'Backups');
    let lastBackupAt: string | null = null;
    if (fs.existsSync(backupsDir)) {
      const backups = fs
        .readdirSync(backupsDir)
        .filter((f) => f.endsWith('.sqlite'))
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(backupsDir, f)).mtime.toISOString(),
        }))
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
      if (backups[0]) lastBackupAt = backups[0].mtime;
    }

    res.json({
      setupCompleted: true,
      settings,
      volume: { ...volume, usedPct },
      counts: {
        files: analytics.totalFiles,
        folders: analytics.totalFolders,
        managedBytes: analytics.totalManagedBytes,
        connectedDevices: connectedDevices.length,
        pairedDevices: devices.filter((d) => !d.isRevoked).length,
      },
      server: ctx.lanServer.getStatus(),
      scanner: ctx.scanner.getState(),
      activeTransfers,
      recentFiles,
      recentActivity,
      backupStatus: {
        lastBackupAt,
        integrityOk: ctx.db.checkIntegrity().ok,
      },
      warnings,
    });
  });

  // --- Files & Folders ---
  router.get('/files', requireSession, requireStorageReady, (req, res) => {
    const folderIdParam = req.query.folderId;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const category = typeof req.query.category === 'string' ? (req.query.category as FileCategory | 'all') : 'all';
    const favoriteOnly = req.query.favorites === '1';
    const recentOnly = req.query.recent === '1';
    const sortBy = (req.query.sortBy as 'name' | 'size' | 'modifiedAt' | 'importedAt') || 'modifiedAt';
    const sortDir = req.query.sortDir === 'asc' ? 'asc' : 'desc';

    let folders = [];
    let files = [];
    let breadcrumbs: Array<{ id: string | null; name: string }> = [{ id: null, name: 'HavenStorage' }];

    if (search || favoriteOnly || recentOnly || (category && category !== 'all')) {
      folders = search ? ctx.db.listFolders(null, true).filter((f) => f.name.toLowerCase().includes(search.toLowerCase())) : [];
      files = ctx.db.listFiles({
        includeDeleted: false,
        category,
        search,
        favoriteOnly,
        sortBy: recentOnly ? 'importedAt' : sortBy,
        sortDir: recentOnly ? 'desc' : sortDir,
        limit: recentOnly ? 50 : undefined,
      });
    } else {
      const folderId = typeof folderIdParam === 'string' && folderIdParam.length > 0 ? folderIdParam : null;
      folders = ctx.db.listFolders(folderId, false);
      files = ctx.db.listFiles({
        folderId,
        includeDeleted: false,
        sortBy,
        sortDir,
      });

      if (folderId) {
        const chain: Array<{ id: string | null; name: string }> = [];
        let cursor = ctx.db.getFolderById(folderId);
        while (cursor) {
          chain.unshift({ id: cursor.id, name: cursor.name });
          cursor = cursor.parentId ? ctx.db.getFolderById(cursor.parentId) : null;
        }
        breadcrumbs = [{ id: null, name: 'HavenStorage' }, ...chain];
      }
    }

    const allFolders = ctx.db.listFolders(null, true);
    res.json({ folders, files, breadcrumbs, allFolders });
  });

  router.post('/folders', requireSession, requireStorageReady, (req, res) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      const parentId = typeof req.body?.parentId === 'string' ? req.body.parentId : null;
      const folder = ctx.storage.createFolder(name, parentId);
      res.status(201).json(folder);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create folder' });
    }
  });

  router.patch('/folders/:id', requireSession, requireStorageReady, (req, res) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      const updated = ctx.storage.renameFolder(String(req.params.id), name);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to rename folder' });
    }
  });

  router.delete('/folders/:id', requireSession, requireStorageReady, (req, res) => {
    try {
      const result = ctx.storage.deleteEmptyOrRecursiveFolder(String(req.params.id));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to delete folder' });
    }
  });

  router.get('/files/:id', requireSession, requireStorageReady, (req, res) => {
    const file = ctx.db.getFileById(String(req.params.id));
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const root = ctx.storage.getRoot();
    const absPath = assertInsideRoot(root, file.relativePath);
    res.json({ file, absolutePath: absPath });
  });

  router.patch('/files/:id', requireSession, requireStorageReady, (req, res) => {
    try {
      const id = String(req.params.id);
      let file = ctx.db.getFileById(id);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      if (typeof req.body?.name === 'string' && req.body.name !== file.name) {
        file = ctx.storage.renameFile(id, req.body.name);
      }
      if (typeof req.body?.isFavorite === 'boolean') {
        ctx.db.updateFileFields(id, { isFavorite: req.body.isFavorite });
      }
      if (Array.isArray(req.body?.tags)) {
        ctx.db.updateFileFields(id, { tags: req.body.tags.map(String) });
      }
      res.json(ctx.db.getFileById(id));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  router.post('/files/:id/move', requireSession, requireStorageReady, (req, res) => {
    try {
      const targetFolderId = String(req.body?.targetFolderId || '');
      if (!targetFolderId) {
        res.status(400).json({ error: 'targetFolderId is required' });
        return;
      }
      const moved = ctx.storage.moveFile(String(req.params.id), targetFolderId);
      res.json(moved);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Move failed' });
    }
  });

  router.post('/files/:id/copy', requireSession, requireStorageReady, async (req, res) => {
    try {
      const targetFolderId =
        typeof req.body?.targetFolderId === 'string' ? req.body.targetFolderId : null;
      const copied = await ctx.storage.copyFile(String(req.params.id), targetFolderId);
      res.status(201).json(copied);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Copy failed' });
    }
  });

  router.delete('/files/:id', requireSession, requireStorageReady, (req, res) => {
    try {
      const file = ctx.storage.softDeleteFile(String(req.params.id));
      res.json(file);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  router.post('/files/batch-delete', requireSession, requireStorageReady, (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    let count = 0;
    for (const id of ids) {
      try {
        ctx.storage.softDeleteFile(id);
        count += 1;
      } catch {
        // skip missing
      }
    }
    res.json({ movedToRecycleBin: count });
  });

  router.get('/files/:id/content', requireSession, requireStorageReady, (req, res) => {
    const file = ctx.db.getFileById(String(req.params.id));
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const abs = assertInsideRoot(ctx.storage.getRoot(), file.relativePath);
    const download = req.query.download === '1';
    if (download) {
      ctx.transfers.recordDownloadSession(file.id, null);
    }
    streamFileWithRange(req, res, abs, file.mimeType, file.name, download);
  });

  router.get('/files/:id/thumbnail', requireSession, requireStorageReady, (req, res) => {
    const file = ctx.db.getFileById(String(req.params.id));
    if (!file || !file.thumbnailPath) {
      res.status(404).json({ error: 'Thumbnail not available' });
      return;
    }
    const abs = assertInsideRoot(ctx.storage.getRoot(), file.thumbnailPath);
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: 'Thumbnail missing' });
      return;
    }
    res.setHeader('Content-Type', 'image/webp');
    fs.createReadStream(abs).pipe(res);
  });

  router.post('/files/:id/open', requireSession, requireStorageReady, async (req, res) => {
    try {
      const result = await ctx.storage.openInDefaultApp(String(req.params.id));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to open file' });
    }
  });

  // --- Photos & Videos Media Library ---
  router.get('/media', requireSession, requireStorageReady, (req, res) => {
    const type = req.query.type === 'photo' || req.query.type === 'video' ? req.query.type : 'all';
    const sortBy = req.query.sortBy === 'size' ? 'size' : 'modifiedAt';
    const sortDir = req.query.sortDir === 'asc' ? 'asc' : 'desc';
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const favoriteOnly = req.query.favorites === '1';
    const folderId = typeof req.query.folderId === 'string' && req.query.folderId ? req.query.folderId : undefined;

    const photos =
      type === 'all' || type === 'photo'
        ? ctx.db.listFiles({
            category: 'photo',
            includeDeleted: false,
            search,
            favoriteOnly,
            folderId,
            sortBy,
            sortDir,
          })
        : [];
    const videos =
      type === 'all' || type === 'video'
        ? ctx.db.listFiles({
            category: 'video',
            includeDeleted: false,
            search,
            favoriteOnly,
            folderId,
            sortBy,
            sortDir,
          })
        : [];

    const items = [...photos, ...videos].sort((a, b) => {
      if (sortBy === 'size') {
        return sortDir === 'asc' ? a.size - b.size : b.size - a.size;
      }
      return sortDir === 'asc'
        ? a.modifiedAt.localeCompare(b.modifiedAt)
        : b.modifiedAt.localeCompare(a.modifiedAt);
    });

    const albumsMap = new Map<string, { folderId: string | null; name: string; count: number; coverId: string }>();
    for (const item of items) {
      const key = item.folderId || 'root';
      const fld = item.folderId ? ctx.db.getFolderById(item.folderId) : null;
      const cur = albumsMap.get(key);
      if (cur) {
        cur.count += 1;
      } else {
        albumsMap.set(key, {
          folderId: item.folderId,
          name: fld ? fld.name : 'Library Root',
          count: 1,
          coverId: item.id,
        });
      }
    }

    res.json({
      items,
      albums: Array.from(albumsMap.values()),
      counts: {
        photos: photos.length,
        videos: videos.length,
      },
    });
  });

  // --- Transfers ---
  router.get('/transfers', requireSession, (_req, res) => {
    res.json({ transfers: ctx.db.listTransfers() });
  });

  router.post('/transfers/upload', requireSession, requireStorageReady, (req, res) => {
    try {
      const { fileName, totalBytes, folderId, chunkSize, sha256Expected } = req.body || {};
      if (!fileName || totalBytes === undefined) {
        res.status(400).json({ error: 'fileName and totalBytes are required' });
        return;
      }
      const transfer = ctx.transfers.createUploadSession({
        fileName: String(fileName),
        totalBytes: Number(totalBytes),
        folderId: folderId ? String(folderId) : null,
        chunkSize: chunkSize ? Number(chunkSize) : undefined,
        sha256Expected: sha256Expected ? String(sha256Expected) : null,
      });
      res.status(201).json(transfer);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Upload init failed' });
    }
  });

  router.put(
    '/transfers/:id/chunks/:index',
    requireSession,
    requireStorageReady,
    express.raw({ type: 'application/octet-stream', limit: '36mb' }),
    async (req, res) => {
      try {
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const chunkSha256 =
          typeof req.headers['x-chunk-sha256'] === 'string'
            ? req.headers['x-chunk-sha256']
            : null;
        const transfer = await ctx.transfers.writeChunk({
          transferId: String(req.params.id),
          chunkIndex: Number(req.params.index),
          data,
          chunkSha256,
        });
        res.json(transfer);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Chunk upload failed' });
      }
    }
  );

  router.post('/transfers/:id/complete', requireSession, requireStorageReady, async (req, res) => {
    try {
      const result = await ctx.transfers.finalizeUpload(String(req.params.id));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Finalize failed' });
    }
  });

  router.post('/transfers/:id/pause', requireSession, requireStorageReady, (req, res) => {
    try {
      res.json(ctx.transfers.pauseTransfer(String(req.params.id)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Pause failed' });
    }
  });

  router.post('/transfers/:id/resume', requireSession, requireStorageReady, (req, res) => {
    try {
      res.json(ctx.transfers.resumeTransfer(String(req.params.id)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Resume failed' });
    }
  });

  router.post('/transfers/:id/retry', requireSession, requireStorageReady, (req, res) => {
    try {
      res.json(ctx.transfers.retryTransfer(String(req.params.id)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Retry failed' });
    }
  });

  router.post('/transfers/:id/cancel', requireSession, requireStorageReady, (req, res) => {
    try {
      res.json(ctx.transfers.cancelTransfer(String(req.params.id)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Cancel failed' });
    }
  });

  router.delete('/transfers/history', requireSession, requireStorageReady, (_req, res) => {
    ctx.db.clearCompletedTransfers();
    res.json({ ok: true });
  });

  // --- Analytics ---
  router.get('/analytics', requireSession, requireStorageReady, (_req, res) => {
    const root = ctx.storage.getRoot();
    const volume = getVolumeStats(root);
    const summary = ctx.db.getAnalyticsSummary();
    const history = ctx.db.getStorageHistory(30);
    const recentlyAdded = ctx.db.listFiles({
      includeDeleted: false,
      sortBy: 'importedAt',
      sortDir: 'desc',
      limit: 12,
    });
    res.json({
      volume,
      ...summary,
      recentlyAdded,
      history,
    });
  });

  // --- Scanner ---
  router.get('/scanner/status', requireSession, (_req, res) => {
    res.json(ctx.scanner.getState());
  });

  router.post('/scanner/start', requireSession, requireStorageReady, async (_req, res) => {
    try {
      const result = await ctx.scanner.runScan();
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Scan failed' });
    }
  });

  // --- Recycle Bin ---
  router.get('/recycle-bin', requireSession, requireStorageReady, (_req, res) => {
    const items = ctx.db.listFiles({
      onlyDeleted: true,
      sortBy: 'modifiedAt',
      sortDir: 'desc',
    });
    const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
    res.json({ items, totalBytes });
  });

  router.post('/recycle-bin/:id/restore', requireSession, requireStorageReady, (req, res) => {
    try {
      const restored = ctx.storage.restoreFile(String(req.params.id));
      res.json(restored);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Restore failed' });
    }
  });

  router.delete('/recycle-bin/:id', requireSession, requireStorageReady, (req, res) => {
    try {
      ctx.storage.permanentlyDeleteFile(String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Permanent delete failed' });
    }
  });

  router.post('/recycle-bin/empty', requireSession, requireStorageReady, (_req, res) => {
    const removed = ctx.storage.emptyRecycleBin();
    res.json({ removed });
  });

  // --- Local Storage Server ---
  router.get('/server/status', requireSession, (_req, res) => {
    res.json(ctx.lanServer.getStatus());
  });

  router.post('/server/start', requireSession, requireStorageReady, async (req, res) => {
    try {
      const port = req.body?.port ? Number(req.body.port) : undefined;
      const bindLan = typeof req.body?.bindLan === 'boolean' ? req.body.bindLan : undefined;
      const status = await ctx.lanServer.start(port, bindLan);
      res.json(status);
    } catch (err) {
      res.status(409).json({
        error: err instanceof Error ? err.message : 'Failed to start server',
        status: ctx.lanServer.getStatus(),
      });
    }
  });

  router.post('/server/stop', requireSession, async (_req, res) => {
    const status = await ctx.lanServer.stop();
    res.json(status);
  });

  router.patch('/server/config', requireSession, requireStorageReady, async (req, res) => {
    const port = req.body?.port !== undefined ? Number(req.body.port) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
      res.status(400).json({ error: 'Port must be an integer between 1024 and 65535' });
      return;
    }
    const wasRunning = ctx.lanServer.getStatus().running;
    if (wasRunning) {
      await ctx.lanServer.stop();
    }
    const updated = ctx.db.updateSettings({
      serverPort: port,
      serverAutoStart:
        typeof req.body?.autoStart === 'boolean' ? req.body.autoStart : undefined,
      serverBindLan:
        typeof req.body?.bindLan === 'boolean' ? req.body.bindLan : undefined,
    });
    if (wasRunning) {
      try {
        await ctx.lanServer.start(updated.serverPort, updated.serverBindLan);
      } catch (err) {
        res.status(409).json({
          error: err instanceof Error ? err.message : 'Failed to restart server on new port',
          settings: updated,
          status: ctx.lanServer.getStatus(),
        });
        return;
      }
    }
    res.json({ settings: updated, status: ctx.lanServer.getStatus() });
  });

  // --- Devices & QR Pairing ---
  router.get('/devices', requireSession, (_req, res) => {
    res.json({ devices: ctx.db.listDevices() });
  });

  router.post('/devices/pairing-qr', requireSession, requireStorageReady, async (_req, res) => {
    try {
      const code = crypto.randomInt(100000, 999999).toString();
      const secret = crypto.randomBytes(24).toString('hex');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      ctx.db.createPairingSession(crypto.randomUUID(), code, secret, expiresAt);

      const srvStatus = ctx.lanServer.getStatus();
      const settings = ctx.db.getSettings();
      const lanIps = getLanIpv4Addresses();
      const payload = {
        protocol: 'haven-pair-v1',
        host: lanIps[0] || '127.0.0.1',
        hosts: lanIps,
        port: srvStatus.running ? srvStatus.port : settings.serverPort,
        serverRunning: srvStatus.running,
        code,
        secret,
        expiresAt,
      };
      const qrDataUrl = await QRCode.toDataURL(JSON.stringify(payload), {
        width: 240,
        margin: 1,
        color: { dark: '#18181B', light: '#FFFFFF' },
      });
      res.json({ payload, qrDataUrl });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'QR generation failed' });
    }
  });

  router.patch('/devices/:id/permissions', requireSession, requireStorageReady, (req, res) => {
    const permissions = req.body?.permissions as DevicePermissions;
    if (!permissions) {
      res.status(400).json({ error: 'permissions object required' });
      return;
    }
    ctx.db.updateDevicePermissions(String(req.params.id), {
      readFiles: Boolean(permissions.readFiles),
      uploadFiles: Boolean(permissions.uploadFiles),
      deleteFiles: Boolean(permissions.deleteFiles),
      streamMedia: Boolean(permissions.streamMedia),
      syncFolders: Boolean(permissions.syncFolders),
    });
    res.json({ ok: true });
  });

  router.post('/devices/:id/revoke', requireSession, requireStorageReady, (req, res) => {
    ctx.db.revokeDevice(String(req.params.id));
    ctx.db.log('warn', 'auth', `Revoked device access (${req.params.id})`);
    res.json({ ok: true });
  });

  router.delete('/devices/:id', requireSession, requireStorageReady, (req, res) => {
    ctx.db.deleteDevice(String(req.params.id));
    res.json({ ok: true });
  });

  // --- Sync (Active with Stage 2 Mobile Client) ---
  router.get('/sync', requireSession, (_req, res) => {
    const activeDevices = ctx.db.listDevices().filter((d) => !d.isRevoked);
    res.json({
      stage2Required: activeDevices.length === 0,
      pairedDeviceCount: activeDevices.length,
      rules: ctx.db.listSyncRules(),
      history: ctx.db.listSyncHistory(),
    });
  });

  router.post('/sync/rules', requireSession, requireStorageReady, (req, res) => {
    const { name, direction, localFolderId, remotePath, exclusions, conflictPolicy, deviceId } = req.body || {};
    if (!name || !remotePath) {
      res.status(400).json({ error: 'Rule name and Android folder path are required' });
      return;
    }
    const fld = localFolderId ? ctx.db.getFolderById(String(localFolderId)) : null;
    const activeDevices = ctx.db.listDevices().filter((d) => !d.isRevoked);
    const hasDevice = Boolean(deviceId) || activeDevices.length > 0;
    const rule = {
      id: crypto.randomUUID(),
      deviceId: typeof deviceId === 'string' && deviceId ? deviceId : null,
      name: String(name),
      direction:
        direction === 'one_way_to_mobile' || direction === 'two_way'
          ? direction
          : ('one_way_to_pc' as const),
      localFolderId: fld ? fld.id : null,
      localFolderPath: fld ? fld.relativePath : 'Files',
      remotePath: String(remotePath),
      exclusions: Array.isArray(exclusions) ? exclusions.map(String) : [],
      conflictPolicy:
        conflictPolicy === 'prefer_pc' || conflictPolicy === 'prefer_mobile' || conflictPolicy === 'ask'
          ? conflictPolicy
          : ('keep_both' as const),
      enabled: hasDevice,
      status: hasDevice ? ('idle' as const) : ('awaiting_device' as const),
      lastSyncAt: null,
      createdAt: new Date().toISOString(),
    };
    ctx.db.createSyncRule(rule);
    res.status(201).json(rule);
  });

  router.patch('/sync/rules/:id', requireSession, requireStorageReady, (req, res) => {
    const id = String(req.params.id);
    const existing = ctx.db.getSyncRuleById(id);
    if (!existing) {
      res.status(404).json({ error: 'Sync rule not found' });
      return;
    }
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : existing.enabled;
    const deviceId =
      req.body?.deviceId === null
        ? null
        : typeof req.body?.deviceId === 'string'
        ? req.body.deviceId
        : existing.deviceId;
    const activeDevices = ctx.db.listDevices().filter((d) => !d.isRevoked);
    const nextStatus = !enabled
      ? ('disabled' as const)
      : activeDevices.length > 0 || deviceId
      ? ('idle' as const)
      : ('awaiting_device' as const);
    const updated = ctx.db.updateSyncRule(id, {
      enabled,
      deviceId,
      status: nextStatus,
    });
    res.json(updated);
  });

  router.delete('/sync/rules/:id', requireSession, requireStorageReady, (req, res) => {
    ctx.db.deleteSyncRule(String(req.params.id));
    res.json({ ok: true });
  });

  // --- Settings & Database Maintenance & Logs ---
  router.get('/settings', requireSession, (_req, res) => {
    res.json({
      settings: ctx.db.getSettings(),
      dbPath: ctx.db.getDbPath(),
      configDir: ctx.db.getConfigDir(),
    });
  });

  router.patch('/settings', requireSession, requireStorageReady, (req, res) => {
    const allowedKeys = new Set([
      'theme',
      'language',
      'startWithWindows',
      'minimizeToTray',
      'closeToTray',
      'warningThresholdPct',
      'serverAutoStart',
      'maxConcurrentTransfers',
      'transferRetryLimit',
      'scheduledScanMinutes',
    ]);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (allowedKeys.has(k)) patch[k] = v;
    }
    const updated = ctx.db.updateSettings(patch);
    if (patch.scheduledScanMinutes !== undefined) {
      ctx.scanner.configureSchedule(updated.scheduledScanMinutes);
    }
    res.json({ settings: updated });
  });

  router.get('/database/status', requireSession, requireStorageReady, (_req, res) => {
    const root = ctx.storage.getRoot();
    const backupsDir = path.join(root, 'Backups');
    const backups = fs.existsSync(backupsDir)
      ? fs
          .readdirSync(backupsDir)
          .filter((f) => f.endsWith('.sqlite'))
          .map((f) => {
            const full = path.join(backupsDir, f);
            const st = fs.statSync(full);
            return { name: f, path: full, size: st.size, createdAt: st.mtime.toISOString() };
          })
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : [];
    const dbPath = ctx.db.getDbPath();
    const dbSize = dbPath && fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    res.json({
      dbPath,
      dbSize,
      integrity: ctx.db.checkIntegrity(),
      backups,
    });
  });

  router.post('/database/backup', requireSession, requireStorageReady, async (_req, res) => {
    try {
      const backup = await ctx.db.backupDatabase(ctx.storage.getRoot());
      res.status(201).json(backup);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed' });
    }
  });

  router.post('/database/restore', requireSession, requireStorageReady, (req, res) => {
    try {
      const backupName = typeof req.body?.backupName === 'string' ? req.body.backupName : '';
      if (!backupName) {
        res.status(400).json({ error: 'backupName is required' });
        return;
      }
      const backupPath = assertInsideRoot(ctx.storage.getRoot(), `Backups/${path.basename(backupName)}`);
      const result = ctx.db.restoreDatabase(backupPath);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Restore failed' });
    }
  });

  router.post('/database/integrity', requireSession, requireStorageReady, (_req, res) => {
    res.json(ctx.db.checkIntegrity());
  });

  router.post('/database/rebuild', requireSession, requireStorageReady, async (_req, res) => {
    const scanResult = await ctx.scanner.runScan();
    res.json(scanResult);
  });

  router.get('/logs', requireSession, (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const level = typeof req.query.level === 'string' ? req.query.level : undefined;
    res.json({ logs: ctx.db.getLogs(250, category, level) });
  });

  router.get('/logs/export', requireSession, (_req, res) => {
    const logs = ctx.db.getLogs(1000);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="haven-logs.json"');
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), logs }, null, 2));
  });

  return router;
}
