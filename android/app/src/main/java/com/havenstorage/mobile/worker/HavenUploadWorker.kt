package com.havenstorage.mobile.worker

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.*
import com.havenstorage.mobile.HavenApplication
import com.havenstorage.mobile.R
import com.havenstorage.mobile.network.HavenApiClient
import java.util.concurrent.TimeUnit

class HavenUploadWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val uriStr = inputData.getString(KEY_URI) ?: return Result.failure()
        val folderId = inputData.getString(KEY_FOLDER_ID)
        val uri = Uri.parse(uriStr)
        val app = applicationContext as HavenApplication
        val (fileName, totalBytes) = HavenApiClient.queryFileMetadata(app.contentResolver, uri)

        setForeground(createForegroundInfo(fileName, 0))

        return try {
            val result = app.api.uploadUriResumable(
                contentResolver = app.contentResolver,
                uri = uri,
                fileName = fileName,
                totalBytes = totalBytes,
                folderId = folderId
            ) { tr ->
                val pct = if (tr.totalBytes > 0) {
                    ((tr.transferredBytes * 100L) / tr.totalBytes).toInt().coerceIn(0, 100)
                } else 0
                setProgressAsync(
                    workDataOf(
                        KEY_FILE_NAME to fileName,
                        KEY_PROGRESS_PCT to pct,
                        KEY_TRANSFERRED to tr.transferredBytes,
                        KEY_TOTAL_BYTES to tr.totalBytes,
                        KEY_TRANSFER_ID to tr.id
                    )
                )
            }
            Result.success(
                workDataOf(
                    KEY_FILE_NAME to result.file.name,
                    KEY_PROGRESS_PCT to 100,
                    KEY_FILE_ID to result.file.id
                )
            )
        } catch (e: Exception) {
            if (runAttemptCount < 3) {
                Result.retry()
            } else {
                Result.failure(workDataOf(KEY_ERROR to (e.message ?: "Upload failed")))
            }
        }
    }

    private fun createForegroundInfo(fileName: String, progressPct: Int): ForegroundInfo {
        val nm = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                applicationContext.getString(R.string.channel_transfers_name),
                NotificationManager.IMPORTANCE_LOW
            )
            nm.createNotificationChannel(ch)
        }
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Uploading to Haven PC")
            .setContentText(fileName)
            .setProgress(100, progressPct, progressPct == 0)
            .setOngoing(true)
            .build()

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(
                NOTIFICATION_ID_BASE + (id.hashCode() and 0x0FFF),
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            ForegroundInfo(NOTIFICATION_ID_BASE + (id.hashCode() and 0x0FFF), notification)
        }
    }

    companion object {
        const val CHANNEL_ID = "haven_transfers"
        const val NOTIFICATION_ID_BASE = 4100
        const val KEY_URI = "uri"
        const val KEY_FOLDER_ID = "folder_id"
        const val KEY_FILE_NAME = "file_name"
        const val KEY_PROGRESS_PCT = "progress_pct"
        const val KEY_TRANSFERRED = "transferred_bytes"
        const val KEY_TOTAL_BYTES = "total_bytes"
        const val KEY_TRANSFER_ID = "transfer_id"
        const val KEY_FILE_ID = "file_id"
        const val KEY_ERROR = "error"
        const val TAG_UPLOAD = "haven_upload"

        fun enqueue(
            context: Context,
            uri: Uri,
            folderId: String?,
            wifiOnly: Boolean
        ): OneTimeWorkRequest {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                .build()
            val req = OneTimeWorkRequestBuilder<HavenUploadWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .setInputData(
                    workDataOf(
                        KEY_URI to uri.toString(),
                        KEY_FOLDER_ID to folderId
                    )
                )
                .addTag(TAG_UPLOAD)
                .build()
            WorkManager.getInstance(context).enqueue(req)
            return req
        }
    }
}
