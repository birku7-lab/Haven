package com.havenstorage.mobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import com.havenstorage.mobile.data.HavenPreferences
import com.havenstorage.mobile.network.HavenApiClient
import com.havenstorage.mobile.worker.HavenSyncWorker
import com.havenstorage.mobile.worker.HavenUploadWorker

class HavenApplication : Application(), SingletonImageLoader.Factory {
    lateinit var prefs: HavenPreferences
        private set
    lateinit var api: HavenApiClient
        private set

    override fun onCreate() {
        super.onCreate()
        prefs = HavenPreferences(this)
        api = HavenApiClient(prefs)
        createNotificationChannel()
        if (prefs.config.value.isPaired) {
            HavenSyncWorker.schedulePeriodic(this, prefs.config.value.wifiOnly)
        }
    }

    override fun newImageLoader(context: android.content.Context): ImageLoader {
        return ImageLoader.Builder(context)
            .components {
                add(OkHttpNetworkFetcherFactory(callFactory = { api.okHttp }))
            }
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            val ch = NotificationChannel(
                HavenUploadWorker.CHANNEL_ID,
                getString(R.string.channel_transfers_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.channel_transfers_desc)
            }
            nm.createNotificationChannel(ch)
        }
    }
}
