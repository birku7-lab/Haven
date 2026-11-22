package com.havenstorage.mobile.worker

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import androidx.work.*
import com.havenstorage.mobile.HavenApplication
import com.havenstorage.mobile.model.SyncReportRequest
import java.util.concurrent.TimeUnit

class HavenSyncWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as HavenApplication
        val cfg = app.prefs.config.value
        if (!cfg.isPaired || !cfg.permissions.uploadFiles) {
            return Result.success()
        }

        return try {
            runCatching { app.api.reconnectAnyCandidate() }
            val syncedKeys = app.prefs.getBackedUpMediaKeys()
            var totalUploaded = 0

            // 1. Evaluate enabled PC Sync Rules that push Android -> PC
            if (cfg.permissions.syncFolders) {
                val syncResp = app.api.getSyncRules()
                val pushRules = syncResp.rules.filter {
                    it.enabled && (it.direction == "one_way_to_pc" || it.direction == "two_way")
                }

                for (rule in pushRules) {
                    val mediaItems = queryMediaStoreMatchingPath(
                        app = app,
                        remotePathFilter = rule.remotePath,
                        exclusions = rule.exclusions
                    )
                    var ruleUploads = 0
                    for (item in mediaItems) {
                        val key = "${rule.id}:${item.id}:${item.size}"
                        if (key in syncedKeys) continue
                        app.api.uploadUriResumable(
                            contentResolver = app.contentResolver,
                            uri = item.contentUri,
                            fileName = item.displayName,
                            totalBytes = item.size,
                            folderId = rule.localFolderId
                        ) {}
                        app.prefs.markMediaBackedUp(key)
                        ruleUploads++
                        totalUploaded++
                    }
                    app.api.reportSyncRun(
                        ruleId = rule.id,
                        report = SyncReportRequest(
                            status = "completed",
                            filesSynced = ruleUploads,
                            conflictsDetected = 0,
                            message = if (ruleUploads > 0) {
                                "Uploaded $ruleUploads new item(s) from ${rule.remotePath}"
                            } else {
                                "Checked ${rule.remotePath}: already up to date"
                            }
                        )
                    )
                }
            }

            // 2. Automatic Camera Roll Backup (when toggled on in Android app)
            if (cfg.autoCameraBackup) {
                val cameraItems = queryMediaStoreMatchingPath(
                    app = app,
                    remotePathFilter = "DCIM/Camera",
                    exclusions = listOf("*.tmp", ".pending-*")
                )
                val foldersResp = app.api.listFiles()
                val photosFolderId = foldersResp.allFolders
                    .firstOrNull { it.relativePath == "Photos" }?.id
                for (item in cameraItems) {
                    val key = "auto_cam:${item.id}:${item.size}"
                    if (key in syncedKeys) continue
                    app.api.uploadUriResumable(
                        contentResolver = app.contentResolver,
                        uri = item.contentUri,
                        fileName = item.displayName,
                        totalBytes = item.size,
                        folderId = if (item.isVideo) {
                            foldersResp.allFolders.firstOrNull { it.relativePath == "Videos" }?.id
                        } else {
                            photosFolderId
                        }
                    ) {}
                    app.prefs.markMediaBackedUp(key)
                    totalUploaded++
                }
            }

            Result.success(workDataOf("uploadedCount" to totalUploaded))
        } catch (_: Exception) {
            Result.retry()
        }
    }

    private data class LocalMediaCandidate(
        val id: Long,
        val displayName: String,
        val size: Long,
        val contentUri: Uri,
        val isVideo: Boolean
    )

    private fun queryMediaStoreMatchingPath(
        app: HavenApplication,
        remotePathFilter: String,
        exclusions: List<String>
    ): List<LocalMediaCandidate> {
        val cleanNeedle = remotePathFilter.trim().trim('/').lowercase()
        val out = mutableListOf<LocalMediaCandidate>()

        fun queryCollection(collection: Uri, isVideo: Boolean) {
            val projection = arrayOf(
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.RELATIVE_PATH
            )
            app.contentResolver.query(
                collection,
                projection,
                null,
                null,
                "${MediaStore.MediaColumns.DATE_ADDED} DESC"
            )?.use { cursor ->
                val idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val nameCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                val pathCol = cursor.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)
                var scanned = 0
                while (cursor.moveToNext() && scanned < 250) {
                    scanned++
                    val id = cursor.getLong(idCol)
                    val name = cursor.getString(nameCol) ?: continue
                    val size = cursor.getLong(sizeCol)
                    if (size <= 0L) continue
                    val relPath = if (pathCol >= 0) cursor.getString(pathCol).orEmpty() else ""
                    if (cleanNeedle.isNotEmpty() && !relPath.lowercase().contains(cleanNeedle)) {
                        continue
                    }
                    if (isExcluded(name, relPath, exclusions)) continue
                    out.add(
                        LocalMediaCandidate(
                            id = id,
                            displayName = name,
                            size = size,
                            contentUri = ContentUris.withAppendedId(collection, id),
                            isVideo = isVideo
                        )
                    )
                }
            }
        }

        queryCollection(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, isVideo = false)
        queryCollection(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, isVideo = true)
        return out
    }

    private fun isExcluded(name: String, relPath: String, exclusions: List<String>): Boolean {
        val target = "$relPath/$name".lowercase()
        return exclusions.any { pattern ->
            val p = pattern.trim().lowercase().removePrefix("*")
            p.isNotEmpty() && (name.lowercase().endsWith(p) || target.contains(p.removeSuffix("/*")))
        }
    }

    companion object {
        private const val PERIODIC_WORK_NAME = "haven_periodic_sync"
        private const val ONESHOT_WORK_NAME = "haven_manual_sync"

        fun schedulePeriodic(context: Context, wifiOnly: Boolean) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                .build()
            val req = PeriodicWorkRequestBuilder<HavenSyncWorker>(6, TimeUnit.HOURS)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                req
            )
        }

        fun runNow(context: Context, wifiOnly: Boolean): OneTimeWorkRequest {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                .build()
            val req = OneTimeWorkRequestBuilder<HavenSyncWorker>()
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONESHOT_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                req
            )
            return req
        }
    }
}
