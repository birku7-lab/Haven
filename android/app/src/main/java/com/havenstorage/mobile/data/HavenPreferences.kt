package com.havenstorage.mobile.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.havenstorage.mobile.model.DevicePermissions
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

data class PairedServerConfig(
    val serverUrl: String = "",
    val candidateUrls: List<String> = emptyList(),
    val deviceId: String = "",
    val token: String = "",
    val serverName: String = "Haven PC",
    val permissions: DevicePermissions = DevicePermissions(),
    val wifiOnly: Boolean = true,
    val autoCameraBackup: Boolean = false
) {
    val isPaired: Boolean
        get() = serverUrl.isNotBlank() && token.isNotBlank()
}

class HavenPreferences(context: Context) {
    private val json = Json { ignoreUnknownKeys = true }

    private val prefs: SharedPreferences = createSecurePrefs(context.applicationContext)

    private val _config = MutableStateFlow(loadConfig())
    val config: StateFlow<PairedServerConfig> = _config.asStateFlow()

    private fun createSecurePrefs(appContext: Context): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(appContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                appContext,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (_: Exception) {
            appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        }
    }

    private fun loadConfig(): PairedServerConfig {
        val permStr = prefs.getString(KEY_PERMISSIONS, null)
        val perms = if (permStr != null) {
            runCatching { json.decodeFromString<DevicePermissions>(permStr) }
                .getOrDefault(DevicePermissions())
        } else {
            DevicePermissions()
        }
        val candidatesRaw = prefs.getString(KEY_CANDIDATE_URLS, null)
        val candidates = if (candidatesRaw != null) {
            runCatching { json.decodeFromString<List<String>>(candidatesRaw) }.getOrDefault(emptyList())
        } else {
            emptyList()
        }
        return PairedServerConfig(
            serverUrl = prefs.getString(KEY_SERVER_URL, "") ?: "",
            candidateUrls = candidates,
            deviceId = prefs.getString(KEY_DEVICE_ID, "") ?: "",
            token = prefs.getString(KEY_TOKEN, "") ?: "",
            serverName = prefs.getString(KEY_SERVER_NAME, "Haven PC") ?: "Haven PC",
            permissions = perms,
            wifiOnly = prefs.getBoolean(KEY_WIFI_ONLY, true),
            autoCameraBackup = prefs.getBoolean(KEY_AUTO_CAMERA_BACKUP, false)
        )
    }

    fun savePairing(
        serverUrl: String,
        candidateUrls: List<String>,
        deviceId: String,
        token: String,
        serverName: String,
        permissions: DevicePermissions
    ) {
        prefs.edit()
            .putString(KEY_SERVER_URL, serverUrl.trimEnd('/'))
            .putString(KEY_CANDIDATE_URLS, json.encodeToString(candidateUrls))
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_TOKEN, token)
            .putString(KEY_SERVER_NAME, serverName)
            .putString(KEY_PERMISSIONS, json.encodeToString(permissions))
            .apply()
        _config.value = loadConfig()
    }

    fun updateServerUrl(url: String) {
        prefs.edit().putString(KEY_SERVER_URL, url.trimEnd('/')).apply()
        _config.value = loadConfig()
    }

    fun updatePermissions(permissions: DevicePermissions) {
        prefs.edit().putString(KEY_PERMISSIONS, json.encodeToString(permissions)).apply()
        _config.value = loadConfig()
    }

    fun setWifiOnly(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_WIFI_ONLY, enabled).apply()
        _config.value = loadConfig()
    }

    fun setAutoCameraBackup(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_AUTO_CAMERA_BACKUP, enabled).apply()
        _config.value = loadConfig()
    }

    fun clearPairing() {
        prefs.edit()
            .remove(KEY_SERVER_URL)
            .remove(KEY_CANDIDATE_URLS)
            .remove(KEY_DEVICE_ID)
            .remove(KEY_TOKEN)
            .remove(KEY_SERVER_NAME)
            .remove(KEY_PERMISSIONS)
            .apply()
        _config.value = loadConfig()
    }

    fun getBackedUpMediaKeys(): Set<String> {
        return prefs.getStringSet(KEY_BACKED_UP_KEYS, emptySet()) ?: emptySet()
    }

    fun markMediaBackedUp(mediaKey: String) {
        val current = getBackedUpMediaKeys().toMutableSet()
        current.add(mediaKey)
        prefs.edit().putStringSet(KEY_BACKED_UP_KEYS, current).apply()
    }

    fun saveResumableTransfer(localUriString: String, transferId: String) {
        prefs.edit().putString("$KEY_RESUMABLE_PREFIX$localUriString", transferId).apply()
    }

    fun getResumableTransfer(localUriString: String): String? {
        return prefs.getString("$KEY_RESUMABLE_PREFIX$localUriString", null)
    }

    fun clearResumableTransfer(localUriString: String) {
        prefs.edit().remove("$KEY_RESUMABLE_PREFIX$localUriString").apply()
    }

    companion object {
        private const val PREFS_NAME = "haven_secure_prefs"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_CANDIDATE_URLS = "candidate_urls"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_TOKEN = "bearer_token"
        private const val KEY_SERVER_NAME = "server_name"
        private const val KEY_PERMISSIONS = "permissions_json"
        private const val KEY_WIFI_ONLY = "wifi_only"
        private const val KEY_AUTO_CAMERA_BACKUP = "auto_camera_backup"
        private const val KEY_BACKED_UP_KEYS = "backed_up_media_keys"
        private const val KEY_RESUMABLE_PREFIX = "resume_tid_"
    }
}
