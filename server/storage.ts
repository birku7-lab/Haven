import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { promisify } from 'util';
import type { HavenDatabase } from './db.ts';
import type { DriveInfo, FileCategory, FileRecord, FolderRecord } from './types.ts';

const execFileAsync = promisify(execFile);

export const HAVEN_SUBDIRS = [
  'Files',
  'Photos',
  'Videos',
  'Documents',
  'Audio',
  'Archives',
  'Other',
  'Thumbnails',
  'Database',
  'Backups',
  'Temp',
  'RecycleBin',
] as const;

export const USER_MANAGED_ROOT_DIRS = [
  'Files',
  'Photos',
  'Videos',
  'Documents',
  'Audio',
  'Archives',
  'Other',
] as const;

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.tiff', '.tif', '.avif', '.svg']);
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.wmv', '.m4v', '.flv', '.3gp']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.opus']);
const DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf', '.odt', '.ods', '.odp']);
const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso']);
const EXEC_EXTS = new Set(['.exe', '.msi', '.bat', '.cmd', '.ps1', '.appimage', '.deb', '.apk', '.dmg']);
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.rs', '.py', '.java', '.kt', '.cpp', '.c', '.h', '.cs', '.go', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.sql', '.sh', '.toml']);

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function classifyFile(filename: string): {
  category: FileCategory;
  extension: string;
  mimeType: string;
} {
  const ext = path.extname(filename).toLowerCase();
  let category: FileCategory = 'other';
  if (PHOTO_EXTS.has(ext)) category = 'photo';
  else if (VIDEO_EXTS.has(ext)) category = 'video';
  else if (AUDIO_EXTS.has(ext)) category = 'audio';
  else if (DOC_EXTS.has(ext)) category = 'document';
  else if (ARCHIVE_EXTS.has(ext)) category = 'archive';
  else if (EXEC_EXTS.has(ext)) category = 'executable';
  else if (CODE_EXTS.has(ext)) category = 'code';

  return {
    category,
    extension: ext,
    mimeType: MIME_MAP[ext] || 'application/octet-stream',
  };
}

export function defaultRootSubdirForCategory(category: FileCategory): string {
  switch (category) {
    case 'photo':
      return 'Photos';
    case 'video':
      return 'Videos';
    case 'audio':
      return 'Audio';
    case 'document':
      return 'Documents';
    case 'archive':
      return 'Archives';
    default:
      return 'Files';
  }
}

export function sanitizeFileName(name: string): string {
  const cleaned = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('Invalid file or folder name');
  }
  return cleaned;
}

export function assertInsideRoot(rootDir: string, targetPath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error('Access denied: path escapes configured storage root');
  }
  return resolvedTarget;
}

