package com.havenstorage.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val HavenBackground = Color(0xFF18181B)
val HavenSurface = Color(0xFF1F1F23)
val HavenSurfaceElevated = Color(0xFF27272C)
val HavenPrimary = Color(0xFF3B82F6)
val HavenSuccess = Color(0xFF22C55E)
val HavenWarning = Color(0xFFF59E0B)
val HavenError = Color(0xFFEF4444)
val HavenBorder = Color(0x14FFFFFF)
val HavenTextPrimary = Color(0xFFF4F4F5)
val HavenTextSecondary = Color(0xFFA1A1AA)

private val HavenColorScheme = darkColorScheme(
    primary = HavenPrimary,
    onPrimary = Color.White,
    secondary = Color(0xFF60A5FA),
    background = HavenBackground,
    onBackground = HavenTextPrimary,
    surface = HavenSurface,
    onSurface = HavenTextPrimary,
    surfaceVariant = HavenSurfaceElevated,
    onSurfaceVariant = HavenTextSecondary,
    error = HavenError,
    outline = HavenBorder
)

val HavenTypography = Typography(
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.3).sp),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
    bodyMedium = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal),
    bodySmall = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Normal, color = HavenTextSecondary),
    labelMedium = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium, fontFamily = FontFamily.Monospace)
)

@Composable
fun HavenTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = HavenColorScheme,
        typography = HavenTypography,
        content = content
    )
}
