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
import org.json.JSONObject // 读取配置里的 virtualIp（TUN 地址必须与 Go 侧一致）

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

        /** 服务向界面广播真实运行状态（界面据此驱动按钮，而不是靠猜测）。 */
        const val ACTION_STATE = "com.cfpilot.mesh.STATE"
        const val EXTRA_RUNNING = "running"
        const val EXTRA_ERROR = "error"
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
            // 虚拟 IP 必须来自配置：TUN 地址与 Go 侧的 virtualIp 必须一致，
            // 否则 vipTable 的自有 IP 与内核路由表对不上。
            val VIP_KEY = "virtualIp"
            val vip = runCatching { JSONObject(configJson).optString(VIP_KEY, "") }
                .getOrDefault("")
                .trim()
            require(Regex("""\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}""").matches(vip)) {
                "配置缺少合法的 virtualIp（例：10.97.0.1）"
            }
            // ⚠️ 组网是**同一 /24 网段、只改最后一段**：地址 /24 的同时必须把
            // 同一个 /24 路由进 VPN，包才会进隧道。写死 10.98.0.0/24 是早期
            // 「不同节点不同网段」的错误模型（跨机器必然不通）。
            val subnet = vip.substringBeforeLast('.') + ".0"
            val builder = Builder()
                .setSession("CFPilot Mesh")
                .setMtu(1400)
                .addAddress(vip, 24)
                .addRoute(subnet, 24)
                .addDnsServer("1.1.1.1")
            val pfd = builder.establish() ?: throw IllegalStateException("VpnService 授权失败")
            tun = pfd

            // fd ownership 转给 Go（detachFd 后由 Go Close）
            val m = Mesh()
            // gomobile 把 Go 的 int 映射为 Java long，detachFd() 返回 Int，需转 Long
            m.start(configJson, pfd.detachFd().toLong())
            mesh = m

            startForeground(1, buildNotification())
            job = scope.launch {
                while (true) {
                    kotlinx.coroutines.delay(3000)
                    Log.d(TAG, "status: ${m.statusJSON()}")
                }
            }
            Log.i(TAG, "mesh 已启动")
            broadcastState(true, null)
        } catch (e: Exception) {
            Log.e(TAG, "mesh 启动失败", e)
            stopMesh()
            // 启动失败也要回状态，否则界面会一直停在「处理中」（直到超时）。
            broadcastState(false, e.message ?: e.javaClass.simpleName)
        }
    }

    /** 把真实运行状态发给界面（显式 setPackage，避免跨应用泄露）。 */
    private fun broadcastState(running: Boolean, error: String?) {
        val i = Intent(ACTION_STATE).setPackage(packageName)
        i.putExtra(EXTRA_RUNNING, running)
        if (error != null) i.putExtra(EXTRA_ERROR, error)
        sendBroadcast(i)
    }

    private fun stopMesh() {
        job?.cancel(); job = null
        try { mesh?.stop() } catch (e: Exception) { Log.e(TAG, "stop 失败", e) }
        mesh = null
        tun?.close(); tun = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        broadcastState(false, null)
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
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .build()
    }

    override fun onDestroy() { stopMesh(); super.onDestroy() }
}