export function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export async function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function checkPathWritable(dirPath: string): { writable: boolean; exists: boolean; error?: string } {
  try {
    const resolved = path.resolve(dirPath);
    const existed = fs.existsSync(resolved);
    if (!existed) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    const probe = path.join(resolved, `.haven-write-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    if (!existed) {
      // Leave created dir or keep? Keep only if explicitly initialized; probe cleans up itself
    }
    return { writable: true, exists: existed };
  } catch (err) {
    return {
      writable: false,
      exists: fs.existsSync(dirPath),
      error: err instanceof Error ? err.message : 'Path is not writable',
    };
  }
}

export function getVolumeStats(targetPath: string): {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  available: boolean;
  error?: string;
} {
  try {
    let probePath = path.resolve(targetPath);
    while (!fs.existsSync(probePath)) {
      const parent = path.dirname(probePath);
      if (parent === probePath) break;
      probePath = parent;
    }
    const stat = fs.statfsSync(probePath);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return { totalBytes, freeBytes, usedBytes, available: true };
  } catch (err) {
    return {
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      available: false,
      error: err instanceof Error ? err.message : 'Unable to read drive statistics',
    };
  }
}

export async function detectAvailableDrives(): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = [];

  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const mountPath = `${letter}:\\`;
      if (fs.existsSync(mountPath)) {
        const stats = getVolumeStats(mountPath);
        const w = checkPathWritable(path.join(mountPath, '.haven-probe-check'));
        try {
          if (fs.existsSync(path.join(mountPath, '.haven-probe-check'))) {
            fs.rmdirSync(path.join(mountPath, '.haven-probe-check'));
          }
        } catch {
          // ignore
        }
        if (stats.available && stats.totalBytes > 0) {
          drives.push({
            id: letter,
            name: letter === 'C' ? `Local Disk (${letter}:)` : `Drive (${letter}:)`,
            mountPath,
            fileSystem: 'NTFS',
            totalBytes: stats.totalBytes,
            freeBytes: stats.freeBytes,
            usedBytes: stats.usedBytes,
            isWritable: w.writable,
            isSystem: letter === 'C',
          });
        }
      }
    }
    return drives;
  }

  // Linux / POSIX real mount detection
  const seenMounts = new Set<string>();
  const candidates: Array<{ mount: string; fsType: string; name: string }> = [];

  if (fs.existsSync('/proc/mounts')) {
    const lines = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
    const skipTypes = new Set([
      'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2',
      'pstore', 'securityfs', 'debugfs', 'tracefs', 'configfs', 'fusectl',
      'mqueue', 'hugetlbfs', 'autofs', 'rpc_pipefs', 'squashfs', 'overlay',
    ]);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const [device, mount, fsType] = parts;
      if (skipTypes.has(fsType) && mount !== '/') continue;
      if (mount.startsWith('/proc') || mount.startsWith('/sys') || mount.startsWith('/dev')) continue;
      if (!seenMounts.has(mount)) {
        seenMounts.add(mount);
        candidates.push({
          mount,
          fsType,
          name: mount === '/' ? `Primary Volume (${device})` : `${path.basename(mount)} (${device})`,
        });
      }
    }
  }

  if (!seenMounts.has('/')) {
    candidates.unshift({ mount: '/', fsType: 'ext4', name: 'Primary Volume (/)' });
  }

  // Also include user workspace/home storage location option if different mount or convenient root
  for (const c of candidates) {
    const stats = getVolumeStats(c.mount);
    if (!stats.available || stats.totalBytes <= 0) continue;
    const probeTarget = c.mount === '/' ? path.join(process.cwd(), '.haven-storage-probe') : path.join(c.mount, '.haven-storage-probe');
    let isWritable = false;
    try {
      fs.mkdirSync(probeTarget, { recursive: true });
      fs.rmdirSync(probeTarget);
      isWritable = true;
    } catch {
      isWritable = false;
    }
    drives.push({
      id: c.mount,
      name: c.name,
      mountPath: c.mount === '/' ? path.join(process.cwd(), 'HavenStorage') : path.join(c.mount, 'HavenStorage'),
      fileSystem: c.fsType,
      totalBytes: stats.totalBytes,
      freeBytes: stats.freeBytes,
      usedBytes: stats.usedBytes,
      isWritable,
      isSystem: c.mount === '/',
    });
  }

  return drives;
}

export class StorageEngine {
  private db: HavenDatabase;

  constructor(db: HavenDatabase) {
    this.db = db;
  }

  getRoot(): string {
    const settings = this.db.getSettings();
    if (!settings.storageRoot) {
      throw new Error('Storage location is not configured yet.');
    }
    return path.resolve(settings.storageRoot);
  }

  initializeStorage(chosenPath: string): {
    storageRoot: string;
    subdirsCreated: string[];
    dbPath: string;
  } {
    const storageRoot = path.resolve(chosenPath);
    const writeCheck = checkPathWritable(storageRoot);
    if (!writeCheck.writable) {
      throw new Error(`Storage path is not writable: ${writeCheck.error || storageRoot}`);
    }

    const subdirsCreated: string[] = [];
    for (const sub of HAVEN_SUBDIRS) {
      const full = path.join(storageRoot, sub);
      if (!fs.existsSync(full)) {
        fs.mkdirSync(full, { recursive: true });
        subdirsCreated.push(sub);
      }
    }

    const dbPath = path.join(storageRoot, 'Database', 'haven.db');
    this.db.open(dbPath);
    this.db.updateSettings({
      storageRoot,
      setupCompleted: true,
    });

    // Ensure root managed folders exist in DB
    const now = new Date().toISOString();
    for (const dirName of USER_MANAGED_ROOT_DIRS) {
      if (!this.db.getFolderByPath(dirName)) {
        this.db.upsertFolder({
          id: crypto.randomUUID(),
          name: dirName,
          relativePath: dirName,
          parentId: null,
          createdAt: now,
          modifiedAt: now,
          isFavorite: false,
          deviceOrigin: 'windows-pc',
        });
      }
    }

    this.db.log('info', 'storage', `Storage initialized at ${storageRoot}`, {
      storageRoot,
      subdirsCreated,
    });

    return { storageRoot, subdirsCreated, dbPath };
  }

  async relocateStorage(
    newPath: string,
    mode: 'copy_and_switch' | 'switch_existing'
  ): Promise<{ newRoot: string; filesCopied: number }> {
    const oldRoot = this.getRoot();
    const targetRoot = path.resolve(newPath);
    if (oldRoot === targetRoot) {
      throw new Error('New storage location is the same as the current location');
    }
    if (targetRoot.startsWith(oldRoot + path.sep)) {
      throw new Error('Cannot relocate storage inside the existing storage folder');
    }

    const writable = checkPathWritable(targetRoot);
    if (!writable.writable) {
      throw new Error(`Target location is not writable: ${writable.error}`);
    }

    let filesCopied = 0;
    if (mode === 'copy_and_switch') {
      const stats = getVolumeStats(targetRoot);
      const analytics = this.db.getAnalyticsSummary();
      if (stats.available && stats.freeBytes < analytics.totalManagedBytes + 64 * 1024 * 1024) {
        throw new Error('Insufficient free disk space on destination drive for safe relocation');
      }

      for (const sub of HAVEN_SUBDIRS) {
        fs.mkdirSync(path.join(targetRoot, sub), { recursive: true });
      }

      // Copy all active & recycle bin files with verification without deleting old files
      const activeFiles = this.db.listFiles({ includeDeleted: true });
      for (const file of activeFiles) {
        const src = assertInsideRoot(oldRoot, file.relativePath);
        if (!fs.existsSync(src)) continue;
        const dst = assertInsideRoot(targetRoot, file.relativePath);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        if (file.sha256) {
          const copiedHash = await computeSha256(dst);
          if (copiedHash !== file.sha256) {
            throw new Error(`Integrity mismatch while copying ${file.name} during relocation`);
          }
        }
        filesCopied += 1;
      }

      // Copy thumbnails
      const oldThumbs = path.join(oldRoot, 'Thumbnails');
      const newThumbs = path.join(targetRoot, 'Thumbnails');
      if (fs.existsSync(oldThumbs)) {
        for (const entry of fs.readdirSync(oldThumbs)) {
          fs.copyFileSync(path.join(oldThumbs, entry), path.join(newThumbs, entry));
        }
      }

      // Create online backup into new Database/haven.db
      const newDbPath = path.join(targetRoot, 'Database', 'haven.db');
      await this.db.backupDatabase(targetRoot);
      // Also write direct DB snapshot to newDbPath
      const backupsDir = path.join(targetRoot, 'Backups');
      const latestBackup = fs
        .readdirSync(backupsDir)
        .filter((f) => f.endsWith('.sqlite'))
        .sort()
        .pop();
      if (latestBackup) {
        fs.copyFileSync(path.join(backupsDir, latestBackup), newDbPath);
      }
      this.db.open(newDbPath);
      this.db.updateSettings({ storageRoot: targetRoot, setupCompleted: true });
    } else {
      for (const sub of HAVEN_SUBDIRS) {
        fs.mkdirSync(path.join(targetRoot, sub), { recursive: true });
      }
      const newDbPath = path.join(targetRoot, 'Database', 'haven.db');
      if (fs.existsSync(newDbPath)) {
        this.db.open(newDbPath);
      } else {
        this.db.open(newDbPath);
      }
      this.db.updateSettings({ storageRoot: targetRoot, setupCompleted: true });
    }

    this.db.log(
      'info',
      'storage',
      `Storage location safely switched to ${targetRoot} (${filesCopied} files verified). Original files preserved.`,
      { oldRoot, newRoot: targetRoot, mode, filesCopied }
    );

    return { newRoot: targetRoot, filesCopied };
  }

  ensureUniqueRelativePath(desiredRelPath: string): string {
    const root = this.getRoot();
    const norm = normalizeRelPath(desiredRelPath);
    const parsed = path.posix.parse(norm);
    let candidate = norm;
    let counter = 1;
    while (fs.existsSync(assertInsideRoot(root, candidate)) || this.db.getFileByPath(candidate)) {
      candidate = parsed.dir
        ? `${parsed.dir}/${parsed.name} (${counter})${parsed.ext}`
        : `${parsed.name} (${counter})${parsed.ext}`;
      counter += 1;
    }
    return candidate;
  }

  createFolder(name: string, parentId: string | null, deviceOrigin = 'windows-pc'): FolderRecord {
    const root = this.getRoot();
    const cleanName = sanitizeFileName(name);
    let relPath = cleanName;
    if (parentId) {
      const parent = this.db.getFolderById(parentId);
      if (!parent) throw new Error('Parent folder not found');
      relPath = `${parent.relativePath}/${cleanName}`;
    } else {
      relPath = `Files/${cleanName}`;
      const filesRoot = this.db.getFolderByPath('Files');
      parentId = filesRoot ? filesRoot.id : null;
    }

    const fullPath = assertInsideRoot(root, relPath);
    if (fs.existsSync(fullPath) || this.db.getFolderByPath(relPath)) {
      throw new Error(`Folder "${cleanName}" already exists here`);
    }
    fs.mkdirSync(fullPath, { recursive: true });
    const now = new Date().toISOString();
    const folder: FolderRecord = {
      id: crypto.randomUUID(),
      name: cleanName,
      relativePath: relPath,
      parentId,
      createdAt: now,
      modifiedAt: now,
      isFavorite: false,
      deviceOrigin,
    };
    this.db.upsertFolder(folder);
    this.db.log('info', 'storage', `Created folder ${relPath}`);
    return folder;
  }

  renameFolder(folderId: string, newName: string): FolderRecord {
    const root = this.getRoot();
    const folder = this.db.getFolderById(folderId);
    if (!folder) throw new Error('Folder not found');
    if ((USER_MANAGED_ROOT_DIRS as readonly string[]).includes(folder.relativePath)) {
      throw new Error('Top-level storage category folders cannot be renamed');
    }
    const cleanName = sanitizeFileName(newName);
    const parentDir = path.posix.dirname(folder.relativePath);
    const newRelPath = parentDir === '.' ? cleanName : `${parentDir}/${cleanName}`;
    const oldAbs = assertInsideRoot(root, folder.relativePath);
    const newAbs = assertInsideRoot(root, newRelPath);
    if (fs.existsSync(newAbs)) {
      throw new Error(`A folder named "${cleanName}" already exists`);
    }
    if (fs.existsSync(oldAbs)) {
      fs.renameSync(oldAbs, newAbs);
    } else {
      fs.mkdirSync(newAbs, { recursive: true });
    }
    this.db.renameFolder(folderId, cleanName, newRelPath);
    this.db.log('info', 'storage', `Renamed folder to ${newRelPath}`);
    return this.db.getFolderById(folderId)!;
  }

  deleteEmptyOrRecursiveFolder(folderId: string): { filesMovedToBin: number } {
    const root = this.getRoot();
    const folder = this.db.getFolderById(folderId);
    if (!folder) throw new Error('Folder not found');
    if ((USER_MANAGED_ROOT_DIRS as readonly string[]).includes(folder.relativePath)) {
      throw new Error('Top-level storage category folders cannot be deleted');
    }

    // Soft-delete all files inside this folder tree first so user data is never lost
    const allFiles = this.db.listFiles({ includeDeleted: false });
    const nestedFiles = allFiles.filter(
      (f) => f.relativePath === folder.relativePath || f.relativePath.startsWith(`${folder.relativePath}/`)
    );
    for (const f of nestedFiles) {
      this.softDeleteFile(f.id);
    }

    const abs = assertInsideRoot(root, folder.relativePath);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
    }
    this.db.deleteFolderRecord(folderId);
    this.db.log('info', 'storage', `Deleted folder ${folder.relativePath} (${nestedFiles.length} files moved to Recycle Bin)`);
    return { filesMovedToBin: nestedFiles.length };
  }

  async generateThumbnail(fileId: string, absFilePath: string, category: FileCategory): Promise<string | null> {
    if (category !== 'photo') return null;
    const ext = path.extname(absFilePath).toLowerCase();
    if (ext === '.svg') return null;
    try {
      const root = this.getRoot();
      const thumbDir = path.join(root, 'Thumbnails');
      fs.mkdirSync(thumbDir, { recursive: true });
      const thumbName = `${fileId}.webp`;
      const thumbAbs = path.join(thumbDir, thumbName);
      await sharp(absFilePath)
        .rotate()
        .resize(380, 380, { fit: 'cover', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(thumbAbs);
      return `Thumbnails/${thumbName}`;
    } catch {
      return null;
    }
  }

  async finalizeStagedFile(params: {
    stagedTempPath: string;
    fileName: string;
    folderId: string | null;
    deviceOrigin?: string;
    sha256?: string | null;
    fileId?: string;
  }): Promise<FileRecord> {
    const root = this.getRoot();
    const cleanName = sanitizeFileName(params.fileName);
    const { category, extension, mimeType } = classifyFile(cleanName);

    let targetFolderId = params.folderId;
    let folderRelDir: string;
    if (targetFolderId) {
      const fld = this.db.getFolderById(targetFolderId);
      if (!fld) throw new Error('Target folder not found');
      folderRelDir = fld.relativePath;
    } else {
      folderRelDir = defaultRootSubdirForCategory(category);
      const fld = this.db.getFolderByPath(folderRelDir);
      targetFolderId = fld ? fld.id : null;
    }

    const relPath = this.ensureUniqueRelativePath(`${folderRelDir}/${cleanName}`);
    const finalAbs = assertInsideRoot(root, relPath);
    fs.mkdirSync(path.dirname(finalAbs), { recursive: true });

    // Atomic move or copy+unlink if across devices
    try {
      fs.renameSync(params.stagedTempPath, finalAbs);
    } catch {
      fs.copyFileSync(params.stagedTempPath, finalAbs);
      fs.unlinkSync(params.stagedTempPath);
    }

    const stat = fs.statSync(finalAbs);
    const fileId = params.fileId || crypto.randomUUID();
    const hash = params.sha256 || (await computeSha256(finalAbs));
    const thumb = await this.generateThumbnail(fileId, finalAbs, category);
    const now = new Date().toISOString();

    const record: FileRecord = {
      id: fileId,
      name: path.basename(relPath),
      relativePath: relPath,
      folderId: targetFolderId,
      size: stat.size,
      mimeType,
      category,
      extension,
      createdAt: stat.birthtime ? stat.birthtime.toISOString() : now,
      modifiedAt: stat.mtime ? stat.mtime.toISOString() : now,
      importedAt: now,
      sha256: hash,
      thumbnailPath: thumb,
      isFavorite: false,
      tags: [],
      backupStatus: params.deviceOrigin && params.deviceOrigin !== 'windows-pc' ? 'verified' : 'local_only',
      deviceOrigin: params.deviceOrigin || 'windows-pc',
      transferStatus: 'complete',
      isDeleted: false,
      deletedAt: null,
      originalRelativePath: null,
      originalFolderId: null,
    };
    this.db.upsertFile(record);
    this.db.log('info', 'storage', `Stored file ${record.relativePath}`, {
      fileId: record.id,
      size: record.size,
      sha256: record.sha256,
    });
    return record;
  }

  renameFile(fileId: string, newName: string): FileRecord {
    const root = this.getRoot();
    const file = this.db.getFileById(fileId);
    if (!file || file.isDeleted) throw new Error('File not found');
    const cleanName = sanitizeFileName(newName);
    const dir = path.posix.dirname(file.relativePath);
    const newRel = dir === '.' ? cleanName : `${dir}/${cleanName}`;
    const oldAbs = assertInsideRoot(root, file.relativePath);
    const newAbs = assertInsideRoot(root, newRel);
    if (fs.existsSync(newAbs)) {
      throw new Error(`A file named "${cleanName}" already exists in this folder`);
    }
    if (!fs.existsSync(oldAbs)) {
      throw new Error('Source file is missing from disk');
    }
    fs.renameSync(oldAbs, newAbs);
    const now = new Date().toISOString();
    this.db.updateFileFields(fileId, {
      name: cleanName,
      relativePath: newRel,
      modifiedAt: now,
    });
    this.db.log('info', 'storage', `Renamed ${file.name} to ${cleanName}`);
    return this.db.getFileById(fileId)!;
  }

  moveFile(fileId: string, targetFolderId: string): FileRecord {
    const root = this.getRoot();
    const file = this.db.getFileById(fileId);
    if (!file || file.isDeleted) throw new Error('File not found');
    const targetFolder = this.db.getFolderById(targetFolderId);
    if (!targetFolder) throw new Error('Destination folder not found');

    const newRel = this.ensureUniqueRelativePath(`${targetFolder.relativePath}/${file.name}`);
    const oldAbs = assertInsideRoot(root, file.relativePath);
    const newAbs = assertInsideRoot(root, newRel);
    if (!fs.existsSync(oldAbs)) {
      throw new Error('Source file is missing from disk');
    }
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    fs.renameSync(oldAbs, newAbs);
    this.db.updateFileFields(fileId, {
      name: path.basename(newRel),
      relativePath: newRel,
      folderId: targetFolderId,
      modifiedAt: new Date().toISOString(),
    });
    this.db.log('info', 'storage', `Moved ${file.name} to ${targetFolder.relativePath}`);
    return this.db.getFileById(fileId)!;
  }

  async copyFile(fileId: string, targetFolderId: string | null): Promise<FileRecord> {
    const root = this.getRoot();
    const file = this.db.getFileById(fileId);
    if (!file || file.isDeleted) throw new Error('File not found');
    const folderId = targetFolderId || file.folderId;
    const folder = folderId ? this.db.getFolderById(folderId) : null;
    const targetDir = folder ? folder.relativePath : path.posix.dirname(file.relativePath);
    const parsed = path.posix.parse(file.name);
    const desiredName = `${parsed.name} - Copy${parsed.ext}`;
    const newRel = this.ensureUniqueRelativePath(`${targetDir}/${desiredName}`);
    const srcAbs = assertInsideRoot(root, file.relativePath);
    const dstAbs = assertInsideRoot(root, newRel);
    if (!fs.existsSync(srcAbs)) throw new Error('Source file missing from disk');

    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.copyFileSync(srcAbs, dstAbs);
    const newId = crypto.randomUUID();
    const thumb = await this.generateThumbnail(newId, dstAbs, file.category);
    const now = new Date().toISOString();

    const copyRecord: FileRecord = {
      ...file,
      id: newId,
      name: path.basename(newRel),
      relativePath: newRel,
      folderId: folder ? folder.id : file.folderId,
      importedAt: now,
      modifiedAt: now,
      thumbnailPath: thumb,
    };
    this.db.upsertFile(copyRecord);
    this.db.log('info', 'storage', `Copied ${file.name} to ${newRel}`);
    return copyRecord;
  }

  softDeleteFile(fileId: string): FileRecord {
    const root = this.getRoot();
    const file = this.db.getFileById(fileId);
    if (!file) throw new Error('File not found');
    if (file.isDeleted) return file;

    const binRel = `RecycleBin/${file.id}__${file.name}`;
    const srcAbs = assertInsideRoot(root, file.relativePath);
    const binAbs = assertInsideRoot(root, binRel);
    fs.mkdirSync(path.dirname(binAbs), { recursive: true });
    if (fs.existsSync(srcAbs)) {
      fs.renameSync(srcAbs, binAbs);
    }

    const now = new Date().toISOString();
    this.db.updateFileFields(fileId, {
      isDeleted: true,
      deletedAt: now,
      originalRelativePath: file.relativePath,
      originalFolderId: file.folderId,
      relativePath: binRel,
    });
    this.db.log('info', 'storage', `Moved ${file.name} to Recycle Bin`);
    return this.db.getFileById(fileId)!;
  }

  restoreFile(fileId: string): FileRecord {
    const root = this.getRoot();
    const file = this.db.getFileById(fileId);
    if (!file || !file.isDeleted) throw new Error('Deleted file not found in Recycle Bin');

    const desiredRel = file.originalRelativePath || `Files/${file.name}`;
    // Ensure parent folder exists on disk
    const finalRel = this.ensureUniqueRelativePath(desiredRel);
    const binAbs = assertInsideRoot(root, file.relativePath);
    const restoreAbs = assertInsideRoot(root, finalRel);
    fs.mkdirSync(path.dirname(restoreAbs), { recursive: true });

    if (fs.existsSync(binAbs)) {
      fs.renameSync(binAbs, restoreAbs);
    } else {
      throw new Error('Recycle Bin file payload is missing from disk');
    }

    // Re-resolve folderId if original folder no longer exists
    let folderId = file.originalFolderId;
    if (folderId && !this.db.getFolderById(folderId)) {
      const parentRel = path.posix.dirname(finalRel);
      const existingFolder = this.db.getFolderByPath(parentRel);
      folderId = existingFolder ? existingFolder.id : null;
    }

    this.db.updateFileFields(fileId, {
      isDeleted: false,
      deletedAt: null,
      name: path.basename(finalRel),
      relativePath: finalRel,
      folderId,
      originalRelativePath: null,
      originalFolderId: null,
    });
    this.db.log('info', 'storage', `Restored ${path.basename(finalRel)} from Recycle Bin`);
    return this.db.getFileById(fileId)!;
  }

  permanentlyDeleteFile(fileId: string): void {
    const root = this.getRoot();
    const file = this.db.getFileById(fileId);
    if (!file) throw new Error('File not found');
    const abs = assertInsideRoot(root, file.relativePath);
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
    }
    if (file.thumbnailPath) {
      const thumbAbs = assertInsideRoot(root, file.thumbnailPath);
      if (fs.existsSync(thumbAbs)) {
        fs.unlinkSync(thumbAbs);
      }
    }
    this.db.deleteFilePermanently(fileId);
    this.db.log('info', 'storage', `Permanently deleted ${file.name}`);
  }

  emptyRecycleBin(): number {
    const deleted = this.db.listFiles({ onlyDeleted: true });
    for (const f of deleted) {
      this.permanentlyDeleteFile(f.id);
    }
    return deleted.length;
  }

  async openInDefaultApp(fileId: string): Promise<{ opened: boolean; path: string; message?: string }> {
    const root = this.getRoot();
    const file = this.db.getFileById(fileId);
    if (!file) throw new Error('File not found');
    const abs = assertInsideRoot(root, file.relativePath);
    if (!fs.existsSync(abs)) throw new Error('File missing on disk');

    if (process.platform === 'win32') {
      await execFileAsync('cmd', ['/c', 'start', '', abs]);
      return { opened: true, path: abs };
    }
    if (process.platform === 'darwin') {
      await execFileAsync('open', [abs]);
      return { opened: true, path: abs };
    }
    // Headless Linux preview environment typically lacks a desktop session
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
      await execFileAsync('xdg-open', [abs]);
      return { opened: true, path: abs };
    }
    return {
      opened: false,
      path: abs,
      message: 'OS shell launcher requires an active desktop session; file path copied/returned instead.',
    };
  }
}
