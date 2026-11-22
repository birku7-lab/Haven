import type {
  ActivityLogRecord,
  AppSettings,
  DevicePermissions,
  DeviceRecord,
  DriveInfo,
  FileCategory,
  FileRecord,
  FolderRecord,
  ScannerState,
  StorageServerStatus,
  SyncRuleRecord,
  TransferRecord,
} from '../types';

let authToken: string | null = null;
let apiBase = '/api/v1';
let desktopInitPromise: Promise<void> | null = null;

export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function initDesktopApi(): Promise<void> {
  if (!isDesktopApp()) return;
  if (!desktopInitPromise) {
    desktopInitPromise = (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const url = await invoke<string>('get_local_api_url');
        if (url) {
          apiBase = url.replace(/\/+$/, '');
        }
      } catch {
        // Fallback to relative /api/v1 if not inside Tauri runtime
      }
    })();
  }
  await desktopInitPromise;
}

export async function pickDesktopFolder(): Promise<string | null> {
  if (!isDesktopApp()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('pick_storage_folder');
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

export function setApiBase(base: string) {
  apiBase = base;
}

export function buildContentUrl(fileId: string, download = false): string {
  const tokenParam = authToken ? `token=${encodeURIComponent(authToken)}` : '';
  const dlParam = download ? 'download=1' : '';
  const query = [dlParam, tokenParam].filter(Boolean).join('&');
  return `${apiBase}/files/${encodeURIComponent(fileId)}/content${query ? `?${query}` : ''}`;
}

export function buildThumbnailUrl(fileId: string): string {
  const tokenParam = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
  return `${apiBase}/files/${encodeURIComponent(fileId)}/thumbnail${tokenParam}`;
}

export function buildLogsExportUrl(): string {
  const tokenParam = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
  return `${apiBase}/logs/export${tokenParam}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`);
  }
  if (init.body && !(init.body instanceof ArrayBuffer) && !(init.body instanceof Uint8Array) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${apiBase}${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody?.error) msg = String(errBody.error);
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  getAuthStatus: () =>
    request<{ passcodeConfigured: boolean; managedByEnv: boolean; setupCompleted: boolean }>('/auth/status'),
  setupPasscode: (passcode: string) =>
    request<{ token: string; sessionId: string }>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    }),
  login: (passcode: string) =>
    request<{ token: string; sessionId: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  getSessions: () =>
    request<{ sessions: Array<{ id: string; createdAt: string; lastActiveAt: string; userAgent: string }> }>('/auth/sessions'),
  revokeSession: (id: string) => request<{ ok: boolean }>(`/auth/sessions/${id}`, { method: 'DELETE' }),

  getDrives: () =>
    request<{ drives: DriveInfo[]; platform: string; defaultPath: string }>('/setup/drives'),
  validatePath: (path: string) =>
    request<{
      path: string;
      writable: boolean;
      exists: boolean;
      error: string | null;
      volume: { totalBytes: number; freeBytes: number; usedBytes: number; available: boolean };
    }>('/setup/validate', { method: 'POST', body: JSON.stringify({ path }) }),
  initializeStorage: (path: string) =>
    request<{ storageRoot: string; subdirsCreated: string[]; dbPath: string; settings: AppSettings }>(
      '/setup/initialize',
      { method: 'POST', body: JSON.stringify({ path }) }
    ),
  relocateStorage: (path: string, mode: 'copy_and_switch' | 'switch_existing') =>
    request<{ newRoot: string; filesCopied: number }>('/storage/relocate', {
      method: 'POST',
      body: JSON.stringify({ path, mode }),
    }),

  getDashboard: () =>
    request<{
      setupCompleted: boolean;
      settings: AppSettings;
      volume?: { totalBytes: number; freeBytes: number; usedBytes: number; available: boolean; usedPct: number };
      counts?: { files: number; folders: number; managedBytes: number; connectedDevices: number; pairedDevices: number };
      server: StorageServerStatus;
      scanner?: ScannerState;
      activeTransfers?: TransferRecord[];
      recentFiles?: FileRecord[];
      recentActivity?: ActivityLogRecord[];
      backupStatus?: { lastBackupAt: string | null; integrityOk: boolean };
      warnings?: Array<{ code: string; level: 'warn' | 'error'; message: string }>;
    }>('/dashboard'),

  listFiles: (params: {
    folderId?: string | null;
    search?: string;
    category?: FileCategory | 'all';
    favorites?: boolean;
    recent?: boolean;
    sortBy?: 'name' | 'size' | 'modifiedAt' | 'importedAt';
    sortDir?: 'asc' | 'desc';
  }) => {
    const qs = new URLSearchParams();
    if (params.folderId) qs.set('folderId', params.folderId);
    if (params.search) qs.set('search', params.search);
    if (params.category && params.category !== 'all') qs.set('category', params.category);
    if (params.favorites) qs.set('favorites', '1');
    if (params.recent) qs.set('recent', '1');
    if (params.sortBy) qs.set('sortBy', params.sortBy);
    if (params.sortDir) qs.set('sortDir', params.sortDir);
    return request<{
      folders: FolderRecord[];
      files: FileRecord[];
      breadcrumbs: Array<{ id: string | null; name: string }>;
      allFolders: FolderRecord[];
    }>(`/files?${qs.toString()}`);
  },
  createFolder: (name: string, parentId: string | null) =>
    request<FolderRecord>('/folders', { method: 'POST', body: JSON.stringify({ name, parentId }) }),
  renameFolder: (id: string, name: string) =>
    request<FolderRecord>(`/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteFolder: (id: string) =>
    request<{ filesMovedToBin: number }>(`/folders/${id}`, { method: 'DELETE' }),
  getFileDetails: (id: string) => request<{ file: FileRecord; absolutePath: string }>(`/files/${id}`),
  updateFile: (id: string, patch: { name?: string; isFavorite?: boolean; tags?: string[] }) =>
    request<FileRecord>(`/files/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  moveFile: (id: string, targetFolderId: string) =>
    request<FileRecord>(`/files/${id}/move`, { method: 'POST', body: JSON.stringify({ targetFolderId }) }),
  copyFile: (id: string, targetFolderId: string | null) =>
    request<FileRecord>(`/files/${id}/copy`, { method: 'POST', body: JSON.stringify({ targetFolderId }) }),
  deleteFile: (id: string) => request<FileRecord>(`/files/${id}`, { method: 'DELETE' }),
  batchDeleteFiles: (ids: string[]) =>
    request<{ movedToRecycleBin: number }>('/files/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  openFileInOs: (id: string) =>
    request<{ opened: boolean; path: string; message?: string }>(`/files/${id}/open`, {
      method: 'POST',
    }),

  getMedia: (params: {
    type?: 'all' | 'photo' | 'video';
    sortBy?: 'modifiedAt' | 'size';
    sortDir?: 'asc' | 'desc';
    search?: string;
    favorites?: boolean;
    folderId?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params.type) qs.set('type', params.type);
    if (params.sortBy) qs.set('sortBy', params.sortBy);
    if (params.sortDir) qs.set('sortDir', params.sortDir);
    if (params.search) qs.set('search', params.search);
    if (params.favorites) qs.set('favorites', '1');
    if (params.folderId) qs.set('folderId', params.folderId);
    return request<{
      items: FileRecord[];
      albums: Array<{ folderId: string | null; name: string; count: number; coverId: string }>;
      counts: { photos: number; videos: number };
    }>(`/media?${qs.toString()}`);
  },

  listTransfers: () => request<{ transfers: TransferRecord[] }>('/transfers'),
  initUpload: (body: { fileName: string; totalBytes: number; folderId?: string | null; chunkSize?: number }) =>
    request<TransferRecord>('/transfers/upload', { method: 'POST', body: JSON.stringify(body) }),
  uploadChunk: (transferId: string, index: number, chunk: ArrayBuffer, sha256Hex?: string) =>
    request<TransferRecord>(`/transfers/${transferId}/chunks/${index}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(sha256Hex ? { 'X-Chunk-Sha256': sha256Hex } : {}),
      },
      body: chunk,
    }),
  completeUpload: (transferId: string) =>
    request<{ transfer: TransferRecord; file: FileRecord }>(`/transfers/${transferId}/complete`, {
      method: 'POST',
    }),
  pauseTransfer: (id: string) => request<TransferRecord>(`/transfers/${id}/pause`, { method: 'POST' }),
  resumeTransfer: (id: string) => request<TransferRecord>(`/transfers/${id}/resume`, { method: 'POST' }),
  retryTransfer: (id: string) => request<TransferRecord>(`/transfers/${id}/retry`, { method: 'POST' }),
  cancelTransfer: (id: string) => request<TransferRecord>(`/transfers/${id}/cancel`, { method: 'POST' }),
  clearTransferHistory: () => request<{ ok: boolean }>('/transfers/history', { method: 'DELETE' }),

  getAnalytics: () =>
    request<{
      volume: { totalBytes: number; freeBytes: number; usedBytes: number; available: boolean };
      totalFiles: number;
      totalFolders: number;
      totalManagedBytes: number;
      byCategory: Array<{ category: FileCategory; count: number; bytes: number }>;
      largestFiles: FileRecord[];
      largestFolders: Array<{ id: string; name: string; relativePath: string; bytes: number; fileCount: number }>;
      duplicates: Array<{ sha256: string; size: number; files: FileRecord[] }>;
      emptyFolders: FolderRecord[];
      recentlyAdded: FileRecord[];
      history: Array<{ usedBytes: number; totalBytes: number; fileCount: number; recordedAt: string }>;
    }>('/analytics'),

  getScannerStatus: () => request<ScannerState>('/scanner/status'),
  startScan: () => request<ScannerState>('/scanner/start', { method: 'POST' }),

  getRecycleBin: () => request<{ items: FileRecord[]; totalBytes: number }>('/recycle-bin'),
  restoreFromBin: (id: string) => request<FileRecord>(`/recycle-bin/${id}/restore`, { method: 'POST' }),
  permanentDeleteFromBin: (id: string) => request<{ ok: boolean }>(`/recycle-bin/${id}`, { method: 'DELETE' }),
  emptyRecycleBin: () => request<{ removed: number }>('/recycle-bin/empty', { method: 'POST' }),

  getServerStatus: () => request<StorageServerStatus>('/server/status'),
  startServer: (port?: number, bindLan?: boolean) =>
    request<StorageServerStatus>('/server/start', { method: 'POST', body: JSON.stringify({ port, bindLan }) }),
  stopServer: () => request<StorageServerStatus>('/server/stop', { method: 'POST' }),
  updateServerConfig: (patch: { port?: number; autoStart?: boolean; bindLan?: boolean }) =>
    request<{ settings: AppSettings; status: StorageServerStatus }>('/server/config', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  getApiDocs: () => request<Record<string, unknown>>('/docs'),

  listDevices: () => request<{ devices: DeviceRecord[] }>('/devices'),
  createPairingQr: () =>
    request<{
      payload: { protocol: string; host: string; hosts: string[]; port: number; serverRunning: boolean; code: string; secret: string; expiresAt: string };
      qrDataUrl: string;
    }>('/devices/pairing-qr', { method: 'POST' }),
  updateDevicePermissions: (id: string, permissions: DevicePermissions) =>
    request<{ ok: boolean }>(`/devices/${id}/permissions`, {
      method: 'PATCH',
      body: JSON.stringify({ permissions }),
    }),
  revokeDevice: (id: string) => request<{ ok: boolean }>(`/devices/${id}/revoke`, { method: 'POST' }),
  deleteDevice: (id: string) => request<{ ok: boolean }>(`/devices/${id}`, { method: 'DELETE' }),

  getSync: () =>
    request<{
      stage2Required: boolean;
      pairedDeviceCount?: number;
      rules: SyncRuleRecord[];
      history: Array<{ id: string; ruleId: string; status: string; filesSynced: number; conflictsDetected: number; message: string; createdAt: string }>;
    }>('/sync'),
  createSyncRule: (rule: {
    name: string;
    direction: SyncRuleRecord['direction'];
    localFolderId: string | null;
    remotePath: string;
    exclusions: string[];
    conflictPolicy: SyncRuleRecord['conflictPolicy'];
    deviceId?: string | null;
  }) => request<SyncRuleRecord>('/sync/rules', { method: 'POST', body: JSON.stringify(rule) }),
  updateSyncRule: (id: string, patch: { enabled?: boolean; deviceId?: string | null }) =>
    request<SyncRuleRecord>(`/sync/rules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSyncRule: (id: string) => request<{ ok: boolean }>(`/sync/rules/${id}`, { method: 'DELETE' }),

  getSettings: () =>
    request<{ settings: AppSettings; dbPath: string | null; configDir: string }>('/settings'),
  updateSettings: (patch: Partial<AppSettings>) =>
    request<{ settings: AppSettings }>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  getDatabaseStatus: () =>
    request<{
      dbPath: string | null;
      dbSize: number;
      integrity: { ok: boolean; result: string[] };
      backups: Array<{ name: string; path: string; size: number; createdAt: string }>;
    }>('/database/status'),
  backupDatabase: () =>
    request<{ backupPath: string; size: number; createdAt: string }>('/database/backup', { method: 'POST' }),
  restoreDatabase: (backupName: string) =>
    request<{ ok: boolean; message: string }>('/database/restore', {
      method: 'POST',
      body: JSON.stringify({ backupName }),
    }),
  checkDbIntegrity: () => request<{ ok: boolean; result: string[] }>('/database/integrity', { method: 'POST' }),
  rebuildDbIndex: () => request<ScannerState>('/database/rebuild', { method: 'POST' }),

  getLogs: (category?: string, level?: string) => {
    const qs = new URLSearchParams();
    if (category) qs.set('category', category);
    if (level) qs.set('level', level);
    return request<{ logs: ActivityLogRecord[] }>(`/logs?${qs.toString()}`);
  },
};

export async function sha256Buffer(buffer: ArrayBuffer): Promise<string | undefined> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return undefined;
}

export async function streamUploadFile(
  file: File,
  folderId: string | null,
  onProgress?: (t: TransferRecord) => void,
  existingTransfer?: TransferRecord,
  shouldPause?: () => boolean
): Promise<{ transfer: TransferRecord; file: FileRecord } | null> {
  const chunkSize = existingTransfer?.chunkSize || 4 * 1024 * 1024;
  let session =
    existingTransfer ||
    (await api.initUpload({
      fileName: file.name,
      totalBytes: file.size,
      folderId,
      chunkSize,
    }));
  onProgress?.(session);

  const verified = new Set(session.verifiedChunks || []);
  for (let i = 0; i < session.totalChunks; i++) {
    if (verified.has(i)) continue;
    if (shouldPause?.()) {
      const paused = await api.pauseTransfer(session.id);
      onProgress?.(paused);
      return null;
    }
    const start = i * session.chunkSize;
    const end = Math.min(file.size, start + session.chunkSize);
    const sliceBuf = await file.slice(start, end).arrayBuffer();
    const chunkHash = await sha256Buffer(sliceBuf);
    session = await api.uploadChunk(session.id, i, sliceBuf, chunkHash);
    onProgress?.(session);
  }

  const completed = await api.completeUpload(session.id);
  onProgress?.(completed.transfer);
  return completed;
}
