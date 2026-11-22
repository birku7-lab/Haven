import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import React from 'react';
import { api } from '../lib/api';
import { formatBytes, formatDate, formatEta, formatSpeed } from '../lib/format';
import type { TransferRecord } from '../types';

interface TransfersViewProps {
  transfers: TransferRecord[];
  onRefresh: () => void;
  onUploadFiles: (files: FileList | File[], folderId: string | null) => void;
  onPauseUpload: (id: string) => void;
  onResumeUpload: (transfer: TransferRecord) => void;
}

export function TransfersView({
  transfers,
  onRefresh,
  onUploadFiles,
  onPauseUpload,
  onResumeUpload,
}: TransfersViewProps) {
  const active = transfers.filter(
    (t) => t.status === 'active' || t.status === 'queued' || t.status === 'paused' || t.status === 'verifying' || t.status === 'failed'
  );
  const history = transfers.filter((t) => t.status === 'completed' || t.status === 'cancelled');

  const handleCancel = async (id: string) => {
    await api.cancelTransfer(id);
    onRefresh();
  };

  const handleRetry = async (t: TransferRecord) => {
    await api.retryTransfer(t.id);
    onResumeUpload(t);
    onRefresh();
  };

  const handleClearHistory = async () => {
    await api.clearTransferHistory();
    onRefresh();
  };

  const renderStatusText = (t: TransferRecord) => {
    switch (t.status) {
      case 'active':
        return <span className="text-blue-500">Transferring</span>;
      case 'verifying':
        return <span className="text-amber-500">Verifying SHA-256</span>;
      case 'queued':
        return <span className="text-zinc-400">Queued</span>;
      case 'paused':
        return <span className="text-amber-400">Paused (recoverable)</span>;
      case 'failed':
        return <span className="text-red-500">Failed</span>;
      case 'completed':
        return <span className="text-emerald-500">Verified & Saved</span>;
      case 'cancelled':
        return <span className="text-zinc-500">Cancelled</span>;
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Transfer Queue & History</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            Chunked streaming engine with SHA-256 verification and crash-safe resume recovery.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {history.length > 0 && (
            <button
              type="button"
              onClick={() => void handleClearHistory()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-white/[0.06] hover:bg-zinc-200 dark:hover:bg-white/[0.1] border border-zinc-200 dark:border-white/[0.08] cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear History
            </button>
          )}
          <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white cursor-pointer">
            <Upload className="w-3.5 h-3.5" />
            Queue Files
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onUploadFiles(e.target.files, null);
                  e.target.value = '';
                }
              }}
            />
          </label>
        </div>
      </div>

      {/* Active & Recoverable Transfers */}
      <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5">
        <h3 className="text-sm font-semibold mb-4">
          Active & Pending ({active.length})
        </h3>
        {active.length === 0 ? (
          <div className="py-10 text-center text-xs text-zinc-500 dark:text-zinc-400">
            No active, queued, or paused transfers.
          </div>
        ) : (
          <div className="space-y-4">
            {active.map((t) => {
              const pct = t.totalBytes > 0 ? Math.round((t.transferredBytes / t.totalBytes) * 100) : 100;
              return (
                <div
                  key={t.id}
                  className="p-4 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.06] space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {t.direction === 'upload' ? (
                        <ArrowUp className="w-4 h-4 text-blue-400 shrink-0" />
                      ) : (
                        <ArrowDown className="w-4 h-4 text-emerald-400 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{t.fileName}</div>
                        <div className="text-xs text-zinc-500 font-mono tabular-nums">
                          {renderStatusText(t)} · {formatBytes(t.transferredBytes)} /{' '}
                          {formatBytes(t.totalBytes)} · {t.verifiedChunks.length}/{t.totalChunks} chunks
                          {t.status === 'active' && t.speedBps > 0 && ` · ${formatSpeed(t.speedBps)} · ETA ${formatEta(t.etaSeconds)}`}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {(t.status === 'active' || t.status === 'queued') && (
                        <button
                          type="button"
                          onClick={() => onPauseUpload(t.id)}
                          title="Pause transfer"
                          className="p-1.5 rounded-md bg-zinc-200 dark:bg-white/10 hover:bg-zinc-300 dark:hover:bg-white/15 cursor-pointer"
                        >
                          <Pause className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {t.status === 'paused' && (
                        <button
                          type="button"
                          onClick={() => onResumeUpload(t)}
                          title="Resume transfer"
                          className="p-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-500 cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {t.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => void handleRetry(t)}
                          title="Retry transfer"
                          className="p-1.5 rounded-md bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleCancel(t.id)}
                        title="Cancel transfer"
                        className="p-1.5 rounded-md hover:bg-red-500/15 text-zinc-400 hover:text-red-400 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="w-full h-1.5 bg-zinc-200 dark:bg-white/10 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        t.status === 'failed'
                          ? 'bg-red-500'
                          : t.status === 'paused'
                            ? 'bg-amber-500'
                            : 'bg-blue-500'
                      }`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>

                  {t.errorMessage && (
                    <div className="text-xs text-red-500">{t.errorMessage}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Transfer History */}
      <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-white/[0.08]">
          <h3 className="text-sm font-semibold">Transfer History ({history.length})</h3>
        </div>
        {history.length === 0 ? (
          <div className="py-10 text-center text-xs text-zinc-500 dark:text-zinc-400">
            Completed and cancelled transfers appear here.
          </div>
        ) : (
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-white/[0.08] text-zinc-500">
                <th className="py-2.5 px-5 font-medium">File</th>
                <th className="py-2.5 px-3 font-medium">Direction</th>
                <th className="py-2.5 px-3 font-medium text-right">Size</th>
                <th className="py-2.5 px-3 font-medium">Integrity</th>
                <th className="py-2.5 px-5 font-medium text-right">Completed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
              {history.map((t) => (
                <tr key={t.id}>
                  <td className="py-2.5 px-5 font-medium truncate max-w-xs">{t.fileName}</td>
                  <td className="py-2.5 px-3 capitalize text-zinc-500">{t.direction}</td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                    {formatBytes(t.totalBytes)}
                  </td>
                  <td className="py-2.5 px-3 font-mono">
                    {t.status === 'completed' ? (
                      <span className="inline-flex items-center gap-1 text-emerald-500">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {t.sha256Actual ? `SHA-256 ${t.sha256Actual.slice(0, 10)}…` : 'Verified'}
                      </span>
                    ) : (
                      <span className="text-zinc-500">Cancelled</span>
                    )}
                  </td>
                  <td className="py-2.5 px-5 text-right font-mono tabular-nums text-zinc-500">
                    {formatDate(t.completedAt || t.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
