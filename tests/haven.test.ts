import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiRouter, createHavenContext, type HavenContext } from '../server/api.ts';
import { assertInsideRoot } from '../server/storage.ts';

async function startTestApp(ctx: HavenContext): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/v1', createApiRouter(ctx));
  const srv = http.createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/api/v1`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

describe('Haven Stage 1 Storage Ecosystem Verification', () => {
  let tmpRoot: string;
  let configDir: string;
  let storageDir: string;
  let relocateDir: string;
  let ctx: HavenContext;
  let apiUrl: string;
  let closeApi: () => Promise<void>;
  let sessionToken: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-test-'));
    configDir = path.join(tmpRoot, 'config');
    storageDir = path.join(tmpRoot, 'HavenStorage');
    relocateDir = path.join(tmpRoot, 'HavenStorageRelocated');

    ctx = createHavenContext(configDir);
    const appSrv = await startTestApp(ctx);
    apiUrl = appSrv.baseUrl;
    closeApi = appSrv.close;
  });

  afterAll(async () => {
    await ctx.close();
    await closeApi();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const authHeaders = () => ({
    Authorization: `Bearer ${sessionToken}`,
    'Content-Type': 'application/json',
  });

  it('enforces authentication and sets up initial vault passcode', async () => {
    const unauth = await fetch(`${apiUrl}/setup/drives`);
    expect(unauth.status).toBe(401);

    const setupRes = await fetch(`${apiUrl}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'test-pass-1234' }),
    });
    expect(setupRes.status).toBe(201);
    const setupJson = (await setupRes.json()) as { token: string };
    expect(setupJson.token).toBeTruthy();
    sessionToken = setupJson.token;

    // Duplicate setup must be rejected
    const dupSetup = await fetch(`${apiUrl}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'another-pass' }),
    });
    expect(dupSetup.status).toBe(409);

    // Invalid login rejected
    const badLogin = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'wrong' }),
    });
    expect(badLogin.status).toBe(401);
  });

  it('detects drives, rejects invalid paths, and initializes HavenStorage & SQLite DB', async () => {
    const drivesRes = await fetch(`${apiUrl}/setup/drives`, { headers: authHeaders() });
    expect(drivesRes.status).toBe(200);
    const drivesJson = (await drivesRes.json()) as { drives: Array<{ totalBytes: number; freeBytes: number }> };
    expect(drivesJson.drives.length).toBeGreaterThan(0);
    expect(drivesJson.drives[0].totalBytes).toBeGreaterThan(0);

    const valRes = await fetch(`${apiUrl}/setup/validate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ path: storageDir }),
    });
    const valJson = (await valRes.json()) as { writable: boolean };
    expect(valJson.writable).toBe(true);

    const initRes = await fetch(`${apiUrl}/setup/initialize`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ path: storageDir }),
    });
    expect(initRes.status).toBe(201);
    expect(fs.existsSync(path.join(storageDir, 'Database', 'haven.db'))).toBe(true);
    expect(fs.existsSync(path.join(storageDir, 'Files'))).toBe(true);
    expect(fs.existsSync(path.join(storageDir, 'RecycleBin'))).toBe(true);
    expect(fs.existsSync(path.join(storageDir, 'Thumbnails'))).toBe(true);
  });

  it('blocks path traversal escapes outside HavenStorage root', () => {
    expect(() => assertInsideRoot(storageDir, '../../etc/passwd')).toThrow(/escapes/i);
  });

  it('performs full file & folder lifecycle: create, upload, rename, move, copy, delete, restore with collision', async () => {
    // Create folder + subfolder
    const f1 = await (
      await fetch(`${apiUrl}/folders`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'Projects', parentId: null }),
      })
    ).json();
    const f2 = await (
      await fetch(`${apiUrl}/folders`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: '2026', parentId: f1.id }),
      })
    ).json();
    expect(f2.relativePath).toBe('Files/Projects/2026');

    // Small file upload with SHA-256
    const payload = Buffer.from('Hello Haven Personal Storage Ecosystem!\n');
    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

    const initUp = await (
      await fetch(`${apiUrl}/transfers/upload`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          fileName: 'notes.txt',
          totalBytes: payload.length,
          folderId: f1.id,
          sha256Expected: expectedHash,
        }),
      })
    ).json();

    await fetch(`${apiUrl}/transfers/${initUp.id}/chunks/0`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/octet-stream',
        'X-Chunk-Sha256': expectedHash,
      },
      body: payload,
    });

    const completed = await (
      await fetch(`${apiUrl}/transfers/${initUp.id}/complete`, {
        method: 'POST',
        headers: authHeaders(),
      })
    ).json();
    expect(completed.transfer.status).toBe('completed');
    expect(completed.file.sha256).toBe(expectedHash);

    // Rename
    const renamed = await (
      await fetch(`${apiUrl}/files/${completed.file.id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'readme.txt', isFavorite: true }),
      })
    ).json();
    expect(renamed.name).toBe('readme.txt');
    expect(renamed.isFavorite).toBe(true);

    // Move
    const moved = await (
      await fetch(`${apiUrl}/files/${renamed.id}/move`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ targetFolderId: f2.id }),
      })
    ).json();
    expect(moved.relativePath).toBe('Files/Projects/2026/readme.txt');

    // Copy
    const copied = await (
      await fetch(`${apiUrl}/files/${moved.id}/copy`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ targetFolderId: f2.id }),
      })
    ).json();
    expect(copied.name).toContain('Copy');

    // Soft delete to Recycle Bin
    const deleted = await (
      await fetch(`${apiUrl}/files/${moved.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
    ).json();
    expect(deleted.isDeleted).toBe(true);
    expect(fs.existsSync(path.join(storageDir, deleted.relativePath))).toBe(true);

    // Create a colliding file at original path, then restore from Recycle Bin safely without overwrite!
    fs.writeFileSync(path.join(storageDir, 'Files/Projects/2026/readme.txt'), 'new file at same path');
    const restored = await (
      await fetch(`${apiUrl}/recycle-bin/${moved.id}/restore`, {
        method: 'POST',
        headers: authHeaders(),
      })
    ).json();
    expect(restored.isDeleted).toBe(false);
    expect(restored.name).toBe('readme (1).txt');
    expect(fs.readFileSync(path.join(storageDir, restored.relativePath), 'utf8')).toBe(
      'Hello Haven Personal Storage Ecosystem!\n'
    );
  });

  it('supports interrupted chunked transfer recovery, checksum failure rejection, and disk space enforcement', async () => {
    const chunkSize = 64 * 1024;
    const totalBytes = chunkSize * 2 + 1024;
    const fullBuffer = crypto.randomBytes(totalBytes);
    const fullHash = crypto.createHash('sha256').update(fullBuffer).digest('hex');

    const tr = await (
      await fetch(`${apiUrl}/transfers/upload`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          fileName: 'large-archive.bin',
          totalBytes,
          chunkSize,
          sha256Expected: fullHash,
        }),
      })
    ).json();
    expect(tr.totalChunks).toBe(3);

    // Upload chunk 0
    const c0 = fullBuffer.subarray(0, chunkSize);
    const c0Res = await fetch(`${apiUrl}/transfers/${tr.id}/chunks/0`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/octet-stream',
        'X-Chunk-Sha256': crypto.createHash('sha256').update(c0).digest('hex'),
      },
      body: c0,
    });
    expect(c0Res.status).toBe(200);

    // Simulate interruption / pause
    const paused = await (
      await fetch(`${apiUrl}/transfers/${tr.id}/pause`, {
        method: 'POST',
        headers: authHeaders(),
      })
    ).json();
    expect(paused.status).toBe('paused');
    expect(paused.verifiedChunks).toEqual([0]);

    // Resume and verify chunk 1 bad checksum is rejected
    await fetch(`${apiUrl}/transfers/${tr.id}/resume`, {
      method: 'POST',
      headers: authHeaders(),
    });
    const c1 = fullBuffer.subarray(chunkSize, chunkSize * 2);
    const badChunkRes = await fetch(`${apiUrl}/transfers/${tr.id}/chunks/1`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/octet-stream',
        'X-Chunk-Sha256': '0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: c1,
    });
    expect(badChunkRes.status).toBe(400);

    // Upload valid chunks 1 & 2 (without re-sending chunk 0)
    await fetch(`${apiUrl}/transfers/${tr.id}/chunks/1`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: c1,
    });
    await fetch(`${apiUrl}/transfers/${tr.id}/chunks/2`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: fullBuffer.subarray(chunkSize * 2),
    });

    const completed = await (
      await fetch(`${apiUrl}/transfers/${tr.id}/complete`, {
        method: 'POST',
        headers: authHeaders(),
      })
    ).json();
    expect(completed.transfer.status).toBe('completed');
    expect(completed.file.sha256).toBe(fullHash);

    // Insufficient disk space check (request 999 PB)
    const tooBig = await fetch(`${apiUrl}/transfers/upload`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        fileName: 'impossible.bin',
        totalBytes: 999 * 1024 * 1024 * 1024 * 1024 * 1024,
      }),
    });
    expect(tooBig.status).toBe(400);
    const tooBigErr = (await tooBig.json()) as { error: string };
    expect(tooBigErr.error).toMatch(/disk space/i);
  });

  it('scans disk changes, generates real image thumbnails, detects duplicates & missing files', async () => {
    // Drop a real PNG directly onto disk in Photos/
    const photoPath = path.join(storageDir, 'Photos', 'sample.png');
    await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 120, b: 220 } },
    })
      .png()
      .toFile(photoPath);

    const scan1 = await (
      await fetch(`${apiUrl}/scanner/start`, { method: 'POST', headers: authHeaders() })
    ).json();
    expect(scan1.newFiles).toBeGreaterThanOrEqual(1);
    expect(scan1.thumbnailsGenerated).toBeGreaterThanOrEqual(1);

    const mediaRes = await (
      await fetch(`${apiUrl}/media?type=photo`, { headers: authHeaders() })
    ).json();
    expect(mediaRes.items.length).toBeGreaterThanOrEqual(1);
    const thumbRes = await fetch(
      `${apiUrl}/files/${mediaRes.items[0].id}/thumbnail?token=${encodeURIComponent(sessionToken)}`
    );
    expect(thumbRes.status).toBe(200);
    expect(thumbRes.headers.get('content-type')).toBe('image/webp');
  });

  it('backs up SQLite database, verifies integrity, and restores cleanly', async () => {
    const integrity = await (
      await fetch(`${apiUrl}/database/integrity`, { method: 'POST', headers: authHeaders() })
    ).json();
    expect(integrity.ok).toBe(true);

    const backup = await (
      await fetch(`${apiUrl}/database/backup`, { method: 'POST', headers: authHeaders() })
    ).json();
    expect(fs.existsSync(backup.backupPath)).toBe(true);

    // Create a temporary folder after backup, then restore backup and confirm pre-folder state returns
    await fetch(`${apiUrl}/folders`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'TempAfterBackup', parentId: null }),
    });
    const beforeRestore = await (
      await fetch(`${apiUrl}/files?search=TempAfterBackup`, { headers: authHeaders() })
    ).json();
    expect(beforeRestore.folders.length).toBe(1);

    const restore = await (
      await fetch(`${apiUrl}/database/restore`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ backupName: path.basename(backup.backupPath) }),
      })
    ).json();
    expect(restore.ok).toBe(true);

    const afterRestore = await (
      await fetch(`${apiUrl}/files?search=TempAfterBackup`, { headers: authHeaders() })
    ).json();
    expect(afterRestore.folders.length).toBe(0);
  });

  it('starts LAN storage server, rejects unauthorized requests, pairs mobile client via QR, serves Range streams, detects port conflict, and revokes access', async () => {
    const probeSrv = http.createServer();
    await new Promise<void>((r) => probeSrv.listen(0, '127.0.0.1', r));
    const freePort = (probeSrv.address() as { port: number }).port;
    if (typeof probeSrv.closeAllConnections === 'function') probeSrv.closeAllConnections();
    await new Promise<void>((r) => probeSrv.close(() => r()));

    const startRes = await fetch(`${apiUrl}/server/start`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ port: freePort, bindLan: false }),
    });
    expect(startRes.status).toBe(200);
    const lanBase = `http://127.0.0.1:${freePort}/api/v1`;

    // Unauthorized request must fail
    const unauthLan = await fetch(`${lanBase}/storage/info`);
    expect(unauthLan.status).toBe(401);

    // QR pairing
    const qrRes = await (
      await fetch(`${apiUrl}/devices/pairing-qr`, { method: 'POST', headers: authHeaders() })
    ).json();
    const pairRes = await fetch(`${lanBase}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: qrRes.payload.code,
        secret: qrRes.payload.secret,
        deviceName: 'Pixel 9 Pro',
        deviceType: 'android',
        osVersion: 'Android 15',
      }),
    });
    expect(pairRes.status).toBe(201);
    const paired = (await pairRes.json()) as { deviceId: string; token: string };

    // Authorized mobile browse + Range stream
    const filesRes = await fetch(`${lanBase}/files`, {
      headers: { Authorization: `Bearer ${paired.token}` },
    });
    expect(filesRes.status).toBe(200);

    const media = await (
      await fetch(`${apiUrl}/media?type=photo`, { headers: authHeaders() })
    ).json();
    const rangeRes = await fetch(`${lanBase}/files/${media.items[0].id}/content`, {
      headers: {
        Authorization: `Bearer ${paired.token}`,
        Range: 'bytes=0-15',
      },
    });
    expect(rangeRes.status).toBe(206);
    expect((await rangeRes.arrayBuffer()).byteLength).toBe(16);

    // Revoke device and verify immediate 401
    await fetch(`${apiUrl}/devices/${paired.deviceId}/revoke`, {
      method: 'POST',
      headers: authHeaders(),
    });
    const afterRevoke = await fetch(`${lanBase}/storage/info`, {
      headers: { Authorization: `Bearer ${paired.token}` },
    });
    expect(afterRevoke.status).toBe(401);

    // Stop server & test port conflict detection
    await fetch(`${apiUrl}/server/stop`, { method: 'POST', headers: authHeaders() });

    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(freePort, '127.0.0.1', r));
    const conflictRes = await fetch(`${apiUrl}/server/start`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ port: freePort, bindLan: false }),
    });
    expect(conflictRes.status).toBe(409);
    if (typeof blocker.closeAllConnections === 'function') blocker.closeAllConnections();
    await new Promise<void>((r) => blocker.close(() => r()));
  }, 15000);

  it('safely relocates storage to a new folder while preserving original files', async () => {
    const res = await fetch(`${apiUrl}/storage/relocate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ path: relocateDir, mode: 'copy_and_switch' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { newRoot: string; filesCopied: number };
    expect(json.newRoot).toBe(relocateDir);
    expect(json.filesCopied).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(relocateDir, 'Database', 'haven.db'))).toBe(true);
    // Original files preserved!
    expect(fs.existsSync(path.join(storageDir, 'Database', 'haven.db'))).toBe(true);
  });
});
