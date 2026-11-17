package com.cfpilot.mesh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import mobile.Mesh // gomobile bind 生成的类名（包名由 -pkgname 指定）

/**
 * CFPilot +mesh 的 Android VpnService。
 *
 * 职责：用户授权 VPN 后建立 TUN（Builder.establish()），把 fd 传给 Go mesh 栈，
 * 之后协议/加解密/选路全在 Go 侧，本服务只持有 TUN 生命周期并定时上报状态。
 */
class MeshVpnService : VpnService() {
    companion object {
        private const val TAG = "CFPilotMesh"
        const val ACTION_START = "com.cfpilot.mesh.START"
        const val ACTION_STOP = "com.cfpilot.mesh.STOP"
        const val EXTRA_CONFIG = "config_json"
        private const val CHANNEL_ID = "cfpilot-mesh"
    }

    private var tun: ParcelFileDescriptor? = null
    private var mesh: Mesh? = null
    private var job: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val config = intent.getStringExtra(EXTRA_CONFIG) ?: run {
                    Log.e(TAG, "缺少配置 JSON")
                    stopSelf(); return START_NOT_STICKY
                }
                startMesh(config)
            }
            ACTION_STOP -> stopMesh()
        }
        return START_STICKY
    }

    private fun startMesh(configJson: String) {
        if (tun != null) return
        try {
            // 建 TUN：地址/路由/MTU 由 Builder 下发（Go 侧不碰 ip 命令）
            val builder = Builder()
                .setSession("CFPilot Mesh")
                .setMtu(1400)
                .addAddress("10.97.0.1", 24)
                .addRoute("10.98.0.0", 24)
                .addDnsServer("1.1.1.1")
            val pfd = builder.establish() ?: throw IllegalStateException("VpnService 授权失败")
            tun = pfd

            // fd ownership 转给 Go（detachFd 后由 Go Close）
            val m = Mesh()
            m.start(configJson, pfd.detachFd())
            mesh = m

            startForeground(1, buildNotification())
            job = scope.launch {
                while (true) {
                    kotlinx.coroutines.delay(3000)
                    Log.d(TAG, "status: ${m.statusJSON()}")
                }
            }
            Log.i(TAG, "mesh 已启动")
        } catch (e: Exception) {
            Log.e(TAG, "mesh 启动失败", e)
            stopMesh()
        }
    }

    private fun stopMesh() {
        job?.cancel(); job = null
        try { mesh?.stop() } catch (e: Exception) { Log.e(TAG, "stop 失败", e) }
        mesh = null
        tun?.close(); tun = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "CFPilot Mesh", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("CFPilot Mesh 运行中")
            .setContentIntent(pi)
            .setSmallIcon(android.R.drawable.stat_sys_vpn_ic)
            .build()
    }

    override fun onDestroy() { stopMesh(); super.onDestroy() }
}
