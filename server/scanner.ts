import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { HavenDatabase } from './db.ts';
import {
  assertInsideRoot,
  classifyFile,
  computeSha256,
  getVolumeStats,
  normalizeRelPath,
  USER_MANAGED_ROOT_DIRS,
  type StorageEngine,
} from './storage.ts';
import type { FileRecord, ScannerState } from './types.ts';

export class StorageScanner {
  private db: HavenDatabase;
  private storage: StorageEngine;
  private state: ScannerState = {
    isRunning: false,
    lastRunAt: null,
    scannedCount: 0,
    newFiles: 0,
    missingFiles: 0,
    movedFiles: 0,
    hashedFiles: 0,
    thumbnailsGenerated: 0,
    duplicatesFound: 0,
    errors: [],
  };
  private scheduleTimer: NodeJS.Timeout | null = null;

  constructor(db: HavenDatabase, storage: StorageEngine) {
    this.db = db;
    this.storage = storage;
  }

  getState(): ScannerState {
    return { ...this.state, errors: [...this.state.errors] };
  }

  configureSchedule(minutes: number): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (minutes > 0) {
      this.scheduleTimer = setInterval(() => {
        if (this.db.isOpen() && !this.state.isRunning) {
          void this.runScan();
        }
      }, minutes * 60 * 1000);
    }
  }

  stopSchedule(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  async runScan(): Promise<ScannerState> {
    if (this.state.isRunning) {
      return this.getState();
    }
    if (!this.db.isOpen()) {
      throw new Error('Storage database is not initialized');
    }

    const root = this.storage.getRoot();
    this.state = {
      isRunning: true,
      lastRunAt: this.state.lastRunAt,
      scannedCount: 0,
      newFiles: 0,
      missingFiles: 0,
      movedFiles: 0,
      hashedFiles: 0,
      thumbnailsGenerated: 0,
      duplicatesFound: 0,
      errors: [],
    };

    try {
      const seenDiskRelPaths = new Set<string>();
      const newlyDiscovered: Array<{ absPath: string; relPath: string; folderId: string | null; size: number; mtime: Date; ctime: Date }> = [];

      const walkDir = async (absDir: string, relDir: string, parentFolderId: string | null) => {
        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(absDir, { withFileTypes: true });
        } catch (err) {
          this.state.errors.push(
            `Failed to read ${relDir}: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }

        for (const entry of entries) {
          if (entry.name.startsWith('.haven-')) continue;
          const childAbs = path.join(absDir, entry.name);
          const childRel = normalizeRelPath(`${relDir}/${entry.name}`);

          if (entry.isDirectory()) {
            let folder = this.db.getFolderByPath(childRel);
            if (!folder) {
              const now = new Date().toISOString();
              folder = {
                id: crypto.randomUUID(),
                name: entry.name,
                relativePath: childRel,
                parentId: parentFolderId,
                createdAt: now,
                modifiedAt: now,
                isFavorite: false,
                deviceOrigin: 'windows-pc',
              };
              this.db.upsertFolder(folder);
            }
            await walkDir(childAbs, childRel, folder.id);
          } else if (entry.isFile()) {
            seenDiskRelPaths.add(childRel);
            this.state.scannedCount += 1;

            try {
              const stat = await fs.promises.stat(childAbs);
              const existing = this.db.getFileByPath(childRel);
              if (!existing) {
                newlyDiscovered.push({
                  absPath: childAbs,
                  relPath: childRel,
                  folderId: parentFolderId,
                  size: stat.size,
                  mtime: stat.mtime,
                  ctime: stat.birthtime || stat.ctime,
                });
              } else {
                const updates: Partial<FileRecord> = {};
                if (existing.transferStatus === 'missing') {
                  updates.transferStatus = 'complete';
                }
                if (existing.size !== stat.size) {
                  updates.size = stat.size;
                  updates.sha256 = await computeSha256(childAbs);
                  this.state.hashedFiles += 1;
                } else if (!existing.sha256) {
                  updates.sha256 = await computeSha256(childAbs);
                  this.state.hashedFiles += 1;
                }
                if (!existing.thumbnailPath && existing.category === 'photo') {
                  const thumb = await this.storage.generateThumbnail(
                    existing.id,
                    childAbs,
                    existing.category
                  );
                  if (thumb) {
                    updates.thumbnailPath = thumb;
                    this.state.thumbnailsGenerated += 1;
                  }
                }
                if (Object.keys(updates).length > 0) {
                  this.db.updateFileFields(existing.id, updates);
                }
              }
            } catch (err) {
              this.state.errors.push(
                `Error indexing ${childRel}: ${err instanceof Error ? err.message : String(err)}`
              );
            }

            if (this.state.scannedCount % 25 === 0) {
              await new Promise((r) => setImmediate(r));
            }
          }
        }
      };

      for (const topDir of USER_MANAGED_ROOT_DIRS) {
        const topAbs = assertInsideRoot(root, topDir);
        if (!fs.existsSync(topAbs)) {
          fs.mkdirSync(topAbs, { recursive: true });
        }
        let topFolder = this.db.getFolderByPath(topDir);
        if (!topFolder) {
          const now = new Date().toISOString();
          topFolder = {
            id: crypto.randomUUID(),
            name: topDir,
            relativePath: topDir,
            parentId: null,
            createdAt: now,
            modifiedAt: now,
            isFavorite: false,
            deviceOrigin: 'windows-pc',
          };
          this.db.upsertFolder(topFolder);
        }
        await walkDir(topAbs, topDir, topFolder.id);
      }

      // Check existing DB files not seen on disk
      const activeDbFiles = this.db.listFiles({ includeDeleted: false });
      const missingByHash = new Map<string, FileRecord[]>();
      const missingRecords: FileRecord[] = [];
      for (const dbFile of activeDbFiles) {
        if (!seenDiskRelPaths.has(dbFile.relativePath)) {
          missingRecords.push(dbFile);
          if (dbFile.sha256) {
            const arr = missingByHash.get(dbFile.sha256) || [];
            arr.push(dbFile);
            missingByHash.set(dbFile.sha256, arr);
          }
        }
      }

      // Reconcile newly discovered files against missing files (moved/renamed detection by SHA-256)
      const matchedMissingIds = new Set<string>();
      for (const disc of newlyDiscovered) {
        const sha256 = await computeSha256(disc.absPath);
        this.state.hashedFiles += 1;

        const candidates = (missingByHash.get(sha256) || []).filter(
          (m) => !matchedMissingIds.has(m.id) && m.size === disc.size
        );
        if (candidates.length > 0) {
          const moved = candidates[0];
          matchedMissingIds.add(moved.id);
          const { category, extension, mimeType } = classifyFile(path.basename(disc.relPath));
          let thumb = moved.thumbnailPath;
          if (!thumb && category === 'photo') {
            thumb = await this.storage.generateThumbnail(moved.id, disc.absPath, category);
            if (thumb) this.state.thumbnailsGenerated += 1;
          }
          this.db.updateFileFields(moved.id, {
            name: path.basename(disc.relPath),
            relativePath: disc.relPath,
            folderId: disc.folderId,
            modifiedAt: disc.mtime.toISOString(),
            sha256,
            thumbnailPath: thumb,
            transferStatus: 'complete',
          });
          // Also keep mime/category aligned if extension changed
          void extension;
          void mimeType;
          this.state.movedFiles += 1;
        } else {
          const id = crypto.randomUUID();
          const { category, extension, mimeType } = classifyFile(path.basename(disc.relPath));
          const thumb = await this.storage.generateThumbnail(id, disc.absPath, category);
          if (thumb) this.state.thumbnailsGenerated += 1;
          const now = new Date().toISOString();
          this.db.upsertFile({
            id,
            name: path.basename(disc.relPath),
            relativePath: disc.relPath,
            folderId: disc.folderId,
            size: disc.size,
            mimeType,
            category,
            extension,
            createdAt: disc.ctime.toISOString(),
            modifiedAt: disc.mtime.toISOString(),
            importedAt: now,
            sha256,
            thumbnailPath: thumb,
            isFavorite: false,
            tags: [],
            backupStatus: 'local_only',
            deviceOrigin: 'windows-pc',
            transferStatus: 'complete',
            isDeleted: false,
            deletedAt: null,
            originalRelativePath: null,
            originalFolderId: null,
          });
          this.state.newFiles += 1;
        }
      }

      // Mark truly missing files without silently deleting DB metadata
      for (const m of missingRecords) {
        if (!matchedMissingIds.has(m.id)) {
          this.db.updateFileFields(m.id, { transferStatus: 'missing' });
          this.state.missingFiles += 1;
        }
      }

      const analytics = this.db.getAnalyticsSummary();
      this.state.duplicatesFound = analytics.duplicates.length;

      const vol = getVolumeStats(root);
      if (vol.available) {
        this.db.recordStorageSnapshot(analytics.totalManagedBytes, vol.totalBytes, analytics.totalFiles);
      }

      this.state.lastRunAt = new Date().toISOString();
      this.db.log(
        this.state.errors.length > 0 ? 'warn' : 'info',
        'scanner',
        `Scan finished: ${this.state.scannedCount} files scanned, ${this.state.newFiles} new, ${this.state.movedFiles} moved, ${this.state.missingFiles} missing`,
        this.getState() as unknown as Record<string, unknown>
      );
    } finally {
      this.state.isRunning = false;
    }

    return this.getState();
  }
}
