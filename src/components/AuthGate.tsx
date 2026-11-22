import { HardDrive, Lock, ShieldCheck } from 'lucide-react';
import React, { useState } from 'react';
import { api, setAuthToken } from '../lib/api';

interface AuthGateProps {
  passcodeConfigured: boolean;
  managedByEnv: boolean;
  onAuthenticated: () => void;
}

export function AuthGate({ passcodeConfigured, managedByEnv, onAuthenticated }: AuthGateProps) {
  const [passcode, setPasscode] = useState('');
  const [confirmPasscode, setConfirmPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!passcodeConfigured) {
      if (passcode.length < 4) {
        setError('Passcode must be at least 4 characters.');
        return;
      }
      if (passcode !== confirmPasscode) {
        setError('Passcodes do not match.');
        return;
      }
    }

    setBusy(true);
    try {
      const res = passcodeConfigured
        ? await api.login(passcode)
        : await api.setupPasscode(passcode);
      setAuthToken(res.token);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-zinc-50 dark:bg-[#18181B] text-zinc-900 dark:text-zinc-100 p-6">
      <div className="w-full max-w-md bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-blue-600/15 text-blue-600 dark:text-blue-400 flex items-center justify-center">
            <HardDrive className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Haven</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Personal Storage Server Console
            </p>
          </div>
        </div>

        <h2 className="text-base font-semibold mb-1.5">
          {passcodeConfigured ? 'Unlock Storage Console' : 'Create Vault Passcode'}
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6 leading-relaxed">
          {passcodeConfigured
            ? managedByEnv
              ? 'Enter the configured administrator passcode to manage your personal storage server.'
              : 'Enter your vault passcode to access files, transfers, and server controls.'
            : 'Set a local administrator passcode to protect your storage server settings, pairing controls, and file vault.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Passcode
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                autoFocus
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder={passcodeConfigured ? 'Enter passcode' : 'Minimum 4 characters'}
                className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1] focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              />
            </div>
          </div>

          {!passcodeConfigured && (
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Confirm Passcode
              </label>
              <div className="relative">
                <ShieldCheck className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  value={confirmPasscode}
                  onChange={(e) => setConfirmPasscode(e.target.value)}
                  placeholder="Re-enter passcode"
                  className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1] focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !passcode}
            className="w-full py-2.5 px-4 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors cursor-pointer"
          >
            {busy
              ? 'Verifying...'
              : passcodeConfigured
                ? 'Unlock Haven'
                : 'Save Passcode & Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
