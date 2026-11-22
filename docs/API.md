# Haven Personal Storage Ecosystem — API Documentation (v1.0)

Haven exposes an authenticated REST API (`/api/v1`) served both locally to the desktop console and over the local network (LAN) by the configurable storage server (`serverPort`, default `48720`) for future mobile clients (Stage 2 Android app).

---

## 1. Security & Authentication Model

### Desktop Console Authentication (`/auth/*`)
- First-run admin passcode setup via `POST /api/v1/auth/setup` (or `HAVEN_ADMIN_PASSCODE` env override in web/server mode).
- Passcode hashed with salted `scrypt` (Node runtime) / 10,000-round salted SHA-256 (Rust native runtime).
- Interactive login returns an opaque Bearer session token held strictly in memory (`Authorization: Bearer <token>`).

### Mobile / LAN Client Authentication (`/pair` + Device Bearer Tokens)
- LAN endpoints require `Authorization: Bearer hvn_<64_hex_chars>`.
- Tokens are generated only upon consuming a single-use, 5-minute expiring QR pairing session (`POST /api/v1/devices/pairing-qr` -> `POST /api/v1/pair`).
- Only SHA-256 token hashes are stored in SQLite (`devices.token_hash`).
- Revoking a device (`POST /api/v1/devices/{id}/revoke`) immediately rejects subsequent requests with `401 Unauthorized`.
- Every endpoint checks fine-grained device permissions (`readFiles`, `uploadFiles`, `deleteFiles`, `streamMedia`, `syncFolders`) and enforces `403 Forbidden` if disabled.
- Rate limiting is enabled on LAN authentication (`20 req/min`) and general API traffic (`600 req/min`).

---

## 2. LAN & Stage 2 Mobile Client Endpoints

### Health Check
`GET /api/v1/health` (unauthenticated)
```json
{
  "service": "haven-storage-server",
  "protocolVersion": "1.0",
  "setupCompleted": true,
  "timestamp": "2026-11-21T19:00:00.000Z"
}
```

### QR Device Pairing
`POST /api/v1/pair` (unauthenticated, consumes one-time QR secret)

**Request:**
```json
{
  "code": "482910",
  "secret": "a1b2c3...",
  "deviceName": "Pixel 9 Pro",
  "deviceType": "android",
  "osVersion": "Android 15"
}
```
**Response (`201 Created`):**
```json
{
  "deviceId": "f9a1c2...",
  "token": "hvn_92d8f...",
  "permissions": {
    "readFiles": true,
    "uploadFiles": true,
    "deleteFiles": false,
    "streamMedia": true,
    "syncFolders": true
  },
  "serverName": "DESKTOP-HOME"
}
```

### Storage Volume Info
`GET /api/v1/storage/info` (`Authorization: Bearer hvn_...`)
```json
{
  "storageRoot": "D:\\HavenStorage",
  "volume": { "totalBytes": 1000202039296, "freeBytes": 812400120832, "usedBytes": 187801918464, "available": true },
  "totalFiles": 124,
  "totalFolders": 14,
  "totalManagedBytes": 4294967296
}
```

### Browse Files & Folders
`GET /api/v1/files?folderId=<id>&search=<query>` (requires `readFiles`)
Returns `{ "folders": FolderRecord[], "files": FileRecord[] }`.

### Download & HTTP Range Media Streaming
`GET /api/v1/files/{id}/content` (requires `readFiles`, plus `streamMedia` for `video`/`audio`)
- Supports `Range: bytes=start-end` returning `206 Partial Content` + `Content-Range` + `Accept-Ranges: bytes`.
- Pass `?download=1` to set `Content-Disposition: attachment` and log a download transfer session.

### WebP Thumbnails
`GET /api/v1/files/{id}/thumbnail` (requires `readFiles`)
Returns `image/webp` thumbnail (`360px` max dimension) stored in `HavenStorage/Thumbnails/`.

### Resumable Chunked Upload (Supports 10GB+ Files)
1. **Initialize session** — `POST /api/v1/transfers/upload` (requires `uploadFiles`):
```json
{
  "fileName": "backup-video.mp4",
  "totalBytes": 10737418240,
  "folderId": null,
  "chunkSize": 4194304,
  "sha256Expected": "optional-full-file-sha256"
}
```
2. **Stream chunk directly to disk** (`Temp/{id}.part`) — `PUT /api/v1/transfers/{id}/chunks/{index}`
   - `Content-Type: application/octet-stream`
   - Optional header `X-Chunk-Sha256: <hex>` (returns `400` if mismatch)
   - Tracked in SQLite `transfers.verified_chunks_json` so interrupted uploads resume from the last verified chunk.
3. **Finalize & verify** — `POST /api/v1/transfers/{id}/complete`
   - Computes full-file SHA-256, verifies against `sha256Expected` if supplied, atomically moves payload to target folder, generates thumbnail, and inserts `files` record.

---

## 3. Desktop Console Endpoints

- `GET /api/v1/auth/status`, `POST /api/v1/auth/setup`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/{id}`
- `GET /api/v1/setup/drives`, `POST /api/v1/setup/validate`, `POST /api/v1/setup/initialize`, `POST /api/v1/storage/relocate`
- `GET /api/v1/dashboard`
- `GET /api/v1/files`, `POST /api/v1/folders`, `PATCH /api/v1/folders/{id}`, `DELETE /api/v1/folders/{id}`
- `GET /api/v1/files/{id}`, `PATCH /api/v1/files/{id}`, `POST /api/v1/files/{id}/move`, `POST /api/v1/files/{id}/copy`, `DELETE /api/v1/files/{id}`, `POST /api/v1/files/batch-delete`, `POST /api/v1/files/{id}/open`
- `GET /api/v1/media`
- `GET /api/v1/transfers`, `POST /api/v1/transfers/{id}/{pause|resume|retry|cancel}`, `DELETE /api/v1/transfers/history`
- `GET /api/v1/analytics`, `GET /api/v1/scanner/status`, `POST /api/v1/scanner/start`
- `GET /api/v1/recycle-bin`, `POST /api/v1/recycle-bin/{id}/restore`, `DELETE /api/v1/recycle-bin/{id}`, `POST /api/v1/recycle-bin/empty`
- `GET /api/v1/server/status`, `POST /api/v1/server/start`, `POST /api/v1/server/stop`, `PATCH /api/v1/server/config`
- `GET /api/v1/devices`, `POST /api/v1/devices/pairing-qr`, `PATCH /api/v1/devices/{id}/permissions`, `POST /api/v1/devices/{id}/revoke`, `DELETE /api/v1/devices/{id}`
- `GET /api/v1/sync`, `POST /api/v1/sync/rules`, `DELETE /api/v1/sync/rules/{id}`
- `GET /api/v1/settings`, `PATCH /api/v1/settings`
- `GET /api/v1/database/status`, `POST /api/v1/database/backup`, `POST /api/v1/database/restore`, `POST /api/v1/database/integrity`, `POST /api/v1/database/rebuild`
- `GET /api/v1/logs`, `GET /api/v1/logs/export`
