import { RotateCcw, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import type { FileRecord } from '../types';

interface RecycleBinViewProps {
  onChanged: () => void;
}

export function RecycleBinView({ onChanged }: RecycleBinViewProps) {
  const [items, setItems] = useState<FileRecord[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getRecycleBin();
      setItems(res.items);
      setTotalBytes(res.totalBytes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRestore = async (item: FileRecord) => {
    const restored = await api.restoreFromBin(item.id);
    setMessage(`Restored "${restored.name}" to ${restored.relativePath}`);
    await load();
    onChanged();
  };

  const handlePermanentDelete = async (id: string) => {
    await api.permanentDeleteFromBin(id);
    setConfirmDeleteId(null);
    await load();
    onChanged();
  };

  const handleEmptyBin = async () => {
    const res = await api.emptyRecycleBin();
    setConfirmEmpty(false);
    setMessage(`Permanently removed ${res.removed} item(s)`);
    await load();
    onChanged();
  };

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Recycle Bin</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 font-mono tabular-nums">
            {items.length} deleted item(s) · {formatBytes(totalBytes)} recoverable
          </p>
        </div>

        {items.length > 0 && (
          <button
            type="button"
            onClick={() => setConfirmEmpty(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-red-600/15 text-red-500 hover:bg-red-600/25 border border-red-500/20 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Empty Recycle Bin
          </button>
        )}
      </div>

      {message && (
        <div className="px-4 py-2.5 rounded-lg text-xs bg-blue-500/10 border border-blue-500/20 text-blue-500">
          {message}
        </div>
      )}

      {loading ? (
        <div className="h-40 rounded-xl bg-zinc-200/60 dark:bg-white/[0.04] animate-pulse" />
      ) : items.length === 0 ? (
        <div className="py-20 text-center bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl">
          <Trash2 className="w-8 h-8 text-zinc-400 mx-auto mb-3" />
          <div className="text-sm font-medium">Recycle Bin is empty</div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Deleted files are safely staged here before permanent removal.
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl overflow-hidden">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-white/[0.08] text-zinc-500">
                <th className="py-3 px-5 font-medium">Name</th>
                <th className="py-3 px-3 font-medium">Original Path</th>
                <th className="py-3 px-3 font-medium text-right">Size</th>
                <th className="py-3 px-3 font-medium">Deleted</th>
                <th className="py-3 px-5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05]">
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="py-3 px-5 font-medium">{item.name}</td>
                  <td className="py-3 px-3 font-mono text-zinc-500">
                    {item.originalRelativePath || '—'}
                  </td>
                  <td className="py-3 px-3 text-right font-mono tabular-nums">
                    {formatBytes(item.size)}
                  </td>
                  <td className="py-3 px-3 font-mono tabular-nums text-zinc-500">
                    {formatDate(item.deletedAt)}
                  </td>
                  <td className="py-3 px-5 text-right whitespace-nowrap space-x-2">
                    <button
                      type="button"
                      onClick={() => void handleRestore(item)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600/15 text-blue-500 hover:bg-blue-600/25 font-medium cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Restore
                    </button>
                    {confirmDeleteId === item.id ? (
                      <button
                        type="button"
                        onClick={() => void handlePermanentDelete(item.id)}
                        className="px-2.5 py-1 rounded-md bg-red-600 text-white font-medium cursor-pointer"
                      >
                        Confirm Delete
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(item.id)}
                        className="px-2.5 py-1 rounded-md text-zinc-400 hover:text-red-400 cursor-pointer"
                      >
                        Delete Forever
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmEmpty && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.1] rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold">Empty Recycle Bin?</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
              This will permanently delete {items.length} file(s) ({formatBytes(totalBytes)}) from
              disk. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmEmpty(false)}
                className="px-3 py-1.5 text-xs rounded-lg text-zinc-500 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleEmptyBin()}
                className="px-4 py-1.5 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-500 text-white cursor-pointer"
              >
                Permanently Delete All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
