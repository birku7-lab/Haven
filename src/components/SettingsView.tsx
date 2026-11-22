import {
  CheckCircle2,
  Database,
  Download,
  HardDrive,
  Lock,
  RefreshCw,
  ScrollText,
  Server,
  Shield,
  Sliders,
  Smartphone,
  UploadCloud,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { api, buildLogsExportUrl } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import type { ActivityLogRecord, AppSettings, DeviceRecord, StorageServerStatus } from '../types';

interface SettingsViewProps {
  settings: AppSettings;
  serverStatus: StorageServerStatus;
  onSettingsUpdated: (next: AppSettings) => void;
  onServerUpdated: (next: StorageServerStatus) => void;
  onLockConsole: () => void;
  onStorageRelocated: () => void;
}

type SettingsTab =
  | 'general'
  | 'storage'
  | 'server'
  | 'devices'
  | 'transfers'
  | 'database'
  | 'security'
  | 'logs';

export function SettingsView({
  settings,
  serverStatus,
  onSettingsUpdated,
  onServerUpdated,
  onLockConsole,
  onStorageRelocated,
}: SettingsViewProps) {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Server state
  const [portInput, setPortInput] = useState(String(settings.serverPort));
  const [bindLan, setBindLan] = useState(settings.serverBindLan);
  const [apiDocs, setApiDocs] = useState<Record<string, unknown> | null>(null);

  // Storage relocate state
  const [relocatePath, setRelocatePath] = useState('');
  const [relocateMode, setRelocateMode] = useState<'copy_and_switch' | 'switch_existing'>('copy_and_switch');
  const [relocating, setRelocating] = useState(false);

  // Database state
  const [dbStatus, setDbStatus] = useState<{
    dbPath: string | null;
    dbSize: number;
    integrity: { ok: boolean; result: string[] };
    backups: Array<{ name: string; path: string; size: number; createdAt: string }>;
  } | null>(null);

  // Devices & Sessions & Logs
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [sessions, setSessions] = useState<Array<{ id: string; createdAt: string; lastActiveAt: string; userAgent: string }>>([]);
  const [logs, setLogs] = useState<ActivityLogRecord[]>([]);
  const [logCategory, setLogCategory] = useState('all');
  const [logLevel, setLogLevel] = useState('all');

  const showMsg = (m: string) => {
    setError(null);
    setMessage(m);
    setTimeout(() => setMessage((cur) => (cur === m ? null : cur)), 4000);
  };

  const patchSettings = async (patch: Partial<AppSettings>, msg?: string) => {
    try {
      const res = await api.updateSettings(patch);
      onSettingsUpdated(res.settings);
      if (msg) showMsg(msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    }
  };

  const loadDbStatus = useCallback(async () => {
    const res = await api.getDatabaseStatus();
    setDbStatus(res);
  }, []);

  const loadLogs = useCallback(async () => {
    const res = await api.getLogs(logCategory, logLevel);
    setLogs(res.logs);
  }, [logCategory, logLevel]);

  useEffect(() => {
    if (tab === 'database') void loadDbStatus();
    if (tab === 'devices') void api.listDevices().then((r) => setDevices(r.devices));
    if (tab === 'security') void api.getSessions().then((r) => setSessions(r.sessions));
    if (tab === 'logs') void loadLogs();
  }, [tab, loadDbStatus, loadLogs]);

  const handleSaveServerConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.updateServerConfig({
        port: Number(portInput),
        bindLan,
      });
      onSettingsUpdated(res.settings);
      onServerUpdated(res.status);
      showMsg('Server configuration updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Server update failed');
    }
  };

  const handleToggleServer = async () => {
    setError(null);
    try {
      const st = serverStatus.running
        ? await api.stopServer()
        : await api.startServer(Number(portInput), bindLan);
      onServerUpdated(st);
      showMsg(st.running ? `Storage server started on port ${st.port}` : 'Storage server stopped');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Server state change failed');
    }
  };

  const handleRelocate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!relocatePath.trim()) return;
    setRelocating(true);
    setError(null);
    try {
      const res = await api.relocateStorage(relocatePath.trim(), relocateMode);
      showMsg(`Relocated storage to ${res.newRoot} (${res.filesCopied} files copied & verified)`);
      setRelocatePath('');
      onStorageRelocated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Relocation failed');
    } finally {
      setRelocating(false);
    }
  };

  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'general', label: 'General', icon: <Sliders className="w-4 h-4" /> },
    { id: 'storage', label: 'Storage', icon: <HardDrive className="w-4 h-4" /> },
    { id: 'server', label: 'Server & API', icon: <Server className="w-4 h-4" /> },
    { id: 'devices', label: 'Devices', icon: <Smartphone className="w-4 h-4" /> },
    { id: 'transfers', label: 'Transfers', icon: <UploadCloud className="w-4 h-4" /> },
    { id: 'database', label: 'Database', icon: <Database className="w-4 h-4" /> },
    { id: 'security', label: 'Security', icon: <Shield className="w-4 h-4" /> },
    { id: 'logs', label: 'Logs', icon: <ScrollText className="w-4 h-4" /> },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto flex flex-col md:flex-row gap-6">
      {/* Settings Sub-navigation */}
      <div className="w-full md:w-52 shrink-0 space-y-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              tab === t.id
                ? 'bg-blue-600/15 text-blue-600 dark:text-blue-400'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-white/[0.05]'
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Settings Content */}
      <div className="flex-1 space-y-5">
        {message && (
          <div className="px-4 py-2.5 rounded-lg text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{message}</span>
          </div>
        )}
        {error && (
          <div className="px-4 py-2.5 rounded-lg text-xs bg-red-500/10 border border-red-500/20 text-red-500">
            {error}
          </div>
        )}

        {tab === 'general' && (
          <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6 space-y-5">
            <h3 className="text-sm font-semibold">General & Desktop Behavior</h3>

            <div className="space-y-4 text-xs">
              <div className="flex items-center justify-between py-2 border-b border-zinc-100 dark:border-white/[0.06]">
                <div>
                  <div className="font-medium text-sm">Theme</div>
                  <div className="text-zinc-500">Choose dark or light desktop appearance</div>
                </div>
                <select
                  value={settings.theme}
                  onChange={(e) =>
                    void patchSettings({ theme: e.target.value as 'dark' | 'light' }, 'Theme updated')
                  }
                  className="px-3 py-1.5 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
                >
                  <option value="dark">Dark (Default)</option>
                  <option value="light">Light</option>
                </select>
              </div>

              <label className="flex items-center justify-between py-2 border-b border-zinc-100 dark:border-white/[0.06] cursor-pointer">
                <div>
                  <div className="font-medium text-sm">Start Haven with Windows</div>
                  <div className="text-zinc-500">Launch automatically when signing in to Windows</div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.startWithWindows}
                  onChange={(e) =>
                    void patchSettings({ startWithWindows: e.target.checked }, 'Startup preference saved')
                  }
                />
              </label>

              <label className="flex items-center justify-between py-2 border-b border-zinc-100 dark:border-white/[0.06] cursor-pointer">
                <div>
                  <div className="font-medium text-sm">Minimize to System Tray</div>
                  <div className="text-zinc-500">Keep window tucked in tray when minimized</div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.minimizeToTray}
                  onChange={(e) =>
                    void patchSettings({ minimizeToTray: e.target.checked }, 'Tray behavior saved')
                  }
                />
              </label>

              <label className="flex items-center justify-between py-2 cursor-pointer">
                <div>
                  <div className="font-medium text-sm">Keep Server Running When Closing Window</div>
                  <div className="text-zinc-500">
                    Closing main window hides to tray without stopping background storage server
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.closeToTray}
                  onChange={(e) =>
                    void patchSettings({ closeToTray: e.target.checked }, 'Close behavior saved')
                  }
                />
              </label>
            </div>
          </div>
        )}

        {tab === 'storage' && (
          <div className="space-y-5">
            <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6 space-y-4">
              <h3 className="text-sm font-semibold">Active Storage Location</h3>
              <div className="p-3 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.08] font-mono text-xs break-all">
                {settings.storageRoot}
              </div>

              <div className="flex items-center justify-between pt-2 text-xs">
                <div>
                  <div className="font-medium text-sm">Storage Warning Threshold (%)</div>
                  <div className="text-zinc-500">Show dashboard warning when drive usage exceeds limit</div>
                </div>
                <input
                  type="number"
                  min={50}
                  max={99}
                  value={settings.warningThresholdPct}
                  onChange={(e) =>
                    void patchSettings({ warningThresholdPct: Number(e.target.value) }, 'Threshold saved')
                  }
                  className="w-20 px-2.5 py-1.5 rounded-lg font-mono text-right bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
                />
              </div>
            </div>

            <form
              onSubmit={handleRelocate}
              className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6 space-y-4"
            >
              <h3 className="text-sm font-semibold">Safely Relocate Storage Folder</h3>
              <p className="text-xs text-zinc-500 leading-relaxed">
                Move your HavenStorage library to another drive without losing files or breaking
                database references. Original files remain preserved for safety until you choose to
                remove them.
              </p>
              <input
                type="text"
                value={relocatePath}
                onChange={(e) => setRelocatePath(e.target.value)}
                placeholder="e.g. E:\HavenStorage"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              />
              <div className="flex flex-wrap gap-4 text-xs">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="relocateMode"
                    checked={relocateMode === 'copy_and_switch'}
                    onChange={() => setRelocateMode('copy_and_switch')}
                  />
                  <span>Copy & verify all files with SHA-256, then switch</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="relocateMode"
                    checked={relocateMode === 'switch_existing'}
                    onChange={() => setRelocateMode('switch_existing')}
                  />
                  <span>Switch to existing HavenStorage folder</span>
                </label>
              </div>
              <button
                type="submit"
                disabled={relocating || !relocatePath.trim()}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white cursor-pointer"
              >
                {relocating ? 'Relocating & Verifying...' : 'Relocate Storage'}
              </button>
            </form>
          </div>
        )}

        {tab === 'server' && (
          <div className="space-y-5">
            <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">Local Network Storage Server</h3>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {serverStatus.running
                      ? `Listening on ${serverStatus.bindAddress}:${serverStatus.port}`
                      : 'Stopped — mobile devices cannot connect while disabled'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleToggleServer()}
                  className={`px-4 py-2 rounded-lg text-xs font-medium cursor-pointer ${
                    serverStatus.running
                      ? 'bg-zinc-200 dark:bg-white/10 hover:bg-zinc-300 dark:hover:bg-white/15'
                      : 'bg-blue-600 hover:bg-blue-500 text-white'
                  }`}
                >
                  {serverStatus.running ? 'Stop Server' : 'Start Server'}
                </button>
              </div>

              {serverStatus.lanUrls.length > 0 && (
                <div className="p-3 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.08] text-xs font-mono space-y-1">
                  <div className="text-zinc-500 font-sans">Active Local Endpoints</div>
                  {serverStatus.lanUrls.map((u) => (
                    <div key={u}>{u}</div>
                  ))}
                </div>
              )}

              <form onSubmit={handleSaveServerConfig} className="space-y-4 pt-2 border-t border-zinc-100 dark:border-white/[0.06] text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block font-medium mb-1">Server Port</label>
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      value={portInput}
                      onChange={(e) => setPortInput(e.target.value)}
                      className="w-full px-3 py-2 font-mono rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
                    />
                  </div>
                  <div className="flex items-end pb-2">
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={bindLan}
                        onChange={(e) => setBindLan(e.target.checked)}
                      />
                      <span>Allow LAN connections (Wi-Fi devices)</span>
                    </label>
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.serverAutoStart}
                    onChange={(e) =>
                      void patchSettings({ serverAutoStart: e.target.checked }, 'Auto-start saved')
                    }
                  />
                  <span>Automatically start storage server when Haven launches</span>
                </label>
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white cursor-pointer"
                  >
                    Save Server Config
                  </button>
                  <button
                    type="button"
                    onClick={() => void api.getApiDocs().then(setApiDocs)}
                    className="px-3 py-2 rounded-lg text-xs bg-zinc-100 dark:bg-white/[0.06] border border-zinc-200 dark:border-white/[0.08] cursor-pointer"
                  >
                    View API Specification
                  </button>
                </div>
              </form>

              {apiDocs && (
                <pre className="p-3 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.08] text-xs font-mono overflow-x-auto max-h-64">
                  {JSON.stringify(apiDocs, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}

        {tab === 'devices' && (
          <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold">Authorized Devices ({devices.length})</h3>
            {devices.length === 0 ? (
              <p className="text-xs text-zinc-500">No devices paired yet.</p>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-white/[0.06] text-xs">
                {devices.map((d) => (
                  <div key={d.id} className="py-3 flex items-center justify-between">
                    <div>
                      <div className="font-medium">{d.name}</div>
                      <div className="text-zinc-500">
                        {d.isRevoked ? 'Revoked' : 'Active'} · Last seen {formatDate(d.lastSeenAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await api.deleteDevice(d.id);
                        const r = await api.listDevices();
                        setDevices(r.devices);
                      }}
                      className="text-red-500 hover:underline cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'transfers' && (
          <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6 space-y-4 text-xs">
            <h3 className="text-sm font-semibold">Transfer & Scanner Limits</h3>
            <div className="flex items-center justify-between py-2 border-b border-zinc-100 dark:border-white/[0.06]">
              <div>
                <div className="font-medium text-sm">Simultaneous Transfers</div>
                <div className="text-zinc-500">Maximum concurrent active uploads/downloads</div>
              </div>
              <input
                type="number"
                min={1}
                max={10}
                value={settings.maxConcurrentTransfers}
                onChange={(e) =>
                  void patchSettings({ maxConcurrentTransfers: Number(e.target.value) }, 'Saved')
                }
                className="w-20 px-2.5 py-1.5 rounded-lg font-mono text-right bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              />
            </div>

            <div className="flex items-center justify-between py-2 border-b border-zinc-100 dark:border-white/[0.06]">
              <div>
                <div className="font-medium text-sm">Automatic Retry Limit</div>
                <div className="text-zinc-500">Retries before marking a transfer failed</div>
              </div>
              <input
                type="number"
                min={0}
                max={10}
                value={settings.transferRetryLimit}
                onChange={(e) =>
                  void patchSettings({ transferRetryLimit: Number(e.target.value) }, 'Saved')
                }
                className="w-20 px-2.5 py-1.5 rounded-lg font-mono text-right bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              />
            </div>

            <div className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium text-sm">Scheduled Storage Scan (Minutes)</div>
                <div className="text-zinc-500">0 disables background scheduled scans</div>
              </div>
              <input
                type="number"
                min={0}
                max={1440}
                value={settings.scheduledScanMinutes}
                onChange={(e) =>
                  void patchSettings({ scheduledScanMinutes: Number(e.target.value) }, 'Saved')
                }
                className="w-20 px-2.5 py-1.5 rounded-lg font-mono text-right bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              />
            </div>
          </div>
        )}

        {tab === 'database' && (
          <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6 space-y-5 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">SQLite Metadata Database</h3>
              <button
                type="button"
                onClick={() => void loadDbStatus()}
                className="p-1.5 rounded-lg bg-zinc-100 dark:bg-white/[0.06] cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            {dbStatus && (
              <>
                <div className="space-y-2 font-mono">
                  <div className="flex justify-between py-1.5 border-b border-zinc-100 dark:border-white/[0.06]">
                    <span className="text-zinc-500 font-sans">Database File</span>
                    <span className="truncate max-w-md">{dbStatus.dbPath}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-zinc-100 dark:border-white/[0.06]">
                    <span className="text-zinc-500 font-sans">Size</span>
                    <span className="tabular-nums">{formatBytes(dbStatus.dbSize)}</span>
                  </div>
                  <div className="flex justify-between py-1.5">
                    <span className="text-zinc-500 font-sans">SQLite Integrity Check</span>
                    <span className={dbStatus.integrity.ok ? 'text-emerald-500' : 'text-red-500'}>
                      {dbStatus.integrity.ok ? 'OK' : dbStatus.integrity.result.join(', ')}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      await api.backupDatabase();
                      await loadDbStatus();
                      showMsg('Database backup created');
                    }}
                    className="px-3.5 py-2 rounded-lg font-medium bg-blue-600 hover:bg-blue-500 text-white cursor-pointer"
                  >
                    Create Backup Now
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await api.checkDbIntegrity();
                      await loadDbStatus();
                      showMsg(`Integrity check: ${res.result.join(', ')}`);
                    }}
                    className="px-3.5 py-2 rounded-lg font-medium bg-zinc-100 dark:bg-white/[0.08] cursor-pointer"
                  >
                    Run Integrity Check
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await api.rebuildDbIndex();
                      await loadDbStatus();
                      showMsg(`Rebuilt index: ${res.scannedCount} files verified`);
                    }}
                    className="px-3.5 py-2 rounded-lg font-medium bg-zinc-100 dark:bg-white/[0.08] cursor-pointer"
                  >
                    Rebuild File Index
                  </button>
                </div>

                <div className="pt-3 border-t border-zinc-100 dark:border-white/[0.06]">
                  <h4 className="font-semibold mb-2">Available Backups ({dbStatus.backups.length})</h4>
                  {dbStatus.backups.length === 0 ? (
                    <p className="text-zinc-500">No backups created yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {dbStatus.backups.map((b) => (
                        <div key={b.name} className="flex items-center justify-between py-1.5">
                          <div>
                            <div className="font-mono">{b.name}</div>
                            <div className="text-zinc-500">
                              {formatBytes(b.size)} · {formatDate(b.createdAt)}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={async () => {
                              const res = await api.restoreDatabase(b.name);
                              await loadDbStatus();
                              showMsg(res.message);
                            }}
                            className="px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 cursor-pointer"
                          >
                            Restore
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'security' && (
          <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6 space-y-5 text-xs">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Security & Active Sessions</h3>
                <p className="text-zinc-500 mt-0.5">
                  Console sessions use scrypt-verified passcodes and in-memory Bearer tokens.
                </p>
              </div>
              <button
                type="button"
                onClick={onLockConsole}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-medium bg-zinc-100 dark:bg-white/[0.08] hover:bg-zinc-200 dark:hover:bg-white/[0.14] cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                Lock Console
              </button>
            </div>

            <div className="space-y-2">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="p-3 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.06] flex items-center justify-between"
                >
                  <div>
                    <div className="font-medium truncate max-w-md">{s.userAgent}</div>
                    <div className="text-zinc-500 font-mono">
                      Started {formatDate(s.createdAt)} · Active {formatDate(s.lastActiveAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await api.revokeSession(s.id);
                      const r = await api.getSessions();
                      setSessions(r.sessions);
                    }}
                    className="text-red-500 hover:underline cursor-pointer"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'logs' && (
          <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6 space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">System, Server & Transfer Logs</h3>
              <div className="flex items-center gap-2">
                <select
                  value={logCategory}
                  onChange={(e) => setLogCategory(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
                >
                  <option value="all">All Categories</option>
                  <option value="storage">Storage</option>
                  <option value="transfer">Transfers</option>
                  <option value="server">Server</option>
                  <option value="auth">Auth</option>
                  <option value="scanner">Scanner</option>
                  <option value="database">Database</option>
                </select>
                <select
                  value={logLevel}
                  onChange={(e) => setLogLevel(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
                >
                  <option value="all">All Levels</option>
                  <option value="info">Info</option>
                  <option value="warn">Warnings</option>
                  <option value="error">Errors</option>
                </select>
                <a
                  href={buildLogsExportUrl()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export JSON
                </a>
              </div>
            </div>

            <div className="max-h-96 overflow-y-auto divide-y divide-zinc-100 dark:divide-white/[0.05] font-mono">
              {logs.length === 0 ? (
                <div className="py-8 text-center text-zinc-500">No logs matching filter.</div>
              ) : (
                logs.map((l) => (
                  <div key={l.id} className="py-2 flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <span
                        className={
                          l.level === 'error'
                            ? 'text-red-500'
                            : l.level === 'warn'
                              ? 'text-amber-500'
                              : 'text-zinc-400'
                        }
                      >
                        [{l.level.toUpperCase()} · {l.category}]
                      </span>{' '}
                      <span className="text-zinc-800 dark:text-zinc-200 font-sans">
                        {l.message}
                      </span>
                    </div>
                    <span className="text-zinc-500 shrink-0 tabular-nums">
                      {formatDate(l.createdAt)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
