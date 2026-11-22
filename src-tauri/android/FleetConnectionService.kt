package com.isidel.studiolo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class FleetConnectionService : Service() {
    private val manager by lazy { getSystemService(NotificationManager::class.java) }

    override fun onBind(intent: Intent): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        service = this
        startForeground(NOTIFICATION_ID, notification(notice))
        if (notice == null) stopSelfResult(startId)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (service === this) {
            service = null
            starting = false
        }
        super.onDestroy()
    }

    private fun notification(state: FleetConnectionNotice?): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_LOW
            ))
        }
        val text = when (state?.status) {
            "reconnecting" -> if (state.active > 0) "${state.active} 个任务 · 正在重连" else "正在重连"
            "online" -> if (state.active > 0) "${state.active} 个任务正在运行" else "后台已连接"
            else -> "正在连接"
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.studiolo_notification_icon)
            .setContentTitle("Studiolo")
            .setContentText(text)
            .setContentIntent(openSession(this, state?.sessionKey, NOTIFICATION_ID))
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "studiolo.fleet.background"
        private const val NOTIFICATION_ID = 4
        private var notice: FleetConnectionNotice? = null
        private var service: FleetConnectionService? = null
        private var starting = false

        // Only called on the Android main thread, along with the service callbacks.
        fun update(context: Context, state: FleetConnectionNotice): Boolean {
            val intent = Intent(context, FleetConnectionService::class.java)
            if (state.status == null) {
                notice = null
                starting = false
                context.stopService(intent)
                return true
            }
            notice = state
            val running = service
            return try {
                if (running != null) {
                    running.manager.notify(NOTIFICATION_ID, running.notification(state))
                } else if (!starting) {
                    ContextCompat.startForegroundService(context, intent)
                    starting = true
                }
                true
            } catch (_: IllegalStateException) {
                false
            } catch (_: SecurityException) {
                false
            }
        }

        fun openSession(context: Context, sessionKey: String?, requestCode: Int): PendingIntent {
            val intent = Intent(context, MainActivity::class.java)
                .setAction("${context.packageName}.FLEET_SESSION")
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("studiolo.session.key", sessionKey)
            return PendingIntent.getActivity(context, requestCode, intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
    }
}
