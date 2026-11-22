import { QrCode, RefreshCw, ShieldOff, Smartphone, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import type { DevicePermissions, DeviceRecord, StorageServerStatus } from '../types';

interface DevicesViewProps {
  serverStatus: StorageServerStatus;
  onStartServer: () => Promise<void>;
}

export function DevicesView({ serverStatus, onStartServer }: DevicesViewProps) {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [qrModal, setQrModal] = useState<{
    qrDataUrl: string;
    payload: {
      host: string;
      hosts: string[];
      port: number;
      serverRunning: boolean;
      code: string;
      expiresAt: string;
    };
  } | null>(null);
  const [generatingQr, setGeneratingQr] = useState(false);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listDevices();
      setDevices(res.devices);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const handleGenerateQr = async () => {
    setGeneratingQr(true);
    try {
      const res = await api.createPairingQr();
      setQrModal(res);
    } finally {
      setGeneratingQr(false);
    }
  };

  const handleTogglePerm = async (device: DeviceRecord, key: keyof DevicePermissions) => {
    const next: DevicePermissions = {
      ...device.permissions,
      [key]: !device.permissions[key],
    };
    await api.updateDevicePermissions(device.id, next);
    await loadDevices();
  };

  const handleRevoke = async (id: string) => {
    await api.revokeDevice(id);
    await loadDevices();
  };

  const handleDelete = async (id: string) => {
    await api.deleteDevice(id);
    await loadDevices();
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Paired Devices</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            Authorize your Android phone to back up photos, browse files, and stream media from this PC.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadDevices()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-white/[0.06] border border-zinc-200 dark:border-white/[0.08] cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void handleGenerateQr()}
            disabled={generatingQr}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white cursor-pointer"
          >
            <QrCode className="w-4 h-4" />
            {generatingQr ? 'Generating...' : 'Pair Android Device'}
          </button>
        </div>
      </div>

      {!serverStatus.running && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="text-amber-700 dark:text-amber-300">
            The Local Storage Server is currently stopped. Start it so mobile devices on your Wi-Fi network can pair and connect.
          </span>
          <button
            type="button"
            onClick={() => void onStartServer()}
            className="px-3 py-1.5 rounded-lg bg-amber-500 text-zinc-950 font-medium hover:bg-amber-400 cursor-pointer"
          >
            Start Storage Server
          </button>
        </div>
      )}

      {loading ? (
        <div className="h-40 rounded-xl bg-zinc-200/60 dark:bg-white/[0.04] animate-pulse" />
      ) : devices.length === 0 ? (
        <div className="py-16 text-center bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl">
          <Smartphone className="w-8 h-8 text-zinc-400 mx-auto mb-3" />
          <div className="text-sm font-medium">No mobile device connected</div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-md mx-auto">
            No devices have been paired with this storage server yet. Pairing infrastructure is ready for the Stage 2 Android client or API pairing requests.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {devices.map((dev) => (
            <div
              key={dev.id}
              className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-5 space-y-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-zinc-100 dark:bg-white/[0.06] flex items-center justify-center">
                    <Smartphone className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{dev.name}</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                      {dev.deviceType.toUpperCase()} ({dev.osVersion || 'Unknown OS'}) ·{' '}
                      {dev.isRevoked
                        ? 'Access Revoked'
                        : dev.status === 'connected'
                          ? 'Authorized'
                          : 'Offline'}{' '}
                      · Last seen {formatDate(dev.lastSeenAt)}
                    </div>
                    {dev.ipAddress && (
                      <div className="text-xs font-mono text-zinc-500 mt-0.5">
                        IP {dev.ipAddress} · Paired {formatDate(dev.pairedAt)}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {!dev.isRevoked && (
                    <button
                      type="button"
                      onClick={() => void handleRevoke(dev.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 cursor-pointer"
                    >
                      <ShieldOff className="w-3.5 h-3.5" />
                      Revoke Access
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleDelete(dev.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/15 text-red-500 hover:bg-red-500/25 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Remove
                  </button>
                </div>
              </div>

              {!dev.isRevoked && (
                <div className="pt-3 border-t border-zinc-100 dark:border-white/[0.06] flex flex-wrap gap-4 text-xs">
                  {(
                    [
                      ['readFiles', 'Read & Browse Files'],
                      ['uploadFiles', 'Upload & Back Up'],
                      ['streamMedia', 'Stream Media'],
                      ['syncFolders', 'Folder Sync'],
                      ['deleteFiles', 'Delete to Recycle Bin'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={dev.permissions[key]}
                        onChange={() => void handleTogglePerm(dev, key)}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* QR Pairing Modal */}
      {qrModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.1] rounded-xl p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Pair Mobile Device</h3>
              <button
                type="button"
                onClick={() => setQrModal(null)}
                className="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col items-center space-y-4">
              <div className="p-3 bg-white rounded-xl border border-zinc-200">
                <img src={qrModal.qrDataUrl} alt="Device pairing QR code" className="w-52 h-52" />
              </div>
              <div className="text-center space-y-1">
                <div className="text-xs text-zinc-500">One-Time Pairing Code</div>
                <div className="text-2xl font-mono font-bold tracking-widest tabular-nums">
                  {qrModal.payload.code}
                </div>
                <div className="text-xs text-zinc-500">
                  Expires {formatDate(qrModal.payload.expiresAt)}
                </div>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.06] text-xs font-mono space-y-1">
              <div>Server Endpoint: http://{qrModal.payload.host}:{qrModal.payload.port}</div>
              <div>
                Server Status: {serverStatus.running ? 'Listening on LAN' : 'Stopped (start server to pair)'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
