import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { HavenDatabase } from './db.ts';
import {
  assertInsideRoot,
  classifyFile,
  computeSha256,
  defaultRootSubdirForCategory,
  getVolumeStats,
  sanitizeFileName,
  type StorageEngine,
} from './storage.ts';
import type { FileRecord, TransferRecord } from './types.ts';

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB chunks (scales smoothly to 10GB+)

export class TransferEngine {
  private db: HavenDatabase;
  private storage: StorageEngine;
  private activeSpeedWindow = new Map<string, { lastBytes: number; lastTime: number }>();

  constructor(db: HavenDatabase, storage: StorageEngine) {
    this.db = db;
    this.storage = storage;
  }

  private getTempPartPath(transferId: string): string {
    const root = this.storage.getRoot();
    const tempDir = path.join(root, 'Temp');
    fs.mkdirSync(tempDir, { recursive: true });
    return assertInsideRoot(root, `Temp/${transferId}.part`);
  }

  createUploadSession(params: {
    fileName: string;
    totalBytes: number;
    folderId?: string | null;
    chunkSize?: number;
    sha256Expected?: string | null;
    deviceId?: string | null;
  }): TransferRecord {
    const cleanName = sanitizeFileName(params.fileName);
    const totalBytes = Math.max(0, Number(params.totalBytes));
    const chunkSize = Math.max(64 * 1024, Math.min(32 * 1024 * 1024, params.chunkSize || DEFAULT_CHUNK_SIZE));
    const totalChunks = totalBytes === 0 ? 1 : Math.ceil(totalBytes / chunkSize);

    const root = this.storage.getRoot();
    const volStats = getVolumeStats(root);
    if (volStats.available && volStats.freeBytes < totalBytes) {
      throw new Error(
        `Insufficient disk space: need ${totalBytes} bytes, only ${volStats.freeBytes} bytes available`
      );
    }

    const settings = this.db.getSettings();
    const activeCount = this.db
      .listTransfers()
      .filter((t) => t.status === 'active' || t.status === 'verifying').length;

    const { category } = classifyFile(cleanName);
    let targetDir = defaultRootSubdirForCategory(category);
    let folderId = params.folderId || null;
    if (folderId) {
      const fld = this.db.getFolderById(folderId);
      if (fld) targetDir = fld.relativePath;
      else folderId = null;
    } else {
      const fld = this.db.getFolderByPath(targetDir);
      folderId = fld ? fld.id : null;
    }

    const targetRelativePath = this.storage.ensureUniqueRelativePath(`${targetDir}/${cleanName}`);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const record: TransferRecord = {
      id,
      direction: 'upload',
      fileId: null,
      fileName: cleanName,
      targetRelativePath,
      folderId,
      totalBytes,
      transferredBytes: 0,
      chunkSize,
      totalChunks,
      verifiedChunks: [],
      status: activeCount >= settings.maxConcurrentTransfers ? 'queued' : 'active',
      speedBps: 0,
      etaSeconds: null,
      sha256Expected: params.sha256Expected || null,
      sha256Actual: null,
      retryCount: 0,
      maxRetries: settings.transferRetryLimit,
      errorMessage: null,
      deviceId: params.deviceId || null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    // Touch temp file safely
    const partPath = this.getTempPartPath(id);
    const fd = fs.openSync(partPath, 'w');
    fs.closeSync(fd);

    this.db.upsertTransfer(record);
    this.activeSpeedWindow.set(id, { lastBytes: 0, lastTime: Date.now() });
    this.db.log('info', 'transfer', `Started upload session for ${cleanName} (${totalBytes} bytes)`, {
      transferId: id,
      totalChunks,
      chunkSize,
    });
    return record;
  }

  async writeChunk(params: {
    transferId: string;
    chunkIndex: number;
    data: Buffer;
    chunkSha256?: string | null;
  }): Promise<TransferRecord> {
    const t = this.db.getTransfer(params.transferId);
    if (!t) throw new Error('Transfer session not found');
    if (t.status === 'cancelled' || t.status === 'completed') {
      throw new Error(`Cannot write chunk to ${t.status} transfer`);
    }
    if (t.status === 'paused') {
      throw new Error('Transfer is paused. Resume before sending chunks.');
    }
    if (params.chunkIndex < 0 || params.chunkIndex >= t.totalChunks) {
      throw new Error(`Invalid chunk index ${params.chunkIndex} (expected 0..${t.totalChunks - 1})`);
    }

    if (params.chunkSha256) {
      const actualChunkHash = crypto.createHash('sha256').update(params.data).digest('hex');
      if (actualChunkHash.toLowerCase() !== params.chunkSha256.toLowerCase()) {
        const nextRetry = t.retryCount + 1;
        const failed = nextRetry > t.maxRetries;
        const updated: TransferRecord = {
          ...t,
          retryCount: nextRetry,
          status: failed ? 'failed' : t.status,
          errorMessage: `Chunk ${params.chunkIndex} checksum mismatch`,
          updatedAt: new Date().toISOString(),
        };
        this.db.upsertTransfer(updated);
        this.db.log('error', 'transfer', `Chunk ${params.chunkIndex} checksum mismatch for ${t.fileName}`);
        throw new Error(`Chunk ${params.chunkIndex} checksum mismatch`);
      }
    }

    const partPath = this.getTempPartPath(t.id);
    const offset = params.chunkIndex * t.chunkSize;
    const handle = await fs.promises.open(partPath, fs.existsSync(partPath) ? 'r+' : 'w+');
    try {
      await handle.write(params.data, 0, params.data.length, offset);
      await handle.sync();
    } finally {
      await handle.close();
    }

    const verifiedSet = new Set(t.verifiedChunks);
    verifiedSet.add(params.chunkIndex);
    const verifiedChunks = Array.from(verifiedSet).sort((a, b) => a - b);

    // Compute exact verified byte count (last chunk may be smaller than chunkSize)
    let transferredBytes = 0;
    for (const idx of verifiedChunks) {
      if (idx === t.totalChunks - 1) {
        const rem = t.totalBytes - idx * t.chunkSize;
        transferredBytes += Math.max(0, rem);
      } else {
        transferredBytes += t.chunkSize;
      }
    }
    transferredBytes = Math.min(t.totalBytes, transferredBytes);

    const nowMs = Date.now();
    const prev = this.activeSpeedWindow.get(t.id) || { lastBytes: 0, lastTime: nowMs };
    const dtSec = Math.max(0.05, (nowMs - prev.lastTime) / 1000);
    const dBytes = Math.max(0, transferredBytes - prev.lastBytes);
    const speedBps = dBytes > 0 ? Math.round(dBytes / dtSec) : t.speedBps;
    const remaining = Math.max(0, t.totalBytes - transferredBytes);
    const etaSeconds = speedBps > 0 ? Math.ceil(remaining / speedBps) : null;
    this.activeSpeedWindow.set(t.id, { lastBytes: transferredBytes, lastTime: nowMs });

    const updated: TransferRecord = {
      ...t,
      status: 'active',
      verifiedChunks,
      transferredBytes,
      speedBps,
      etaSeconds,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    };
    this.db.upsertTransfer(updated);
    return updated;
  }

  async finalizeUpload(transferId: string): Promise<{ transfer: TransferRecord; file: FileRecord }> {
    const t = this.db.getTransfer(transferId);
    if (!t) throw new Error('Transfer session not found');

    if (t.verifiedChunks.length < t.totalChunks) {
      throw new Error(
        `Transfer incomplete: verified ${t.verifiedChunks.length} of ${t.totalChunks} chunks`
      );
    }

    const verifying: TransferRecord = {
      ...t,
      status: 'verifying',
      updatedAt: new Date().toISOString(),
    };
    this.db.upsertTransfer(verifying);

    const partPath = this.getTempPartPath(t.id);
    if (!fs.existsSync(partPath)) {
      throw new Error('Staged temporary file is missing');
    }

    const stat = fs.statSync(partPath);
    if (stat.size !== t.totalBytes) {
      const failed: TransferRecord = {
        ...verifying,
        status: 'failed',
        errorMessage: `Size mismatch: expected ${t.totalBytes} bytes, got ${stat.size} bytes`,
        updatedAt: new Date().toISOString(),
      };
      this.db.upsertTransfer(failed);
      throw new Error(failed.errorMessage!);
    }

    const sha256Actual = await computeSha256(partPath);
    if (t.sha256Expected && sha256Actual.toLowerCase() !== t.sha256Expected.toLowerCase()) {
      const failed: TransferRecord = {
        ...verifying,
        status: 'failed',
        sha256Actual,
        errorMessage: 'Final SHA-256 integrity verification failed',
        updatedAt: new Date().toISOString(),
      };
      this.db.upsertTransfer(failed);
      this.db.log('error', 'transfer', `Integrity check failed for ${t.fileName}`, {
        transferId: t.id,
        expected: t.sha256Expected,
        actual: sha256Actual,
      });
      throw new Error(failed.errorMessage!);
    }

    const file = await this.storage.finalizeStagedFile({
      stagedTempPath: partPath,
      fileName: t.fileName,
      folderId: t.folderId,
      deviceOrigin: t.deviceId || 'windows-pc',
      sha256: sha256Actual,
    });

    const now = new Date().toISOString();
    const completed: TransferRecord = {
      ...verifying,
      fileId: file.id,
      status: 'completed',
      transferredBytes: t.totalBytes,
      etaSeconds: 0,
      sha256Actual,
      errorMessage: null,
      updatedAt: now,
      completedAt: now,
    };
    this.db.upsertTransfer(completed);
    this.activeSpeedWindow.delete(t.id);
    this.promoteQueuedTransfers();
    this.db.log('info', 'transfer', `Completed and verified ${t.fileName}`, {
      transferId: t.id,
      fileId: file.id,
      sha256: sha256Actual,
    });
    return { transfer: completed, file };
  }

  recordDownloadSession(fileId: string, deviceId: string | null = null): TransferRecord {
    const file = this.db.getFileById(fileId);
    if (!file || file.isDeleted) throw new Error('File not found');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const record: TransferRecord = {
      id,
      direction: 'download',
      fileId: file.id,
      fileName: file.name,
      targetRelativePath: file.relativePath,
      folderId: file.folderId,
      totalBytes: file.size,
      transferredBytes: file.size,
      chunkSize: DEFAULT_CHUNK_SIZE,
      totalChunks: 1,
      verifiedChunks: [0],
      status: 'completed',
      speedBps: 0,
      etaSeconds: 0,
      sha256Expected: file.sha256,
      sha256Actual: file.sha256,
      retryCount: 0,
      maxRetries: 3,
      errorMessage: null,
      deviceId,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    };
    this.db.upsertTransfer(record);
    this.db.log('info', 'transfer', `Served download for ${file.name}`, {
      transferId: id,
      fileId: file.id,
    });
    return record;
  }

  pauseTransfer(id: string): TransferRecord {
    const t = this.db.getTransfer(id);
    if (!t) throw new Error('Transfer not found');
    if (t.status === 'completed' || t.status === 'cancelled') return t;
    const updated: TransferRecord = {
      ...t,
      status: 'paused',
      speedBps: 0,
      updatedAt: new Date().toISOString(),
    };
    this.db.upsertTransfer(updated);
    return updated;
  }

  resumeTransfer(id: string): TransferRecord {
    const t = this.db.getTransfer(id);
    if (!t) throw new Error('Transfer not found');
    if (t.status === 'completed' || t.status === 'cancelled') return t;
    const updated: TransferRecord = {
      ...t,
      status: 'active',
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    };
    this.db.upsertTransfer(updated);
    this.activeSpeedWindow.set(id, { lastBytes: t.transferredBytes, lastTime: Date.now() });
    return updated;
  }

  retryTransfer(id: string): TransferRecord {
    const t = this.db.getTransfer(id);
    if (!t) throw new Error('Transfer not found');
    const updated: TransferRecord = {
      ...t,
      status: 'active',
      retryCount: t.retryCount + 1,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    };
    this.db.upsertTransfer(updated);
    this.activeSpeedWindow.set(id, { lastBytes: t.transferredBytes, lastTime: Date.now() });
    return updated;
  }

  cancelTransfer(id: string): TransferRecord {
    const t = this.db.getTransfer(id);
    if (!t) throw new Error('Transfer not found');
    try {
      const partPath = this.getTempPartPath(id);
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    } catch {
      // ignore if root missing
    }
    const updated: TransferRecord = {
      ...t,
      status: 'cancelled',
      speedBps: 0,
      updatedAt: new Date().toISOString(),
    };
    this.db.upsertTransfer(updated);
    this.activeSpeedWindow.delete(id);
    this.promoteQueuedTransfers();
    return updated;
  }

  private promoteQueuedTransfers(): void {
    const settings = this.db.getSettings();
    const all = this.db.listTransfers();
    const activeCount = all.filter((t) => t.status === 'active' || t.status === 'verifying').length;
    if (activeCount >= settings.maxConcurrentTransfers) return;
    const queued = all.filter((t) => t.status === 'queued').reverse();
    const slots = settings.maxConcurrentTransfers - activeCount;
    for (const item of queued.slice(0, slots)) {
      this.db.upsertTransfer({
        ...item,
        status: 'active',
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
