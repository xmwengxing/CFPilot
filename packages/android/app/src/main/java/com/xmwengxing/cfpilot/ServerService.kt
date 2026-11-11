package com.xmwengxing.cfpilot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONObject

/**
 * 本地服务的前台服务。
 *
 * ## 为什么必须是前台服务
 *
 * Go 内核以 .so 的形式加载在**应用进程**里，界面用 WebView 访问
 * `http://127.0.0.1:19726`。进程一被系统回收，界面立刻打不开。
 *
 * 安卓的后台进程回收非常激进（尤其是息屏一段时间后），
 * 所以要让服务常驻，只能走**前台服务 + 常驻通知**这一条路。
 *
 * ## 与定时优选的关系
 *
 * 手机上**不做**定时优选任务 —— 安卓不允许后台长期跑定时任务，
 * Doze / App Standby 随时会把进程冻住，做了也是白做。
 * 定时优选交给常驻的容器形态（NAS / 小主机）做，两边分工明确。
 */
class ServerService : Service() {

    companion object {
        private const val TAG = "CFPilot"
        private const val CHANNEL_ID = "cfpilot_service"
        private const val NOTIFICATION_ID = 1001

        /**
         * 进程内共享的服务状态。
         *
         * Go 内核本来就是**进程内单例**（一个进程一个本地服务），
         * 所以这里不需要跨进程通信 —— 一个伴生对象就够了。
         */
        @Volatile
        @JvmStatic
        var url: String? = null

        @Volatile
        @JvmStatic
        var error: String? = null

        @Volatile
        @JvmStatic
        var started = false

        /** 通知里显示的地址（不含令牌 —— 通知栏是公开的） */
        @Volatile
        @JvmStatic
        var displayAddress: String? = null
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        // ⚠️ 必须**先** startForeground 再做可能耗时的初始化 ——
        //    安卓要求前台服务在 5 秒内调用 startForeground，否则 ANR / 崩溃。
        startForegroundCompat()

        // 起内核。放在后台线程：JNI 调用会做目录准备与端口监听，别卡住主线程。
        Thread {
            val dir = filesDir.absolutePath
            val raw = try {
                NativeBridge.nativeStart(dir)
            } catch (e: Throwable) {
                Log.e(TAG, "启动内核失败", e)
                "{\"error\":\"${e.message ?: e.javaClass.simpleName}\"}"
            }
            try {
                val obj = JSONObject(raw)
                if (obj.has("error")) {
                    error = obj.optString("error")
                    Log.e(TAG, "内核启动失败：$error")
                } else {
                    url = obj.optString("url")
                    displayAddress = obj.optString("url").substringBefore("?t=")
                    error = null
                    started = true
                    Log.i(TAG, "内核已启动：$displayAddress")
                }
            } catch (e: Throwable) {
                error = "内核返回异常：${e.message}"
                Log.e(TAG, "解析内核返回值失败", e)
            }
            updateNotification()
        }.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY：进程被回收后系统会重建服务 → 界面重新打开就能用
        return START_STICKY
    }

    override fun onDestroy() {
        try {
            NativeBridge.nativeStop()
        } catch (e: Throwable) {
            Log.e(TAG, "停止内核失败", e)
        }
        started = false
        url = null
        super.onDestroy()
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.notification_channel_desc)
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val text = displayAddress ?: "正在启动…"
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification())
    }
}
