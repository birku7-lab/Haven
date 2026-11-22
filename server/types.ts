export type FileCategory =
  | 'photo'
  | 'video'
  | 'audio'
  | 'document'
  | 'archive'
  | 'executable'
  | 'code'
  | 'other';

export type TransferDirection = 'upload' | 'download';

export type TransferStatus =
  | 'queued'
  | 'active'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DriveInfo {
  id: string;
  name: string;
  mountPath: string;
  fileSystem: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  isWritable: boolean;
  isSystem: boolean;
}

export interface FolderRecord {
  id: string;
  name: string;
  relativePath: string;
  parentId: string | null;
  createdAt: string;
  modifiedAt: string;
  isFavorite: boolean;
  deviceOrigin: string;
  itemCount?: number;
  totalSize?: number;
}

export interface FileRecord {
  id: string;
  name: string;
  relativePath: string;
  folderId: string | null;
  size: number;
  mimeType: string;
  category: FileCategory;
  extension: string;
  createdAt: string;
  modifiedAt: string;
  importedAt: string;
  sha256: string | null;
  thumbnailPath: string | null;
  isFavorite: boolean;
  tags: string[];
  backupStatus: 'local_only' | 'backed_up' | 'verified';
  deviceOrigin: string;
  transferStatus: 'complete' | 'in_progress' | 'missing';
  isDeleted: boolean;
  deletedAt: string | null;
  originalRelativePath: string | null;
  originalFolderId: string | null;
}

export interface TransferRecord {
  id: string;
  direction: TransferDirection;
  fileId: string | null;
  fileName: string;
  targetRelativePath: string;
  folderId: string | null;
  totalBytes: number;
  transferredBytes: number;
  chunkSize: number;
  totalChunks: number;
  verifiedChunks: number[];
  status: TransferStatus;
  speedBps: number;
  etaSeconds: number | null;
  sha256Expected: string | null;
  sha256Actual: string | null;
  retryCount: number;
  maxRetries: number;
  errorMessage: string | null;
  deviceId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DevicePermissions {
  readFiles: boolean;
  uploadFiles: boolean;
  deleteFiles: boolean;
  streamMedia: boolean;
  syncFolders: boolean;
}

export interface DeviceRecord {
  id: string;
  name: string;
  deviceType: 'android' | 'windows' | 'other';
  osVersion: string;
  permissions: DevicePermissions;
  status: 'connected' | 'offline' | 'revoked';
  isRevoked: boolean;
  pairedAt: string;
  lastConnectedAt: string | null;
  lastSeenAt: string | null;
  ipAddress: string | null;
}

export interface SyncRuleRecord {
  id: string;
  deviceId: string | null;
  name: string;
  direction: 'one_way_to_pc' | 'one_way_to_mobile' | 'two_way';
  localFolderId: string | null;
  localFolderPath: string;
  remotePath: string;
  exclusions: string[];
  conflictPolicy: 'keep_both' | 'prefer_pc' | 'prefer_mobile' | 'ask';
  enabled: boolean;
  status: 'awaiting_device' | 'idle' | 'active' | 'conflict' | 'disabled';
  lastSyncAt: string | null;
  createdAt: string;
}

export interface ActivityLogRecord {
  id: number;
  level: 'info' | 'warn' | 'error';
  category: 'system' | 'storage' | 'transfer' | 'server' | 'auth' | 'scanner' | 'database';
  message: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface ScannerState {
  isRunning: boolean;
  lastRunAt: string | null;
  scannedCount: number;
  newFiles: number;
  missingFiles: number;
  movedFiles: number;
  hashedFiles: number;
  thumbnailsGenerated: number;
  duplicatesFound: number;
  errors: string[];
}

export interface StorageServerStatus {
  running: boolean;
  port: number;
  bindAddress: string;
  lanUrls: string[];
  startedAt: string | null;
  activeConnections: number;
  lastError: string | null;
}

export interface AppSettings {
  storageRoot: string | null;
  setupCompleted: boolean;
  theme: 'dark' | 'light';
  language: string;
  startWithWindows: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
  warningThresholdPct: number;
  serverEnabled: boolean;
  serverAutoStart: boolean;
  serverPort: number;
  serverBindLan: boolean;
  maxConcurrentTransfers: number;
  transferRetryLimit: number;
  scheduledScanMinutes: number;
}
