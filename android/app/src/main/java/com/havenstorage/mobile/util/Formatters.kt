package com.havenstorage.mobile.util

import java.util.Locale

fun formatBytes(bytes: Long): String {
    if (bytes <= 0L) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var unitIdx = 0
    while (value >= 1024.0 && unitIdx < units.lastIndex) {
        value /= 1024.0
        unitIdx++
    }
    return if (unitIdx == 0) {
        "$bytes B"
    } else {
        String.format(Locale.US, "%.1f %s", value, units[unitIdx])
    }
}

fun shortDate(iso: String?): String {
    if (iso.isNullOrBlank()) return "—"
    return iso.replace("T", " ").take(16)
}
