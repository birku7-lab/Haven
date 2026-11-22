import { Copy, FolderOpen, HardDrive, Layers, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import type { FileCategory, FileRecord, FolderRecord } from '../types';

interface AnalyticsViewProps {
  onOpenFolder: (folderId: string | null) => void;
  refreshTrigger: number;
}

const CATEGORY_COLORS: Record<FileCategory, string> = {
  photo: 'bg-sky-500',
  video: 'bg-indigo-500',
  document: 'bg-amber-500',
  audio: 'bg-emerald-500',
  archive: 'bg-orange-500',
  code: 'bg-cyan-500',
  executable: 'bg-rose-500',
  other: 'bg-zinc-500',
};

export function AnalyticsView({ onOpenFolder, refreshTrigger }: AnalyticsViewProps) {
  const [data, setData] = useState<{
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
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getAnalytics();
      setData(res);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshTrigger]);

  const handleRemoveEmptyFolder = async (folderId: string) => {
    await api.deleteFolder(folderId);
    await load();
  };

  if (loading && !data) {
    return (
      <div className="p-8 space-y-4">
        <div className="h-28 rounded-xl bg-zinc-200/60 dark:bg-white/[0.04] animate-pulse" />
        <div className="h-64 rounded-xl bg-zinc-200/60 dark:bg-white/[0.04] animate-pulse" />
      </div>
    );
  }

  if (!data) return null;

  const usedPct =
    data.volume.totalBytes > 0
      ? Math.round((data.volume.usedBytes / data.volume.totalBytes) * 1000) / 10
      : 0;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      {/* Volume & Breakdown */}
      <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <HardDrive className="w-5 h-5 text-blue-500" />
            <h2 className="text-base font-semibold">Storage Breakdown</h2>
          </div>
          <div className="text-xs font-mono tabular-nums text-zinc-500">
            {formatBytes(data.volume.usedBytes)} used · {formatBytes(data.volume.freeBytes)} free ·{' '}
            {usedPct}% of {formatBytes(data.volume.totalBytes)}
          </div>
        </div>

        {/* Category segmented bar */}
        <div className="w-full h-3 bg-zinc-100 dark:bg-white/[0.06] rounded-full overflow-hidden flex">
          {data.byCategory.map((cat) => {
            const pct =
              data.totalManagedBytes > 0 ? (cat.bytes / data.totalManagedBytes) * 100 : 0;
            if (pct <= 0) return null;
            return (
              <div
                key={cat.category}
                className={CATEGORY_COLORS[cat.category]}
                style={{ width: `${pct}%` }}
                title={`${cat.category}: ${formatBytes(cat.bytes)}`}
              />
            );
          })}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          {data.byCategory.length === 0 ? (
            <div className="col-span-4 text-zinc-500">No managed files indexed yet.</div>
          ) : (
            data.byCategory.map((cat) => (
              <div
                key={cat.category}
                className="p-3 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.06]"
              >
                <div className="flex items-center gap-2 font-medium capitalize">
                  <span className={`w-2.5 h-2.5 rounded-xs ${CATEGORY_COLORS[cat.category]}`} />
                  {cat.category}
                </div>
                <div className="mt-1 font-mono tabular-nums text-sm font-semibold">
                  {formatBytes(cat.bytes)}
                </div>
                <div className="text-zinc-500 font-mono tabular-nums">{cat.count} files</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Largest Files */}
        <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-4">Largest Files</h3>
          {data.largestFiles.length === 0 ? (
            <p className="text-xs text-zinc-500 py-6 text-center">No files stored yet.</p>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
              {data.largestFiles.slice(0, 8).map((f) => (
                <div key={f.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{f.name}</div>
                    <div className="text-zinc-500 truncate font-mono">{f.relativePath}</div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono tabular-nums font-medium">{formatBytes(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => onOpenFolder(f.folderId)}
                      title="Open folder location"
                      className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-blue-400 cursor-pointer"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Largest Folders */}
        <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-4">Largest Folders</h3>
          {data.largestFolders.length === 0 ? (
            <p className="text-xs text-zinc-500 py-6 text-center">No populated folders yet.</p>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
              {data.largestFolders.slice(0, 8).map((fld) => (
                <div key={fld.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{fld.relativePath}</div>
                    <div className="text-zinc-500 font-mono tabular-nums">
                      {fld.fileCount} files
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono tabular-nums font-medium">{formatBytes(fld.bytes)}</span>
                    <button
                      type="button"
                      onClick={() => onOpenFolder(fld.id)}
                      title="Open folder"
                      className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-blue-400 cursor-pointer"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Duplicate Files (never auto-deleted) */}
        <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Copy className="w-4 h-4 text-zinc-400" />
              Duplicate Files (SHA-256 Match)
            </h3>
            <span className="text-xs text-zinc-500">Manual review only</span>
          </div>
          {data.duplicates.length === 0 ? (
            <p className="text-xs text-zinc-500 py-6 text-center">No duplicate files detected.</p>
          ) : (
            <div className="space-y-3">
              {data.duplicates.map((group) => (
                <div
                  key={group.sha256}
                  className="p-3 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.06] space-y-1.5 text-xs"
                >
                  <div className="flex justify-between font-mono text-zinc-500">
                    <span>{group.files.length} identical copies · {formatBytes(group.size)} each</span>
                    <span>{group.sha256.slice(0, 12)}…</span>
                  </div>
                  {group.files.map((f) => (
                    <div key={f.id} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono">{f.relativePath}</span>
                      <button
                        type="button"
                        onClick={() => onOpenFolder(f.folderId)}
                        className="text-blue-500 hover:underline shrink-0 cursor-pointer"
                      >
                        Open location
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Empty Folders & Growth History */}
        <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5 space-y-5">
          <div>
            <h3 className="text-sm font-semibold mb-3">
              Empty Folders ({data.emptyFolders.length})
            </h3>
            {data.emptyFolders.length === 0 ? (
              <p className="text-xs text-zinc-500">No empty user folders.</p>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {data.emptyFolders.map((fld) => (
                  <div key={fld.id} className="flex items-center justify-between text-xs py-1">
                    <span className="font-mono truncate">{fld.relativePath}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onOpenFolder(fld.id)}
                        className="text-blue-500 hover:underline cursor-pointer"
                      >
                        Open
                      </button>
                      {fld.parentId !== null && (
                        <button
                          type="button"
                          onClick={() => void handleRemoveEmptyFolder(fld.id)}
                          title="Delete empty folder"
                          className="text-zinc-400 hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-zinc-200 dark:border-white/[0.08] pt-4">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Layers className="w-4 h-4 text-zinc-400" />
              Storage Growth Snapshots
            </h3>
            {data.history.length === 0 ? (
              <p className="text-xs text-zinc-500">
                Run a storage scan to record disk utilization snapshots over time.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto text-xs font-mono tabular-nums">
                {data.history.slice(-6).map((h, i) => (
                  <div key={i} className="flex justify-between text-zinc-500">
                    <span>{formatDate(h.recordedAt)}</span>
                    <span>
                      {formatBytes(h.usedBytes)} · {h.fileCount} files
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
