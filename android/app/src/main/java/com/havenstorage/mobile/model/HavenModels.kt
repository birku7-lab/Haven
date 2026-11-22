package com.havenstorage.mobile.model

import kotlinx.serialization.Serializable

@Serializable
data class PairingQrPayload(
    val protocol: String = "",
    val host: String = "",
    val hosts: List<String> = emptyList(),
    val port: Int = 48720,
    val serverRunning: Boolean = true,
    val code: String = "",
    val secret: String = "",
    val expiresAt: String = ""
)

@Serializable
data class PairRequest(
    val code: String,
    val secret: String,
    val deviceName: String,
    val deviceType: String = "android",
    val osVersion: String
)

@Serializable
data class DevicePermissions(
    val readFiles: Boolean = true,
    val uploadFiles: Boolean = true,
    val deleteFiles: Boolean = false,
    val streamMedia: Boolean = true,
    val syncFolders: Boolean = true
)

@Serializable
data class PairResponse(
    val deviceId: String,
    val token: String,
    val permissions: DevicePermissions,
    val serverName: String = "Haven PC"
)

@Serializable
data class HealthResponse(
    val service: String = "",
    val protocolVersion: String = "1.0",
    val setupCompleted: Boolean = false,
    val timestamp: String = ""
)

@Serializable
data class VolumeStats(
    val totalBytes: Long = 0L,
    val freeBytes: Long = 0L,
    val usedBytes: Long = 0L,
    val available: Boolean = true
)

@Serializable
data class StorageInfoResponse(
    val serverName: String = "Haven PC",
    val storageRoot: String = "",
    val volume: VolumeStats = VolumeStats(),
    val totalFiles: Long = 0L,
    val totalFolders: Long = 0L,
    val totalManagedBytes: Long = 0L
)

@Serializable
data class FolderRecord(
    val id: String,
    val name: String,
    val relativePath: String,
    val parentId: String? = null,
    val createdAt: String = "",
    val modifiedAt: String = "",
    val isFavorite: Boolean = false,
    val deviceOrigin: String = "windows-pc"
)

@Serializable
data class FileRecord(
    val id: String,
    val name: String,
    val relativePath: String,
    val folderId: String? = null,
    val size: Long = 0L,
    val mimeType: String = "application/octet-stream",
    val category: String = "other",
    val extension: String = "",
    val createdAt: String = "",
    val modifiedAt: String = "",
    val importedAt: String = "",
    val sha256: String? = null,
    val thumbnailPath: String? = null,
    val isFavorite: Boolean = false,
    val tags: List<String> = emptyList(),
    val backupStatus: String = "local_only",
    val deviceOrigin: String = "windows-pc",
    val transferStatus: String = "complete",
    val isDeleted: Boolean = false
)

@Serializable
data class BreadcrumbItem(
    val id: String? = null,
    val name: String = "HavenStorage"
)

@Serializable
data class FilesResponse(
    val folders: List<FolderRecord> = emptyList(),
    val files: List<FileRecord> = emptyList(),
    val breadcrumbs: List<BreadcrumbItem> = emptyList(),
    val allFolders: List<FolderRecord> = emptyList()
)

@Serializable
data class MediaAlbum(
    val folderId: String? = null,
    val name: String = "Library Root",
    val count: Int = 0,
    val coverId: String = ""
)

@Serializable
data class MediaCounts(
    val photos: Int = 0,
    val videos: Int = 0
)

@Serializable
data class MediaResponse(
    val items: List<FileRecord> = emptyList(),
    val albums: List<MediaAlbum> = emptyList(),
    val counts: MediaCounts = MediaCounts()
)

@Serializable
data class CreateFolderRequest(
    val name: String,
    val parentId: String? = null
)

@Serializable
data class UpdateFileRequest(
    val name: String? = null,
    val isFavorite: Boolean? = null,
    val tags: List<String>? = null
)

@Serializable
data class TransferRecord(
    val id: String,
    val direction: String = "upload",
    val fileId: String? = null,
    val fileName: String,
    val targetRelativePath: String = "",
    val folderId: String? = null,
    val totalBytes: Long = 0L,
    val transferredBytes: Long = 0L,
    val chunkSize: Long = 4L * 1024L * 1024L,
    val totalChunks: Int = 1,
    val verifiedChunks: List<Int> = emptyList(),
    val status: String = "queued",
    val speedBps: Long = 0L,
    val etaSeconds: Long? = null,
    val sha256Expected: String? = null,
    val sha256Actual: String? = null,
    val retryCount: Int = 0,
    val maxRetries: Int = 3,
    val errorMessage: String? = null,
    val deviceId: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
    val completedAt: String? = null
)

@Serializable
data class UploadInitRequest(
    val fileName: String,
    val totalBytes: Long,
    val folderId: String? = null,
    val chunkSize: Long = 4L * 1024L * 1024L,
    val sha256Expected: String? = null
)

@Serializable
data class UploadCompleteResponse(
    val transfer: TransferRecord,
    val file: FileRecord
)

@Serializable
data class SyncRuleRecord(
    val id: String,
    val deviceId: String? = null,
    val name: String,
    val direction: String,
    val localFolderId: String? = null,
    val localFolderPath: String = "Files",
    val remotePath: String,
    val exclusions: List<String> = emptyList(),
    val conflictPolicy: String = "keep_both",
    val enabled: Boolean = true,
    val status: String = "idle",
    val lastSyncAt: String? = null,
    val createdAt: String = ""
)

@Serializable
data class SyncRulesResponse(
    val rules: List<SyncRuleRecord> = emptyList(),
    val allFolders: List<FolderRecord> = emptyList()
)

@Serializable
data class SyncReportRequest(
    val status: String = "completed",
    val filesSynced: Int = 0,
    val conflictsDetected: Int = 0,
    val message: String? = null
)

@Serializable
data class SyncReportResponse(
    val rule: SyncRuleRecord? = null
)

@Serializable
data class ErrorResponse(
    val error: String = "Unknown error"
)
