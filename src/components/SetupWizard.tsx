import { ArrowRight, CheckCircle2, FolderCheck, FolderSearch, HardDrive, Loader2, RefreshCw } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { api, isDesktopApp, pickDesktopFolder } from '../lib/api';
import { formatBytes } from '../lib/format';
import type { DriveInfo } from '../types';

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [loadingDrives, setLoadingDrives] = useState(true);
  const [selectedDrive, setSelectedDrive] = useState<DriveInfo | null>(null);
  const [storagePath, setStoragePath] = useState('');
  const [validation, setValidation] = useState<{
    writable: boolean;
    error: string | null;
    freeBytes: number;
    totalBytes: number;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [initResult, setInitResult] = useState<{
    storageRoot: string;
    subdirsCreated: string[];
    dbPath: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDrives = async () => {
    setLoadingDrives(true);
    setError(null);
    try {
      const res = await api.getDrives();
      setDrives(res.drives);
      if (res.drives.length > 0) {
        const preferred = res.drives.find((d) => !d.isSystem && d.isWritable) || res.drives[0];
        setSelectedDrive(preferred);
        const suggested = preferred.mountPath.endsWith('HavenStorage')
          ? preferred.mountPath
          : `${preferred.mountPath.replace(/[\\/]+$/, '')}${res.platform === 'win32' ? '\\' : '/'}HavenStorage`;
        setStoragePath(suggested);
      } else {
        setStoragePath(res.defaultPath);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to detect drives');
    } finally {
      setLoadingDrives(false);
    }
  };

  useEffect(() => {
    void loadDrives();
  }, []);

  const handleSelectDrive = (drive: DriveInfo) => {
    setSelectedDrive(drive);
    const sep = drive.mountPath.includes('\\') ? '\\' : '/';
    const suggested = drive.mountPath.endsWith('HavenStorage')
      ? drive.mountPath
      : `${drive.mountPath.replace(/[\\/]+$/, '')}${sep}HavenStorage`;
    setStoragePath(suggested);
    setValidation(null);
  };

  const handleValidate = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await api.validatePath(storagePath);
      setStoragePath(res.path);
      setValidation({
        writable: res.writable,
        error: res.error,
        freeBytes: res.volume.freeBytes,
        totalBytes: res.volume.totalBytes,
      });
      if (res.writable) {
        setStep(2);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      setChecking(false);
    }
  };

  const handleInitialize = async () => {
    setInitializing(true);
    setError(null);
    try {
      const res = await api.initializeStorage(storagePath);
      setInitResult({
        storageRoot: res.storageRoot,
        subdirsCreated: res.subdirsCreated,
        dbPath: res.dbPath,
      });
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Initialization failed');
    } finally {
      setInitializing(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-zinc-50 dark:bg-[#18181B] text-zinc-900 dark:text-zinc-100 p-6 overflow-y-auto">
      <div className="w-full max-w-2xl bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-8">
        <div className="flex items-center justify-between border-b border-zinc-200 dark:border-white/[0.08] pb-5 mb-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Configure Storage Location</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              Select the drive and folder where Haven will store your files and metadata database.
            </p>
          </div>
          <div className="text-xs font-mono tabular-nums text-zinc-500 dark:text-zinc-400">
            Step {step} of 3
          </div>
        </div>

        {step === 1 && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Available Drives & Volumes
              </h2>
              <button
                type="button"
                onClick={() => void loadDrives()}
                className="inline-flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingDrives ? 'animate-spin' : ''}`} />
                Refresh Drives
              </button>
            </div>

            {loadingDrives ? (
              <div className="py-10 flex items-center justify-center text-sm text-zinc-500 gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Inspecting mounted storage volumes...
              </div>
            ) : (
              <div className="space-y-2.5">
                {drives.map((d) => {
                  const usedPct = d.totalBytes > 0 ? Math.round((d.usedBytes / d.totalBytes) * 100) : 0;
                  const isSelected = selectedDrive?.id === d.id;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => handleSelectDrive(d)}
                      className={`w-full text-left p-4 rounded-lg border transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-blue-600/10 border-blue-500/60'
                          : 'bg-zinc-50 dark:bg-[#252529] border-zinc-200 dark:border-white/[0.08] hover:border-zinc-300 dark:hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2.5">
                          <HardDrive className="w-4 h-4 text-blue-500" />
                          <span className="text-sm font-medium">{d.name}</span>
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            {d.fileSystem} · {d.isWritable ? 'Writable' : 'Read-only'}
                          </span>
                        </div>
                        <span className="text-xs font-mono tabular-nums text-zinc-600 dark:text-zinc-300">
                          {formatBytes(d.freeBytes)} free of {formatBytes(d.totalBytes)}
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-zinc-200 dark:bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full"
                          style={{ width: `${Math.min(100, usedPct)}%` }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Storage Directory Path
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={storagePath}
                  onChange={(e) => {
                    setStoragePath(e.target.value);
                    setValidation(null);
                  }}
                  placeholder="e.g. D:\HavenStorage"
                  className="flex-1 px-3.5 py-2.5 text-sm font-mono rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1] focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                />
                {isDesktopApp() && (
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await pickDesktopFolder();
                      if (picked) {
                        const sep = picked.includes('\\') ? '\\' : '/';
                        const pathVal = picked.endsWith('HavenStorage')
                          ? picked
                          : `${picked.replace(/[\\/]+$/, '')}${sep}HavenStorage`;
                        setStoragePath(pathVal);
                        setValidation(null);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-[#252529] border border-zinc-200 dark:border-white/[0.1] hover:border-zinc-300 dark:hover:border-white/20 cursor-pointer"
                  >
                    <FolderSearch className="w-4 h-4" />
                    Browse...
                  </button>
                )}
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1.5">
                Files are stored as ordinary folders and files on this drive. You can safely relocate later.
              </p>
            </div>

            {validation && !validation.writable && (
              <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5">
                Location is not writable: {validation.error}
              </div>
            )}

            {error && (
              <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5">
                {error}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                type="button"
                disabled={checking || !storagePath.trim()}
                onClick={() => void handleValidate()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors cursor-pointer"
              >
                {checking ? 'Checking Path...' : 'Verify Path & Continue'}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <div className="p-4 rounded-lg bg-zinc-50 dark:bg-[#252529] border border-zinc-200 dark:border-white/[0.08] space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                <FolderCheck className="w-4 h-4" />
                Path verified and writable
              </div>
              <div className="text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all">
                {storagePath}
              </div>
              {validation && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono tabular-nums">
                  Available space: {formatBytes(validation.freeBytes)} · Total capacity:{' '}
                  {formatBytes(validation.totalBytes)}
                </div>
              )}
            </div>

            <div>
              <h3 className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                Directory structure to initialize
              </h3>
              <div className="grid grid-cols-3 gap-2 text-xs font-mono text-zinc-600 dark:text-zinc-400">
                {[
                  'Files/',
                  'Photos/',
                  'Videos/',
                  'Documents/',
                  'Audio/',
                  'Archives/',
                  'Other/',
                  'Thumbnails/',
                  'Database/',
                  'Backups/',
                  'Temp/',
                  'RecycleBin/',
                ].map((dir) => (
                  <div
                    key={dir}
                    className="px-2.5 py-1.5 rounded bg-zinc-100 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.06]"
                  >
                    {dir}
                  </div>
                ))}
              </div>
            </div>

            {error && (
              <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="px-4 py-2 rounded-lg text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
              >
                Back
              </button>
              <button
                type="button"
                disabled={initializing}
                onClick={() => void handleInitialize()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors cursor-pointer"
              >
                {initializing ? 'Initializing Database...' : 'Initialize Storage & Database'}
              </button>
            </div>
          </div>
        )}

        {step === 3 && initResult && (
          <div className="space-y-6">
            <div className="flex items-start gap-3 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                  Haven Storage Initialized
                </h2>
                <p className="text-xs text-zinc-600 dark:text-zinc-300 mt-1">
                  Your storage directories and SQLite metadata database are ready.
                </p>
              </div>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-2 border-b border-zinc-200 dark:border-white/[0.06]">
                <span className="text-zinc-500">Storage Root</span>
                <span className="font-mono">{initResult.storageRoot}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-zinc-200 dark:border-white/[0.06]">
                <span className="text-zinc-500">Metadata Database</span>
                <span className="font-mono">{initResult.dbPath}</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-zinc-500">Directories Ready</span>
                <span className="font-mono tabular-nums">12 folders verified</span>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onComplete}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors cursor-pointer"
              >
                Open Haven Dashboard
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
