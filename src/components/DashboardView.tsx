import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  Database,
  FolderOpen,
  HardDrive,
  RefreshCw,
  Server,
  Smartphone,
  Upload,
} from 'lucide-react';
import React from 'react';
import { formatBytes, formatDate } from '../lib/format';
import type {
  ActivityLogRecord,
  AppSettings,
  FileRecord,
  NavSection,
  ScannerState,
  StorageServerStatus,
  TransferRecord,
} from '../types';

export interface DashboardData {
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
}

interface DashboardViewProps {
  data: DashboardData | null;
  loading: boolean;
  onNavigate: (section: NavSection) => void;
  onImportFiles: () => void;
  onScanStorage: () => void;
  onToggleServer: () => void;
  onConfigureStorage: () => void;
}

export function DashboardView({
  data,
  loading,
  onNavigate,
  onImportFiles,
  onScanStorage,
  onToggleServer,
  onConfigureStorage,
}: DashboardViewProps) {
  if (loading && !data) {
    return (
      <div className="p-8 space-y-6">
        <div className="h-32 rounded-xl bg-zinc-200/60 dark:bg-white/[0.04] animate-pulse" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-zinc-200/60 dark:bg-white/[0.04] animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!data || !data.volume || !data.counts) return null;

  const { volume, counts, server, scanner, activeTransfers = [], recentFiles = [], recentActivity = [], backupStatus, warnings = [], settings } = data;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((w) => (
            <div
              key={w.code}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border text-sm ${
                w.level === 'error'
                  ? 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300'
              }`}
            >
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Drive Overview Hero Panel */}
      <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <HardDrive className="w-5 h-5 text-blue-500" />
              <h2 className="text-base font-semibold tracking-tight">Primary Storage Volume</h2>
            </div>
            <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400 mt-1">
              {settings.storageRoot}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onImportFiles}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Import Files
            </button>
            <button
              type="button"
              onClick={onScanStorage}
              disabled={scanner?.isRunning}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-white/[0.06] hover:bg-zinc-200 dark:hover:bg-white/[0.1] border border-zinc-200 dark:border-white/[0.08] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${scanner?.isRunning ? 'animate-spin' : ''}`} />
              {scanner?.isRunning ? 'Scanning...' : 'Scan Storage'}
            </button>
          </div>
        </div>

        <div className="w-full h-2.5 bg-zinc-100 dark:bg-white/[0.06] rounded-full overflow-hidden mb-3">
          <div
            className={`h-full rounded-full transition-all ${
              volume.usedPct >= settings.warningThresholdPct ? 'bg-amber-500' : 'bg-blue-500'
            }`}
            style={{ width: `${Math.min(100, volume.usedPct)}%` }}
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 text-xs">
          <div>
            <div className="text-zinc-500 dark:text-zinc-400">Total Capacity</div>
            <div className="text-base font-semibold font-mono tabular-nums mt-0.5">
              {formatBytes(volume.totalBytes)}
            </div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400">Used Space (Volume)</div>
            <div className="text-base font-semibold font-mono tabular-nums mt-0.5">
              {formatBytes(volume.usedBytes)} · {volume.usedPct}%
            </div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400">Available Space</div>
            <div className="text-base font-semibold font-mono tabular-nums mt-0.5 text-emerald-600 dark:text-emerald-400">
              {formatBytes(volume.freeBytes)}
            </div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400">Managed in Haven</div>
            <div className="text-base font-semibold font-mono tabular-nums mt-0.5">
              {formatBytes(counts.managedBytes)}
            </div>
          </div>
        </div>
      </div>

      {/* Key Counters Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() => onNavigate('files')}
          className="text-left bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] hover:border-zinc-300 dark:hover:border-white/20 rounded-xl p-5 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            <span>Stored Files & Folders</span>
            <FolderOpen className="w-4 h-4 text-zinc-400" />
          </div>
          <div className="text-2xl font-semibold font-mono tabular-nums">
            {counts.files.toLocaleString()}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 font-mono tabular-nums">
            {counts.folders.toLocaleString()} folders indexed
          </div>
        </button>

        <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5">
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            <span>Storage Server</span>
            <Server className="w-4 h-4 text-zinc-400" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-lg font-semibold">
              {server.running ? 'Running' : 'Stopped'}
            </div>
            <button
              type="button"
              onClick={onToggleServer}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                server.running
                  ? 'bg-zinc-100 dark:bg-white/[0.08] hover:bg-zinc-200 dark:hover:bg-white/[0.14]'
                  : 'bg-blue-600 hover:bg-blue-500 text-white'
              }`}
            >
              {server.running ? 'Stop' : 'Start'}
            </button>
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 font-mono tabular-nums">
            {server.running ? `Port ${server.port} · ${server.activeConnections} active` : `Configured port ${server.port}`}
          </div>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('devices')}
          className="text-left bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] hover:border-zinc-300 dark:hover:border-white/20 rounded-xl p-5 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            <span>Paired Devices</span>
            <Smartphone className="w-4 h-4 text-zinc-400" />
          </div>
          <div className="text-2xl font-semibold font-mono tabular-nums">
            {counts.connectedDevices}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            {counts.pairedDevices === 0
              ? 'No mobile devices paired'
              : `${counts.pairedDevices} paired · ${counts.connectedDevices} connected`}
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('settings')}
          className="text-left bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] hover:border-zinc-300 dark:hover:border-white/20 rounded-xl p-5 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            <span>Database & Backup</span>
            <Database className="w-4 h-4 text-zinc-400" />
          </div>
          <div className="text-lg font-semibold">
            {backupStatus?.integrityOk ? 'Integrity Verified' : 'Check Needed'}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            {backupStatus?.lastBackupAt
              ? `Last backup ${formatDate(backupStatus.lastBackupAt)}`
              : 'No database backup created yet'}
          </div>
        </button>
      </div>

      {/* Quick Actions Bar */}
      <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 px-1">
          Quick Actions
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onNavigate('files')}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-white/[0.06] hover:bg-zinc-200 dark:hover:bg-white/[0.1] transition-colors cursor-pointer"
          >
            Open File Manager
          </button>
          <button
            type="button"
            onClick={() => onNavigate('devices')}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-white/[0.06] hover:bg-zinc-200 dark:hover:bg-white/[0.1] transition-colors cursor-pointer"
          >
            Connect a Device
          </button>
          <button
            type="button"
            onClick={() => onNavigate('transfers')}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-white/[0.06] hover:bg-zinc-200 dark:hover:bg-white/[0.1] transition-colors cursor-pointer"
          >
            View Transfers ({activeTransfers.length})
          </button>
          <button
            type="button"
            onClick={onConfigureStorage}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-white/[0.06] hover:bg-zinc-200 dark:hover:bg-white/[0.1] transition-colors cursor-pointer"
          >
            Configure Storage
          </button>
        </div>
      </div>

      {/* Lower Two-Column Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Files */}
        <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">Recent Files</h3>
            <button
              type="button"
              onClick={() => onNavigate('files')}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
            >
              Browse all
            </button>
          </div>
          {recentFiles.length === 0 ? (
            <div className="py-10 text-center text-xs text-zinc-500 dark:text-zinc-400">
              No files stored yet. Import files or run a storage scan to index existing files.
            </div>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
              {recentFiles.map((f) => (
                <div key={f.id} className="py-2.5 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{f.name}</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {f.relativePath} · {formatDate(f.importedAt)}
                    </div>
                  </div>
                  <div className="text-xs font-mono tabular-nums text-zinc-500 dark:text-zinc-400 shrink-0">
                    {formatBytes(f.size)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Transfers & Recent Activity */}
        <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5 space-y-5">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ArrowUpDown className="w-4 h-4 text-zinc-400" />
                Active Transfers
              </h3>
              <button
                type="button"
                onClick={() => onNavigate('transfers')}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
              >
                Transfer Manager
              </button>
            </div>
            {activeTransfers.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 py-2">
                No uploads or downloads currently in progress.
              </p>
            ) : (
              <div className="space-y-2.5">
                {activeTransfers.slice(0, 3).map((t) => {
                  const pct = t.totalBytes > 0 ? Math.round((t.transferredBytes / t.totalBytes) * 100) : 0;
                  return (
                    <div key={t.id} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="truncate font-medium">{t.fileName}</span>
                        <span className="font-mono tabular-nums text-zinc-500">{pct}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-zinc-100 dark:bg-white/[0.06] rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-zinc-200 dark:border-white/[0.08] pt-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Activity className="w-4 h-4 text-zinc-400" />
                Recent Activity
              </h3>
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
              >
                View logs
              </button>
            </div>
            {recentActivity.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">No activity recorded yet.</p>
            ) : (
              <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                {recentActivity.slice(0, 6).map((log) => (
                  <div key={log.id} className="text-xs flex items-start justify-between gap-3">
                    <span className="text-zinc-700 dark:text-zinc-300 leading-relaxed">
                      {log.message}
                    </span>
                    <span className="font-mono tabular-nums text-zinc-500 shrink-0">
                      {new Date(log.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
