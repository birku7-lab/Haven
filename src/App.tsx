import {
  ArrowUpDown,
  BarChart3,
  FolderOpen,
  FolderSync,
  HardDrive,
  Image as ImageIcon,
  LayoutDashboard,
  Moon,
  Server,
  Settings,
  Smartphone,
  Sun,
  Trash2,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnalyticsView } from './components/AnalyticsView';
import { AuthGate } from './components/AuthGate';
import { DashboardView, type DashboardData } from './components/DashboardView';
import { DevicesView } from './components/DevicesView';
import { FilesView } from './components/FilesView';
import { MediaView } from './components/MediaView';
import { RecycleBinView } from './components/RecycleBinView';
import { SettingsView } from './components/SettingsView';
import { SetupWizard } from './components/SetupWizard';
import { SyncView } from './components/SyncView';
import { TransfersView } from './components/TransfersView';
import { api, initDesktopApi, setAuthToken, streamUploadFile } from './lib/api';
import type { AppSettings, NavSection, StorageServerStatus, TransferRecord } from './types';

const NAV_ITEMS: Array<{ id: NavSection; label: string; icon: React.ReactNode }> = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: 'files', label: 'Files', icon: <FolderOpen className="w-4 h-4" /> },
  { id: 'media', label: 'Photos & Videos', icon: <ImageIcon className="w-4 h-4" /> },
  { id: 'transfers', label: 'Transfers', icon: <ArrowUpDown className="w-4 h-4" /> },
  { id: 'analytics', label: 'Storage Analytics', icon: <BarChart3 className="w-4 h-4" /> },
  { id: 'devices', label: 'Devices', icon: <Smartphone className="w-4 h-4" /> },
  { id: 'sync', label: 'Sync', icon: <FolderSync className="w-4 h-4" /> },
  { id: 'recycle-bin', label: 'Recycle Bin', icon: <Trash2 className="w-4 h-4" /> },
  { id: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
];

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [passcodeConfigured, setPasscodeConfigured] = useState(false);
  const [managedByEnv, setManagedByEnv] = useState(false);
  const [setupCompleted, setSetupCompleted] = useState(false);

  const [section, setSection] = useState<NavSection>('dashboard');
  const [targetFolderId, setTargetFolderId] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loadingDash, setLoadingDash] = useState(false);
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeUploadFilesRef = useRef<Map<string, File>>(new Map());
  const pausedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  const checkAuthStatus = useCallback(async () => {
    setAuthChecking(true);
    try {
      await initDesktopApi();
      const st = await api.getAuthStatus();
      setPasscodeConfigured(st.passcodeConfigured);
      setManagedByEnv(st.managedByEnv);
      setSetupCompleted(st.setupCompleted);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkAuthStatus();
  }, [checkAuthStatus]);

  const refreshAll = useCallback(async () => {
    if (!authenticated) return;
    setLoadingDash(true);
    try {
      const [dash, tr] = await Promise.all([api.getDashboard(), api.listTransfers()]);
      setDashboard(dash);
      setSetupCompleted(dash.setupCompleted);
      setTransfers(tr.transfers);
      if (dash.settings?.theme) {
        setTheme(dash.settings.theme);
      }
      setRefreshTrigger((n) => n + 1);
    } finally {
      setLoadingDash(false);
    }
  }, [authenticated]);

  useEffect(() => {
    if (authenticated) {
      void refreshAll();
    }
  }, [authenticated, refreshAll]);

  const handleUploadFiles = useCallback(
    async (fileList: FileList | File[], folderId: string | null) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      for (const f of files) {
        let currentTransferId: string | null = null;
        try {
          await streamUploadFile(
            f,
            folderId,
            (t) => {
              currentTransferId = t.id;
              activeUploadFilesRef.current.set(t.id, f);
              setTransfers((prev) => {
                const idx = prev.findIndex((x) => x.id === t.id);
                if (idx === -1) return [t, ...prev];
                const copy = [...prev];
                copy[idx] = t;
                return copy;
              });
            },
            undefined,
            () => (currentTransferId ? pausedIdsRef.current.has(currentTransferId) : false)
          );
          if (currentTransferId) {
            activeUploadFilesRef.current.delete(currentTransferId);
            pausedIdsRef.current.delete(currentTransferId);
          }
        } catch {
          // Error recorded on transfer record
        }
      }
      void refreshAll();
    },
    [refreshAll]
  );

  const handlePauseUpload = useCallback(
    async (transferId: string) => {
      pausedIdsRef.current.add(transferId);
      try {
        await api.pauseTransfer(transferId);
        const tr = await api.listTransfers();
        setTransfers(tr.transfers);
      } catch {
        // ignore
      }
    },
    []
  );

  const handleResumeUpload = useCallback(
    async (transfer: TransferRecord) => {
      pausedIdsRef.current.delete(transfer.id);
      const localFile = activeUploadFilesRef.current.get(transfer.id);
      const resumed = await api.resumeTransfer(transfer.id);
      if (localFile) {
        try {
          await streamUploadFile(
            localFile,
            transfer.folderId,
            (t) => {
              setTransfers((prev) => prev.map((x) => (x.id === t.id ? t : x)));
            },
            resumed,
            () => pausedIdsRef.current.has(transfer.id)
          );
          activeUploadFilesRef.current.delete(transfer.id);
        } catch {
          // error recorded
        }
      }
      void refreshAll();
    },
    [refreshAll]
  );

  const handleToggleServer = async () => {
    if (!dashboard) return;
    if (dashboard.server.running) {
      await api.stopServer();
    } else {
      await api.startServer();
    }
    await refreshAll();
  };

  const handleToggleTheme = async () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (setupCompleted) {
      await api.updateSettings({ theme: next });
    }
  };

  const handleLockConsole = async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    setAuthToken(null);
    setAuthenticated(false);
    await checkAuthStatus();
  };

  if (authChecking) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-zinc-50 dark:bg-[#18181B] text-zinc-500 text-sm">
        Loading Haven...
      </div>
    );
  }

  if (!authenticated) {
    return (
      <AuthGate
        passcodeConfigured={passcodeConfigured}
        managedByEnv={managedByEnv}
        onAuthenticated={() => setAuthenticated(true)}
      />
    );
  }

  if (!setupCompleted) {
    return (
      <SetupWizard
        onComplete={() => {
          setSetupCompleted(true);
          void refreshAll();
        }}
      />
    );
  }

  const activeNav = NAV_ITEMS.find((n) => n.id === section)!;
  const activeTransferCount = transfers.filter(
    (t) => t.status === 'active' || t.status === 'queued' || t.status === 'verifying'
  ).length;

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-zinc-50 dark:bg-[#18181B] text-zinc-900 dark:text-zinc-100">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-white dark:bg-[#1F1F23] border-r border-zinc-200 dark:border-white/[0.08] flex flex-col justify-between">
        <div>
          <div className="h-14 px-5 flex items-center gap-2.5 border-b border-zinc-200 dark:border-white/[0.08]">
            <div className="w-7 h-7 rounded-lg bg-blue-600/15 text-blue-500 flex items-center justify-center">
              <HardDrive className="w-4 h-4" />
            </div>
            <span className="text-sm font-semibold tracking-tight">Haven</span>
          </div>

          <nav className="p-3 space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const isActive = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-blue-600/15 text-blue-600 dark:text-blue-400'
                      : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/[0.05] hover:text-zinc-900 dark:hover:text-zinc-100'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    {item.icon}
                    <span className="whitespace-nowrap">{item.label}</span>
                  </span>
                  {item.id === 'transfers' && activeTransferCount > 0 && (
                    <span className="font-mono tabular-nums text-[11px] text-blue-500">
                      {activeTransferCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Real Background Storage Server Status Indicator */}
        <div className="p-3 border-t border-zinc-200 dark:border-white/[0.08]">
          <button
            type="button"
            onClick={() => setSection('settings')}
            className="w-full text-left p-2.5 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.06] hover:border-zinc-300 dark:hover:border-white/15 transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between text-xs font-medium">
              <span className="flex items-center gap-2">
                <Server
                  className={`w-3.5 h-3.5 ${
                    dashboard?.server.running ? 'text-emerald-500' : 'text-zinc-400'
                  }`}
                />
                <span>{dashboard?.server.running ? 'Server Running' : 'Server Stopped'}</span>
              </span>
              <span className="font-mono tabular-nums text-zinc-500">
                :{dashboard?.server.port ?? 48720}
              </span>
            </div>
            <div className="text-[11px] text-zinc-500 mt-1 truncate font-mono">
              {dashboard?.settings.storageRoot || ''}
            </div>
          </button>
        </div>
      </aside>

      {/* Main Viewport */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 px-6 border-b border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#1F1F23] flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="text-zinc-400">Haven</span>
            <span className="text-zinc-400">/</span>
            <span>{activeNav.label}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleToggleTheme()}
              title={theme === 'dark' ? 'Switch to Light theme' : 'Switch to Dark theme'}
              className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-white/[0.06] cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          {section === 'dashboard' && (
            <DashboardView
              data={dashboard}
              loading={loadingDash}
              onNavigate={(s) => setSection(s)}
              onImportFiles={() => fileInputRef.current?.click()}
              onScanStorage={() => {
                void api.startScan().then(() => refreshAll());
              }}
              onToggleServer={() => void handleToggleServer()}
              onConfigureStorage={() => setSection('settings')}
            />
          )}

          {section === 'files' && (
            <FilesView
              initialFolderId={targetFolderId}
              onUploadFiles={(files, fldId) => void handleUploadFiles(files, fldId)}
              refreshTrigger={refreshTrigger}
            />
          )}

          {section === 'media' && <MediaView refreshTrigger={refreshTrigger} />}

          {section === 'transfers' && (
            <TransfersView
              transfers={transfers}
              onRefresh={() => void refreshAll()}
              onUploadFiles={(files, fldId) => void handleUploadFiles(files, fldId)}
              onPauseUpload={(id) => void handlePauseUpload(id)}
              onResumeUpload={(tr) => void handleResumeUpload(tr)}
            />
          )}

          {section === 'analytics' && (
            <AnalyticsView
              refreshTrigger={refreshTrigger}
              onOpenFolder={(fldId) => {
                setTargetFolderId(fldId);
                setSection('files');
              }}
            />
          )}

          {section === 'devices' && dashboard && (
            <DevicesView
              serverStatus={dashboard.server}
              onStartServer={async () => {
                await api.startServer();
                await refreshAll();
              }}
            />
          )}

          {section === 'sync' && <SyncView />}

          {section === 'recycle-bin' && <RecycleBinView onChanged={() => void refreshAll()} />}

          {section === 'settings' && dashboard && (
            <SettingsView
              settings={dashboard.settings}
              serverStatus={dashboard.server}
              onSettingsUpdated={(next: AppSettings) => {
                setDashboard((prev) => (prev ? { ...prev, settings: next } : prev));
                setTheme(next.theme);
              }}
              onServerUpdated={(next: StorageServerStatus) => {
                setDashboard((prev) => (prev ? { ...prev, server: next } : prev));
              }}
              onLockConsole={() => void handleLockConsole()}
              onStorageRelocated={() => void refreshAll()}
            />
          )}
        </main>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            void handleUploadFiles(e.target.files, null);
            e.target.value = '';
          }
        }}
      />
    </div>
  );
}
