import { FolderSync, Info, Plus, Power, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import type { DeviceRecord, FolderRecord, SyncRuleRecord } from '../types';

export function SyncView() {
  const [rules, setRules] = useState<SyncRuleRecord[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [stage2Required, setStage2Required] = useState(true);
  const [history, setHistory] = useState<
    Array<{
      id: string;
      ruleId: string;
      status: string;
      filesSynced: number;
      conflictsDetected: number;
      message: string;
      createdAt: string;
    }>
  >([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const [name, setName] = useState('');
  const [direction, setDirection] = useState<SyncRuleRecord['direction']>('one_way_to_pc');
  const [localFolderId, setLocalFolderId] = useState<string>('');
  const [deviceId, setDeviceId] = useState<string>('');
  const [remotePath, setRemotePath] = useState('/DCIM/Camera');
  const [exclusions, setExclusions] = useState('*.tmp, .thumbnails/*');
  const [conflictPolicy, setConflictPolicy] = useState<SyncRuleRecord['conflictPolicy']>('keep_both');

  const load = useCallback(async () => {
    const [syncRes, filesRes, devRes] = await Promise.all([
      api.getSync(),
      api.listFiles({}),
      api.listDevices(),
    ]);
    setRules(syncRes.rules);
    setHistory(syncRes.history);
    setStage2Required(syncRes.stage2Required);
    setDevices(devRes.devices.filter((d) => !d.isRevoked));
    setFolders(filesRes.allFolders);
    if (filesRes.allFolders.length > 0 && !localFolderId) {
      setLocalFolderId(filesRes.allFolders[0].id);
    }
  }, [localFolderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !remotePath.trim()) return;
    await api.createSyncRule({
      name: name.trim(),
      direction,
      localFolderId: localFolderId || null,
      remotePath: remotePath.trim(),
      exclusions: exclusions
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      conflictPolicy,
      deviceId: deviceId || null,
    });
    setName('');
    setShowCreate(false);
    await load();
  };

  const handleToggle = async (rule: SyncRuleRecord) => {
    await api.updateSyncRule(rule.id, { enabled: !rule.enabled });
    await load();
  };

  const handleDelete = async (id: string) => {
    await api.deleteSyncRule(id);
    await load();
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-start gap-3 text-xs text-blue-700 dark:text-blue-300">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          {stage2Required ? (
            <>
              <span className="font-semibold">Stage 2 Mobile Sync Ready:</span> Define folder sync
              policies now, then pair your Haven Android app via QR code in the Devices tab so
              background sync executes over Wi-Fi.
            </>
          ) : (
            <>
              <span className="font-semibold">Stage 2 Mobile Sync Active:</span>{' '}
              <span className="font-mono tabular-nums">{devices.length}</span> paired device(s)
              can pull enabled policies below and report completed folder runs over LAN.
            </>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Sync Rules</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            One-way camera backup and two-way folder synchronization policies for Haven Android.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(!showCreate)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white cursor-pointer whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          New Sync Policy
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5 space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block font-medium mb-1">Rule Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Phone Camera Backup"
                className="w-full px-3 py-2 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Target Android Device</label>
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              >
                <option value="">Any Paired Device</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.osVersion})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">Sync Direction</label>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as SyncRuleRecord['direction'])}
                className="w-full px-3 py-2 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              >
                <option value="one_way_to_pc">One-way (Android to PC)</option>
                <option value="one_way_to_mobile">One-way (PC to Android)</option>
                <option value="two_way">Two-way Bidirectional</option>
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">PC Destination Folder</label>
              <select
                value={localFolderId}
                onChange={(e) => setLocalFolderId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              >
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.relativePath}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">Android Folder Path</label>
              <input
                type="text"
                required
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                className="w-full px-3 py-2 font-mono rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Conflict Policy</label>
              <select
                value={conflictPolicy}
                onChange={(e) => setConflictPolicy(e.target.value as SyncRuleRecord['conflictPolicy'])}
                className="w-full px-3 py-2 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              >
                <option value="keep_both">Keep Both Versions</option>
                <option value="prefer_pc">Prefer PC Version</option>
                <option value="prefer_mobile">Prefer Mobile Version</option>
                <option value="ask">Ask Before Resolving</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block font-medium mb-1">Exclusions (comma-separated)</label>
              <input
                type="text"
                value={exclusions}
                onChange={(e) => setExclusions(e.target.value)}
                className="w-full px-3 py-2 font-mono rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-3 py-1.5 text-xs text-zinc-500 cursor-pointer whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white cursor-pointer whitespace-nowrap"
            >
              Save Rule
            </button>
          </div>
        </form>
      )}

      {rules.length === 0 ? (
        <div className="py-16 text-center bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl">
          <FolderSync className="w-8 h-8 text-zinc-400 mx-auto mb-3" />
          <div className="text-sm font-medium">No sync policies configured</div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Create a policy to synchronize folders, photos, and backups with Haven Android.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((r) => {
            const devName = r.deviceId
              ? devices.find((d) => d.id === r.deviceId)?.name || 'Assigned device'
              : 'All paired devices';
            const statusText =
              r.status === 'active'
                ? 'Active · Synced'
                : r.status === 'conflict'
                ? 'Conflict detected'
                : r.status === 'disabled'
                ? 'Paused'
                : stage2Required
                ? 'Awaiting paired Android device'
                : 'Ready on paired device';
            const statusClass =
              r.status === 'active'
                ? 'text-emerald-500'
                : r.status === 'conflict'
                ? 'text-red-400'
                : r.status === 'disabled'
                ? 'text-zinc-400'
                : stage2Required
                ? 'text-amber-500'
                : 'text-blue-400';

            return (
              <div
                key={r.id}
                className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-4 flex items-center justify-between gap-4"
              >
                <div className="space-y-1 min-w-0">
                  <div className="text-sm font-semibold truncate">{r.name}</div>
                  <div className="text-xs text-zinc-500 font-mono truncate">
                    {r.remotePath} ↔ {r.localFolderPath} · {r.direction.replace(/_/g, ' ')} ·{' '}
                    {devName}
                  </div>
                  <div className={`text-xs ${statusClass} flex items-center gap-2 font-mono tabular-nums`}>
                    <span>{statusText}</span>
                    {r.lastSyncAt && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-zinc-500">Last sync {formatDate(r.lastSyncAt)}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleToggle(r)}
                    title={r.enabled ? 'Pause sync rule' : 'Enable sync rule'}
                    className={`p-2 rounded-lg cursor-pointer transition-colors ${
                      r.enabled
                        ? 'text-emerald-400 hover:bg-emerald-500/15'
                        : 'text-zinc-400 hover:bg-zinc-500/15'
                    }`}
                  >
                    <Power className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(r.id)}
                    title="Delete sync rule"
                    className="p-2 rounded-lg hover:bg-red-500/15 text-zinc-400 hover:text-red-400 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {history.length > 0 && (
        <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3">Sync History</h3>
          <div className="divide-y divide-zinc-200 dark:divide-white/[0.06] text-xs">
            {history.map((h) => (
              <div key={h.id} className="py-2.5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="truncate font-medium">{h.message}</div>
                  <div className="text-zinc-500 font-mono tabular-nums mt-0.5">
                    {h.status} · {h.filesSynced} file(s) · {h.conflictsDetected} conflict(s)
                  </div>
                </div>
                <span className="font-mono tabular-nums text-zinc-500 shrink-0">
                  {formatDate(h.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
