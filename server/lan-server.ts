import crypto from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { HavenDatabase } from './db.ts';
import { assertInsideRoot, getVolumeStats, type StorageEngine } from './storage.ts';
import type { TransferEngine } from './transfers.ts';
import type { DeviceRecord, StorageServerStatus } from './types.ts';

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function getLanIpv4Addresses(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

export function streamFileWithRange(
  req: Request,
  res: Response,
  absPath: string,
  mimeType: string,
  fileName: string,
  downloadDisposition = false
): void {
  if (!fs.existsSync(absPath)) {
    res.status(404).json({ error: 'File payload missing on disk' });
    return;
  }
  const stat = fs.statSync(absPath);
  const fileSize = stat.size;
  const rangeHeader = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  if (downloadDisposition) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
  }

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? Math.min(fileSize - 1, parseInt(match[2], 10)) : fileSize - 1;
    if (start >= fileSize || start > end || start < 0) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);
    fs.createReadStream(absPath, { start, end, highWaterMark: 256 * 1024 }).pipe(res);
    return;
  }

  res.status(200);
  res.setHeader('Content-Length', fileSize);
  fs.createReadStream(absPath, { highWaterMark: 256 * 1024 }).pipe(res);
}

export class LocalStorageServer {
  private db: HavenDatabase;
  private storage: StorageEngine;
  private transfers: TransferEngine;
  private server: http.Server | null = null;
  private authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, forwardedHeader: false },
    message: { error: 'Too many pairing or authentication attempts. Try again shortly.' },
  });
  private apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, forwardedHeader: false },
    message: { error: 'Rate limit exceeded' },
  });
  private status: StorageServerStatus = {
    running: false,
    port: 48720,
    bindAddress: '0.0.0.0',
    lanUrls: [],
    startedAt: null,
    activeConnections: 0,
    lastError: null,
  };

  constructor(db: HavenDatabase, storage: StorageEngine, transfers: TransferEngine) {
    this.db = db;
    this.storage = storage;
    this.transfers = transfers;
  }

  getStatus(): StorageServerStatus {
    const settings = this.db.getSettings();
    const port = this.status.running ? this.status.port : settings.serverPort;
    const ips = getLanIpv4Addresses();
    const lanUrls = this.status.running
      ? [
          `http://127.0.0.1:${port}`,
          ...(settings.serverBindLan ? ips.map((ip) => `http://${ip}:${port}`) : []),
        ]
      : [];
    return {
      ...this.status,
      port,
      lanUrls,
    };
  }

  private createExpressApp(): express.Express {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2mb' }));

    app.use('/api/v1', this.apiLimiter);

    const authenticateDevice = (req: Request, res: Response, next: NextFunction) => {
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) {
        this.db.log('warn', 'auth', `Unauthorized LAN API access attempt to ${req.path}`, {
          ip: req.ip,
        });
        res.status(401).json({ error: 'Authentication required. Provide Bearer device token.' });
        return;
      }
      const token = header.slice('Bearer '.length).trim();
      const device = this.db.findDeviceByTokenHash(hashToken(token));
      if (!device) {
        this.db.log('warn', 'auth', `Invalid or revoked device token used on ${req.path}`, {
          ip: req.ip,
        });
        res.status(401).json({ error: 'Invalid or revoked device token' });
        return;
      }
      this.db.touchDevice(device.id, req.ip || null);
      (req as Request & { device: DeviceRecord }).device = device;
      next();
    };

    app.get('/api/v1/health', (_req, res) => {
      res.json({
        service: 'haven-storage-server',
        protocolVersion: '1.0',
        setupCompleted: this.db.isOpen(),
        timestamp: new Date().toISOString(),
      });
    });

    app.post('/api/v1/pair', this.authLimiter, (req, res) => {
      try {
        if (!this.db.isOpen()) {
          res.status(503).json({ error: 'Storage server is not initialized yet' });
          return;
        }
        const { code, secret, deviceName, deviceType, osVersion } = req.body || {};
        if (!code || !secret || !deviceName) {
          res.status(400).json({ error: 'code, secret, and deviceName are required' });
          return;
        }
        const check = this.db.consumePairingSession(String(code), String(secret));
        if (!check.valid) {
          this.db.log('warn', 'auth', `Failed pairing attempt for ${deviceName}: ${check.reason}`, {
            ip: req.ip,
          });
          res.status(401).json({ error: check.reason || 'Pairing failed' });
          return;
        }

        const rawToken = `hvn_${crypto.randomBytes(32).toString('hex')}`;
        const deviceId = crypto.randomUUID();
        const now = new Date().toISOString();
        const device: DeviceRecord & { tokenHash: string } = {
          id: deviceId,
          name: String(deviceName).slice(0, 80),
          deviceType: deviceType === 'windows' ? 'windows' : 'android',
          osVersion: String(osVersion || 'Android').slice(0, 40),
          tokenHash: hashToken(rawToken),
          permissions: {
            readFiles: true,
            uploadFiles: true,
            deleteFiles: false,
            streamMedia: true,
            syncFolders: true,
          },
          status: 'connected',
          isRevoked: false,
          pairedAt: now,
          lastConnectedAt: now,
          lastSeenAt: now,
          ipAddress: req.ip || null,
        };
        this.db.createDevice(device);
        this.db.log('info', 'server', `Paired new device: ${device.name}`, {
          deviceId,
          ip: req.ip,
        });

        res.status(201).json({
          deviceId,
          token: rawToken,
          permissions: device.permissions,
          serverName: os.hostname(),
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Pairing error' });
      }
    });

    app.get('/api/v1/storage/info', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.readFiles) {
        res.status(403).json({ error: 'Device lacks readFiles permission' });
        return;
      }
      if (!this.db.isOpen()) {
        res.status(503).json({ error: 'Storage not initialized' });
        return;
      }
      const root = this.storage.getRoot();
      const volume = getVolumeStats(root);
      const summary = this.db.getAnalyticsSummary();
      res.json({
        serverName: os.hostname(),
        storageRoot: root,
        volume,
        totalFiles: summary.totalFiles,
        totalFolders: summary.totalFolders,
        totalManagedBytes: summary.totalManagedBytes,
      });
    });

    app.get('/api/v1/files', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.readFiles) {
        res.status(403).json({ error: 'Device lacks readFiles permission' });
        return;
      }
      const folderIdParam = typeof req.query.folderId === 'string' ? req.query.folderId : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const favoriteOnly = req.query.favorites === '1';
      const recentOnly = req.query.recent === '1';
      const sortBy = (typeof req.query.sortBy === 'string' ? req.query.sortBy : 'name') as
        | 'name'
        | 'size'
        | 'modifiedAt'
        | 'importedAt';
      const sortDir = req.query.sortDir === 'desc' ? 'desc' : 'asc';

      let folders = [] as ReturnType<HavenDatabase['listFolders']>;
      let files = [] as ReturnType<HavenDatabase['listFiles']>;
      let breadcrumbs: Array<{ id: string | null; name: string }> = [
        { id: null, name: 'HavenStorage' },
      ];

      if ((search && search.trim().length > 0) || (category && category !== 'all') || favoriteOnly || recentOnly) {
        files = this.db.listFiles({
          includeDeleted: false,
          category,
          search,
          favoriteOnly,
          sortBy: recentOnly ? 'importedAt' : sortBy,
          sortDir: recentOnly ? 'desc' : sortDir,
          limit: recentOnly ? 50 : undefined,
        });
      } else {
        const folderId = folderIdParam && folderIdParam.length > 0 ? folderIdParam : null;
        folders = this.db.listFolders(folderId, false);
        files = this.db.listFiles({
          folderId,
          includeDeleted: false,
          sortBy,
          sortDir,
        });

        if (folderId) {
          const chain: Array<{ id: string | null; name: string }> = [];
          let cursor = this.db.getFolderById(folderId);
          while (cursor) {
            chain.unshift({ id: cursor.id, name: cursor.name });
            cursor = cursor.parentId ? this.db.getFolderById(cursor.parentId) : null;
          }
          breadcrumbs = [{ id: null, name: 'HavenStorage' }, ...chain];
        }
      }

      const allFolders = this.db.listFolders(null, true);
      res.json({ folders, files, breadcrumbs, allFolders });
    });

    app.post('/api/v1/folders', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.uploadFiles) {
        res.status(403).json({ error: 'Device lacks uploadFiles permission' });
        return;
      }
      try {
        const name = typeof req.body?.name === 'string' ? req.body.name : '';
        const parentId = typeof req.body?.parentId === 'string' && req.body.parentId ? req.body.parentId : null;
        const folder = this.storage.createFolder(name, parentId, device.name);
        res.status(201).json(folder);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create folder' });
      }
    });

    app.patch('/api/v1/files/:id', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.uploadFiles) {
        res.status(403).json({ error: 'Device lacks uploadFiles permission' });
        return;
      }
      try {
        const id = String(req.params.id);
        let file = this.db.getFileById(id);
        if (!file || file.isDeleted) {
          res.status(404).json({ error: 'File not found' });
          return;
        }
        if (typeof req.body?.name === 'string' && req.body.name !== file.name) {
          file = this.storage.renameFile(id, req.body.name);
        }
        if (typeof req.body?.isFavorite === 'boolean') {
          this.db.updateFileFields(id, { isFavorite: req.body.isFavorite });
        }
        if (Array.isArray(req.body?.tags)) {
          this.db.updateFileFields(id, { tags: req.body.tags.map(String) });
        }
        res.json(this.db.getFileById(id));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' });
      }
    });

    app.delete('/api/v1/files/:id', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.deleteFiles) {
        res.status(403).json({ error: 'Device lacks deleteFiles permission' });
        return;
      }
      try {
        const file = this.storage.softDeleteFile(String(req.params.id));
        res.json(file);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' });
      }
    });

    app.get('/api/v1/media', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.readFiles) {
        res.status(403).json({ error: 'Device lacks readFiles permission' });
        return;
      }
      const type = req.query.type === 'photo' || req.query.type === 'video' ? req.query.type : 'all';
      const sortBy = req.query.sortBy === 'size' ? 'size' : 'modifiedAt';
      const sortDir = req.query.sortDir === 'asc' ? 'asc' : 'desc';
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const favoriteOnly = req.query.favorites === '1';
      const folderId = typeof req.query.folderId === 'string' && req.query.folderId ? req.query.folderId : undefined;

      const photos =
        type === 'all' || type === 'photo'
          ? this.db.listFiles({
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
        (type === 'all' || type === 'video') && device.permissions.streamMedia
          ? this.db.listFiles({
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
        const fld = item.folderId ? this.db.getFolderById(item.folderId) : null;
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

    app.get('/api/v1/files/:id/content', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      const file = this.db.getFileById(String(req.params.id));
      if (!file || file.isDeleted) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      if ((file.category === 'video' || file.category === 'audio') && !device.permissions.streamMedia) {
        res.status(403).json({ error: 'Device lacks streamMedia permission' });
        return;
      }
      if (!device.permissions.readFiles) {
        res.status(403).json({ error: 'Device lacks readFiles permission' });
        return;
      }
      const abs = assertInsideRoot(this.storage.getRoot(), file.relativePath);
      const download = req.query.download === '1';
      if (download) {
        this.transfers.recordDownloadSession(file.id, device.id);
      }
      streamFileWithRange(req, res, abs, file.mimeType, file.name, download);
    });

    app.get('/api/v1/files/:id/thumbnail', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.readFiles) {
        res.status(403).json({ error: 'Device lacks readFiles permission' });
        return;
      }
      const file = this.db.getFileById(String(req.params.id));
      if (!file || !file.thumbnailPath) {
        res.status(404).json({ error: 'Thumbnail not available' });
        return;
      }
      const abs = assertInsideRoot(this.storage.getRoot(), file.thumbnailPath);
      if (!fs.existsSync(abs)) {
        res.status(404).json({ error: 'Thumbnail missing on disk' });
        return;
      }
      res.setHeader('Content-Type', 'image/webp');
      fs.createReadStream(abs).pipe(res);
    });

    app.get('/api/v1/transfers/:id', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.uploadFiles && !device.permissions.readFiles) {
        res.status(403).json({ error: 'Device lacks transfer inspection permission' });
        return;
      }
      const tr = this.db.getTransfer(String(req.params.id));
      if (!tr) {
        res.status(404).json({ error: 'Transfer session not found' });
        return;
      }
      res.json(tr);
    });

    app.post('/api/v1/transfers/upload', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.uploadFiles) {
        res.status(403).json({ error: 'Device lacks uploadFiles permission' });
        return;
      }
      try {
        const { fileName, totalBytes, folderId, chunkSize, sha256Expected } = req.body || {};
        if (!fileName || totalBytes === undefined) {
          res.status(400).json({ error: 'fileName and totalBytes are required' });
          return;
        }
        const transfer = this.transfers.createUploadSession({
          fileName: String(fileName),
          totalBytes: Number(totalBytes),
          folderId: folderId ? String(folderId) : null,
          chunkSize: chunkSize ? Number(chunkSize) : undefined,
          sha256Expected: sha256Expected ? String(sha256Expected) : null,
          deviceId: device.id,
        });
        res.status(201).json(transfer);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Upload init failed' });
      }
    });

    app.put(
      '/api/v1/transfers/:id/chunks/:index',
      authenticateDevice,
      express.raw({ type: 'application/octet-stream', limit: '36mb' }),
      async (req, res) => {
        const device = (req as Request & { device: DeviceRecord }).device;
        if (!device.permissions.uploadFiles) {
          res.status(403).json({ error: 'Device lacks uploadFiles permission' });
          return;
        }
        try {
          const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
          const chunkSha256 =
            typeof req.headers['x-chunk-sha256'] === 'string'
              ? req.headers['x-chunk-sha256']
              : null;
          const transfer = await this.transfers.writeChunk({
            transferId: String(req.params.id),
            chunkIndex: Number(req.params.index),
            data,
            chunkSha256,
          });
          res.json(transfer);
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : 'Chunk write failed' });
        }
      }
    );

    app.post('/api/v1/transfers/:id/complete', authenticateDevice, async (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.uploadFiles) {
        res.status(403).json({ error: 'Device lacks uploadFiles permission' });
        return;
      }
      try {
        const result = await this.transfers.finalizeUpload(String(req.params.id));
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Finalize failed' });
      }
    });

    app.get('/api/v1/sync/rules', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.syncFolders) {
        res.status(403).json({ error: 'Device lacks syncFolders permission' });
        return;
      }
      const allRules = this.db.listSyncRules();
      const rules = allRules.filter(
        (r) => r.deviceId === null || r.deviceId === device.id
      );
      res.json({
        rules,
        allFolders: this.db.listFolders(null, true),
      });
    });

    app.post('/api/v1/sync/rules/:id/report', authenticateDevice, (req, res) => {
      const device = (req as Request & { device: DeviceRecord }).device;
      if (!device.permissions.syncFolders) {
        res.status(403).json({ error: 'Device lacks syncFolders permission' });
        return;
      }
      const ruleId = String(req.params.id);
      const existing = this.db.getSyncRuleById(ruleId);
      if (!existing) {
        res.status(404).json({ error: 'Sync rule not found' });
        return;
      }
      const now = new Date().toISOString();
      const status =
        req.body?.status === 'conflict' || req.body?.status === 'error'
          ? String(req.body.status)
          : 'completed';
      const filesSynced = Math.max(0, Number(req.body?.filesSynced || 0));
      const conflictsDetected = Math.max(0, Number(req.body?.conflictsDetected || 0));
      const message =
        typeof req.body?.message === 'string' && req.body.message.trim().length > 0
          ? req.body.message.trim().slice(0, 240)
          : `${device.name} synced ${filesSynced} file(s) for ${existing.name}`;

      this.db.addSyncHistory({
        id: crypto.randomUUID(),
        ruleId,
        status,
        filesSynced,
        conflictsDetected,
        message,
        createdAt: now,
      });

      const updatedRule = this.db.updateSyncRule(ruleId, {
        deviceId: existing.deviceId || device.id,
        enabled: true,
        status: conflictsDetected > 0 ? 'conflict' : 'active',
        lastSyncAt: now,
      });

      this.db.log('info', 'server', message, {
        ruleId,
        deviceId: device.id,
        filesSynced,
        conflictsDetected,
      });

      res.json({ rule: updatedRule });
    });

    return app;
  }

  async start(portOverride?: number, bindLanOverride?: boolean): Promise<StorageServerStatus> {
    if (this.server) {
      return this.getStatus();
    }
    const settings = this.db.getSettings();
    const port = portOverride ?? settings.serverPort;
    const bindLan = bindLanOverride ?? settings.serverBindLan;
    const bindAddress = bindLan ? '0.0.0.0' : '127.0.0.1';
    const app = this.createExpressApp();

    await new Promise<void>((resolve, reject) => {
      const srv = http.createServer(app);
      let settled = false;

      srv.on('connection', (socket) => {
        this.status.activeConnections += 1;
        socket.on('close', () => {
          this.status.activeConnections = Math.max(0, this.status.activeConnections - 1);
        });
      });

      srv.on('error', (err: NodeJS.ErrnoException) => {
        const msg =
          err.code === 'EADDRINUSE'
            ? `Port ${port} is already in use by another application.`
            : err.message;
        this.status.lastError = msg;
        this.db.log('error', 'server', `Storage server failed to start on port ${port}: ${msg}`);
        if (!settled) {
          settled = true;
          reject(new Error(msg));
        }
      });

      srv.listen(port, bindAddress, () => {
        this.server = srv;
        this.status = {
          running: true,
          port,
          bindAddress,
          lanUrls: [],
          startedAt: new Date().toISOString(),
          activeConnections: 0,
          lastError: null,
        };
        if (this.db.isOpen()) {
          this.db.updateSettings({ serverEnabled: true, serverPort: port, serverBindLan: bindLan });
          this.db.log('info', 'server', `Storage server started on ${bindAddress}:${port}`);
        }
        settled = true;
        resolve();
      });
    });

    return this.getStatus();
  }

  async stop(): Promise<StorageServerStatus> {
    if (!this.server) {
      this.status.running = false;
      return this.getStatus();
    }
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      srv.close(() => {
        resolve();
      });
      if (typeof srv.closeAllConnections === 'function') {
        srv.closeAllConnections();
      }
    });
    this.status.running = false;
    this.status.startedAt = null;
    this.status.activeConnections = 0;
    if (this.db.isOpen()) {
      this.db.updateSettings({ serverEnabled: false });
      this.db.log('info', 'server', 'Storage server stopped');
    }
    return this.getStatus();
  }
}
