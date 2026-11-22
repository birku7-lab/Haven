package com.havenstorage.mobile.network

import android.content.ContentResolver
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import com.havenstorage.mobile.data.HavenPreferences
import com.havenstorage.mobile.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class HavenApiException(
    val statusCode: Int,
    override val message: String
) : Exception(message)

object HavenProtocolUtils {
    fun buildCandidateBaseUrls(payload: PairingQrPayload): List<String> {
        val urls = linkedSetOf<String>()
        if (payload.host.isNotBlank()) {
            urls.add("http://${payload.host.trim()}:${payload.port}")
        }
        payload.hosts.forEach { ip ->
            val clean = ip.trim()
            if (clean.isNotBlank()) {
                urls.add("http://$clean:${payload.port}")
            }
        }
        return urls.toList()
    }

    fun missingChunks(totalChunks: Int, verifiedChunks: List<Int>): List<Int> {
        val done = verifiedChunks.toSet()
        return (0 until totalChunks).filter { it !in done }
    }

    fun sha256Hex(bytes: ByteArray, length: Int = bytes.size): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(bytes, 0, length)
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}

class HavenApiClient(private val prefs: HavenPreferences) {
    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val octetMediaType = "application/octet-stream".toMediaType()

    val okHttp: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val original = chain.request()
            val token = prefs.config.value.token
            val req = if (token.isNotBlank() && original.header("Authorization") == null) {
                original.newBuilder()
                    .header("Authorization", "Bearer $token")
                    .build()
            } else {
                original
            }
            chain.proceed(req)
        }
        .build()

    private fun baseUrl(): String {
        val url = prefs.config.value.serverUrl
        if (url.isBlank()) throw HavenApiException(0, "Not paired to a Haven PC server")
        return url.trimEnd('/')
    }

    fun thumbnailUrl(fileId: String): String = "${baseUrl()}/api/v1/files/$fileId/thumbnail"

    fun contentUrl(fileId: String, download: Boolean = false): String {
        val base = "${baseUrl()}/api/v1/files/$fileId/content"
        return if (download) "$base?download=1" else base
    }

    suspend fun probeHealth(serverBaseUrl: String): HealthResponse = withContext(Dispatchers.IO) {
        val clean = serverBaseUrl.trimEnd('/')
        val req = Request.Builder().url("$clean/api/v1/health").get().build()
        okHttp.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                throw HavenApiException(res.code, extractError(body, res.code))
            }
            json.decodeFromString<HealthResponse>(body)
        }
    }

    suspend fun pairWithQrPayload(payload: PairingQrPayload, customDeviceName: String? = null): PairResponse =
        withContext(Dispatchers.IO) {
            val candidates = HavenProtocolUtils.buildCandidateBaseUrls(payload)
            if (candidates.isEmpty()) {
                throw HavenApiException(0, "QR payload has no valid LAN IP address")
            }

            var reachableBase: String? = null
            var lastError: Exception? = null
            for (url in candidates) {
                try {
                    probeHealth(url)
                    reachableBase = url
                    break
                } catch (e: Exception) {
                    lastError = e
                }
            }
            val selectedUrl = reachableBase
                ?: throw HavenApiException(
                    0,
                    "Unable to reach Haven PC on Wi-Fi (${candidates.joinToString(", ")}). ${lastError?.message.orEmpty()}"
                )

            val devName = customDeviceName?.takeIf { it.isNotBlank() }
                ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
            val reqBody = json.encodeToString(
                PairRequest(
                    code = payload.code.trim(),
                    secret = payload.secret.trim(),
                    deviceName = devName.take(80),
                    deviceType = "android",
                    osVersion = "Android ${Build.VERSION.RELEASE}"
                )
            )
            val req = Request.Builder()
                .url("$selectedUrl/api/v1/pair")
                .post(reqBody.toRequestBody(jsonMediaType))
                .build()
            val pairResp = okHttp.newCall(req).execute().use { res ->
                val body = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    throw HavenApiException(res.code, extractError(body, res.code))
                }
                json.decodeFromString<PairResponse>(body)
            }
            prefs.savePairing(
                serverUrl = selectedUrl,
                candidateUrls = candidates,
                deviceId = pairResp.deviceId,
                token = pairResp.token,
                serverName = pairResp.serverName,
                permissions = pairResp.permissions
            )
            pairResp
        }

    suspend fun reconnectAnyCandidate(): String = withContext(Dispatchers.IO) {
        val cfg = prefs.config.value
        val ordered = (listOf(cfg.serverUrl) + cfg.candidateUrls).filter { it.isNotBlank() }.distinct()
        for (url in ordered) {
            try {
                probeHealth(url)
                if (url != cfg.serverUrl) {
                    prefs.updateServerUrl(url)
                }
                return@withContext url
            } catch (_: Exception) {
                // try next host
            }
        }
        throw HavenApiException(0, "Haven PC server is offline or unreachable on this Wi-Fi network")
    }

    suspend fun getStorageInfo(): StorageInfoResponse = getJson("/api/v1/storage/info")

    suspend fun listFiles(
        folderId: String? = null,
        search: String? = null,
        category: String? = null,
        favorites: Boolean = false,
        recent: Boolean = false,
        sortBy: String = "name",
        sortDir: String = "asc"
    ): FilesResponse {
        val urlBuilder = "${baseUrl()}/api/v1/files".toHttpUrlOrNull()!!.newBuilder()
        if (!folderId.isNullOrBlank()) urlBuilder.addQueryParameter("folderId", folderId)
        if (!search.isNullOrBlank()) urlBuilder.addQueryParameter("search", search)
        if (!category.isNullOrBlank() && category != "all") urlBuilder.addQueryParameter("category", category)
        if (favorites) urlBuilder.addQueryParameter("favorites", "1")
        if (recent) urlBuilder.addQueryParameter("recent", "1")
        urlBuilder.addQueryParameter("sortBy", sortBy)
        urlBuilder.addQueryParameter("sortDir", sortDir)
        return executeJson(Request.Builder().url(urlBuilder.build()).get().build())
    }

    suspend fun getMedia(
        type: String = "all",
        favorites: Boolean = false,
        search: String? = null
    ): MediaResponse {
        val urlBuilder = "${baseUrl()}/api/v1/media".toHttpUrlOrNull()!!.newBuilder()
            .addQueryParameter("type", type)
            .addQueryParameter("sortBy", "modifiedAt")
            .addQueryParameter("sortDir", "desc")
        if (favorites) urlBuilder.addQueryParameter("favorites", "1")
        if (!search.isNullOrBlank()) urlBuilder.addQueryParameter("search", search)
        return executeJson(Request.Builder().url(urlBuilder.build()).get().build())
    }

    suspend fun createFolder(name: String, parentId: String?): FolderRecord {
        val body = json.encodeToString(CreateFolderRequest(name = name, parentId = parentId))
        val req = Request.Builder()
            .url("${baseUrl()}/api/v1/folders")
            .post(body.toRequestBody(jsonMediaType))
            .build()
        return executeJson(req)
    }

    suspend fun updateFile(
        fileId: String,
        name: String? = null,
        isFavorite: Boolean? = null
    ): FileRecord {
        val body = json.encodeToString(UpdateFileRequest(name = name, isFavorite = isFavorite))
        val req = Request.Builder()
            .url("${baseUrl()}/api/v1/files/$fileId")
            .patch(body.toRequestBody(jsonMediaType))
            .build()
        return executeJson(req)
    }

    suspend fun deleteFile(fileId: String): FileRecord {
        val req = Request.Builder()
            .url("${baseUrl()}/api/v1/files/$fileId")
            .delete()
            .build()
        return executeJson(req)
    }

    suspend fun getTransfer(transferId: String): TransferRecord =
        getJson("/api/v1/transfers/$transferId")

    suspend fun initUpload(request: UploadInitRequest): TransferRecord {
        val body = json.encodeToString(request)
        val req = Request.Builder()
            .url("${baseUrl()}/api/v1/transfers/upload")
            .post(body.toRequestBody(jsonMediaType))
            .build()
        return executeJson(req)
    }

    suspend fun uploadChunk(
        transferId: String,
        chunkIndex: Int,
        data: ByteArray,
        length: Int,
        sha256Hex: String
    ): TransferRecord = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("${baseUrl()}/api/v1/transfers/$transferId/chunks/$chunkIndex")
            .header("X-Chunk-Sha256", sha256Hex)
            .put(data.toRequestBody(octetMediaType, 0, length))
            .build()
        executeJson(req)
    }

    suspend fun completeUpload(transferId: String): UploadCompleteResponse {
        val req = Request.Builder()
            .url("${baseUrl()}/api/v1/transfers/$transferId/complete")
            .post("{}".toRequestBody(jsonMediaType))
            .build()
        return executeJson(req)
    }

    /**
     * Streams any Android ContentResolver URI in fixed 4 MiB chunks cleanly.
     * Supports resuming interrupted sessions via GET /api/v1/transfers/{id} without
     * re-sending already verified chunks or loading multi-GB files into memory.
     */
    suspend fun uploadUriResumable(
        contentResolver: ContentResolver,
        uri: Uri,
        fileName: String,
        totalBytes: Long,
        folderId: String?,
        onProgress: (TransferRecord) -> Unit
    ): UploadCompleteResponse = withContext(Dispatchers.IO) {
        val uriKey = uri.toString()
        val existingId = prefs.getResumableTransfer(uriKey)
        var session: TransferRecord? = existingId?.let { tid ->
            runCatching { getTransfer(tid) }
                .getOrNull()
                ?.takeIf { it.status !in listOf("completed", "cancelled", "failed") && it.totalBytes == totalBytes }
        }

        if (session == null) {
            val created = initUpload(
                UploadInitRequest(
                    fileName = fileName,
                    totalBytes = totalBytes,
                    folderId = folderId,
                    chunkSize = DEFAULT_CHUNK_SIZE
                )
            )
            prefs.saveResumableTransfer(uriKey, created.id)
            session = created
        }

        onProgress(session)
        val verifiedSet = session.verifiedChunks.toSet()
        val chunkSizeInt = session.chunkSize.toInt().coerceAtLeast(64 * 1024)
        val buffer = ByteArray(chunkSizeInt)

        contentResolver.openInputStream(uri)?.use { stream ->
            for (index in 0 until session.totalChunks) {
                val expectedChunkLen = if (index == session.totalChunks - 1) {
                    (totalBytes - index.toLong() * session.chunkSize).toInt().coerceAtLeast(0)
                } else {
                    chunkSizeInt
                }
                val readBytes = readFully(stream, buffer, expectedChunkLen)
                if (index in verifiedSet) {
                    continue
                }
                val chunkHash = HavenProtocolUtils.sha256Hex(buffer, readBytes)
                session = uploadChunk(session!!.id, index, buffer, readBytes, chunkHash)
                onProgress(session!!)
            }
        } ?: throw HavenApiException(0, "Unable to open local file for upload")

        val completed = completeUpload(session!!.id)
        prefs.clearResumableTransfer(uriKey)
        onProgress(completed.transfer)
        completed
    }

    suspend fun downloadFile(
        file: FileRecord,
        destFile: File,
        onProgress: (bytesRead: Long, totalBytes: Long) -> Unit
    ): File = withContext(Dispatchers.IO) {
        destFile.parentFile?.mkdirs()
        val req = Request.Builder()
            .url(contentUrl(file.id, download = true))
            .get()
            .build()
        okHttp.newCall(req).execute().use { res ->
            if (!res.isSuccessful) {
                throw HavenApiException(res.code, extractError(res.body?.string().orEmpty(), res.code))
            }
            val body = res.body ?: throw HavenApiException(res.code, "Empty response body")
            val total = body.contentLength().takeIf { it > 0 } ?: file.size
            val buf = ByteArray(64 * 1024)
            var downloaded = 0L
            body.byteStream().use { input ->
                FileOutputStream(destFile).use { output ->
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        output.write(buf, 0, n)
                        downloaded += n
                        onProgress(downloaded, total)
                    }
                }
            }
            destFile
        }
    }

    suspend fun getSyncRules(): SyncRulesResponse = getJson("/api/v1/sync/rules")

    suspend fun reportSyncRun(ruleId: String, report: SyncReportRequest): SyncReportResponse {
        val body = json.encodeToString(report)
        val req = Request.Builder()
            .url("${baseUrl()}/api/v1/sync/rules/$ruleId/report")
            .post(body.toRequestBody(jsonMediaType))
            .build()
        return executeJson(req)
    }

    private fun readFully(input: InputStream, buffer: ByteArray, targetBytes: Int): Int {
        var offset = 0
        while (offset < targetBytes) {
            val read = input.read(buffer, offset, targetBytes - offset)
            if (read == -1) break
            offset += read
        }
        return offset
    }

    private suspend inline fun <reified T> getJson(path: String): T {
        val req = Request.Builder().url("${baseUrl()}$path").get().build()
        return executeJson(req)
    }

    private suspend inline fun <reified T> executeJson(request: Request): T = withContext(Dispatchers.IO) {
        okHttp.newCall(request).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (res.code == 401) {
                throw HavenApiException(401, "Device access expired or revoked on Haven PC")
            }
            if (!res.isSuccessful) {
                throw HavenApiException(res.code, extractError(body, res.code))
            }
            json.decodeFromString<T>(body)
        }
    }

    private fun extractError(body: String, code: Int): String {
        if (body.isNotBlank()) {
            runCatching {
                return json.decodeFromString<ErrorResponse>(body).error
            }
        }
        return "Server returned HTTP $code"
    }

    companion object {
        const val DEFAULT_CHUNK_SIZE = 4L * 1024L * 1024L

        fun queryFileMetadata(contentResolver: ContentResolver, uri: Uri): Pair<String, Long> {
            var name = "upload_${System.currentTimeMillis()}"
            var size = 0L
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (nameIdx >= 0) name = cursor.getString(nameIdx) ?: name
                        if (sizeIdx >= 0) size = cursor.getLong(sizeIdx)
                    }
                }
            if (size <= 0L) {
                contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                    if (afd.length > 0) size = afd.length
                }
            }
            return name to size
        }
    }
}
