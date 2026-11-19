package com.cfpilot.mesh

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import mobile.Mesh
import org.json.JSONArray
import org.json.JSONObject

/**
 * CFPilot +mesh Android 主界面。
 *
 * 结构与桌面版一致：**必填项常显 + 一个「高级选项」折叠**（监听 / 打洞 /
 * 服务器中继 / 监测台 / 对端）。按钮有状态机，避免重复点击导致重启。
 */
class MainActivity : Activity() {
    companion object {
        private const val REQ_VPN = 1001
        private const val PREFS = "cfpilot-mesh"
        /** 服务迟迟不回状态时的兜底：恢复按钮，避免永远卡在「处理中」。 */
        private const val START_TIMEOUT_MS = 15_000L

        private const val K_NETWORK = "networkName"
        private const val K_PSK = "psk"
        private const val K_VIP = "virtualIp"
        private const val K_RELAY_DOMAIN = "relayDomain"
        private const val K_RELAY_ROOM = "relayRoom"
        private const val K_LISTEN = "listen"
        private const val K_CONNECT_IP = "relayConnectIp"
        private const val K_DEGRADE = "enableDegrade"
        private const val K_PUNCH = "enablePunch"
        private const val K_RS_ID = "relayServerId"
        private const val K_RS_ADDR = "relayServerAddr"
        private const val K_RS_TOKEN = "relayServerToken"
        private const val K_MON_EP = "monitorEndpoint"
        private const val K_MON_TOKEN = "monitorToken"
        private const val K_MON_INTERVAL = "monitorInterval"
        private const val K_MON_ALIAS = "monitorAlias"
        private const val K_PEERS = "peers"
        private const val K_ID_SEED = "identitySeed"
        private const val K_TUN_SEED = "tunnelSeed"
    }

    private lateinit var edNetwork: EditText
    private lateinit var edPsk: EditText
    private lateinit var edVirtualIp: EditText
    private lateinit var edRelayDomain: EditText
    private lateinit var edRelayRoom: EditText
    private lateinit var edListen: EditText
    private lateinit var edRelayConnectIp: EditText
    private lateinit var cbEnableDegrade: CheckBox
    private lateinit var cbEnablePunch: CheckBox
    private lateinit var edRelayServerId: EditText
    private lateinit var edRelayServerAddr: EditText
    private lateinit var edRelayServerToken: EditText
    private lateinit var edMonitorEndpoint: EditText
    private lateinit var edMonitorToken: EditText
    private lateinit var edMonitorInterval: EditText
    private lateinit var edMonitorAlias: EditText
    private lateinit var edPeers: EditText
    private lateinit var tvNodeId: TextView
    private lateinit var tvTunnelPub: TextView
    private lateinit var advancedGroup: LinearLayout
    private lateinit var btnAdvanced: Button
    private lateinit var btnToggle: Button
    private lateinit var statusText: TextView

    /** 组网是否在运行（以服务广播为准，不看按钮文案）。 */
    private var running = false

    /** 启停请求在飞：期间禁用主按钮，防连点重启。 */
    private var busy = false

    private val handler = Handler(Looper.getMainLooper())
    private var timeoutRunnable: Runnable? = null

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != MeshVpnService.ACTION_STATE) return
            val ok = intent.getBooleanExtra(MeshVpnService.EXTRA_RUNNING, false)
            val err = intent.getStringExtra(MeshVpnService.EXTRA_ERROR)
            clearTimeout()
            busy = false
            running = ok
            applyButtons()
            statusText.text = when {
                err != null -> "启动失败：$err"
                ok -> "组网运行中"
                else -> "已停止"
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        bindViews()
        restorePrefs()
        refreshIdentity()

        btnAdvanced.setOnClickListener {
            val show = advancedGroup.visibility != android.view.View.VISIBLE
            advancedGroup.visibility = if (show) android.view.View.VISIBLE else android.view.View.GONE
            btnAdvanced.text =
                if (show) "收起高级选项" else "高级选项（监听 / 打洞 / 服务器中继 / 监测台 / 对端）"
        }

        btnToggle.setOnClickListener {
            if (busy) return@setOnClickListener
            if (running) stopMesh() else requestStart()
        }
        applyButtons()
    }

    private fun bindViews() {
        edNetwork = findViewById(R.id.edNetwork)
        edPsk = findViewById(R.id.edPsk)
        edVirtualIp = findViewById(R.id.edVirtualIp)
        edRelayDomain = findViewById(R.id.edRelayDomain)
        edRelayRoom = findViewById(R.id.edRelayRoom)
        edListen = findViewById(R.id.edListen)
        edRelayConnectIp = findViewById(R.id.edRelayConnectIp)
        cbEnableDegrade = findViewById(R.id.cbEnableDegrade)
        cbEnablePunch = findViewById(R.id.cbEnablePunch)
        edRelayServerId = findViewById(R.id.edRelayServerId)
        edRelayServerAddr = findViewById(R.id.edRelayServerAddr)
        edRelayServerToken = findViewById(R.id.edRelayServerToken)
        edMonitorEndpoint = findViewById(R.id.edMonitorEndpoint)
        edMonitorToken = findViewById(R.id.edMonitorToken)
        edMonitorInterval = findViewById(R.id.edMonitorInterval)
        edMonitorAlias = findViewById(R.id.edMonitorAlias)
        edPeers = findViewById(R.id.edPeers)
        tvNodeId = findViewById(R.id.tvNodeId)
        tvTunnelPub = findViewById(R.id.tvTunnelPub)
        advancedGroup = findViewById(R.id.advancedGroup)
        btnAdvanced = findViewById(R.id.btnAdvanced)
        btnToggle = findViewById(R.id.btnToggle)
        statusText = findViewById(R.id.statusText)
    }

    /** 按钮状态机：处理中禁用；运行中显示「停止组网」；否则「启动组网」。 */
    private fun applyButtons() {
        btnToggle.isEnabled = !busy
        btnToggle.text = when {
            busy -> "处理中…"
            running -> "停止组网"
            else -> "启动组网"
        }
    }

    // ---- 配置持久化：刷新/杀进程后不丢，NodeId 也保持稳定 ----

    private fun restorePrefs() {
        val p = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        edNetwork.setText(p.getString(K_NETWORK, "") ?: "")
        edPsk.setText(p.getString(K_PSK, "") ?: "")
        edVirtualIp.setText(p.getString(K_VIP, "") ?: "")
        edRelayDomain.setText(p.getString(K_RELAY_DOMAIN, "") ?: "")
        edRelayRoom.setText(p.getString(K_RELAY_ROOM, "") ?: "")
        edListen.setText(p.getString(K_LISTEN, "") ?: "")
        edRelayConnectIp.setText(p.getString(K_CONNECT_IP, "") ?: "")
        cbEnableDegrade.isChecked = p.getBoolean(K_DEGRADE, true)
        cbEnablePunch.isChecked = p.getBoolean(K_PUNCH, true)
        edRelayServerId.setText(p.getString(K_RS_ID, "") ?: "")
        edRelayServerAddr.setText(p.getString(K_RS_ADDR, "") ?: "")
        edRelayServerToken.setText(p.getString(K_RS_TOKEN, "") ?: "")
        edMonitorEndpoint.setText(p.getString(K_MON_EP, "") ?: "")
        edMonitorToken.setText(p.getString(K_MON_TOKEN, "") ?: "")
        edMonitorInterval.setText(p.getString(K_MON_INTERVAL, "") ?: "")
        edMonitorAlias.setText(p.getString(K_MON_ALIAS, "") ?: "")
        edPeers.setText(p.getString(K_PEERS, "") ?: "")
    }

    private fun savePrefs() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(K_NETWORK, edNetwork.text.toString().trim())
            .putString(K_PSK, edPsk.text.toString().trim())
            .putString(K_VIP, edVirtualIp.text.toString().trim())
            .putString(K_RELAY_DOMAIN, edRelayDomain.text.toString().trim())
            .putString(K_RELAY_ROOM, edRelayRoom.text.toString().trim())
            .putString(K_LISTEN, edListen.text.toString().trim())
            .putString(K_CONNECT_IP, edRelayConnectIp.text.toString().trim())
            .putBoolean(K_DEGRADE, cbEnableDegrade.isChecked)
            .putBoolean(K_PUNCH, cbEnablePunch.isChecked)
            .putString(K_RS_ID, edRelayServerId.text.toString().trim())
            .putString(K_RS_ADDR, edRelayServerAddr.text.toString().trim())
            .putString(K_RS_TOKEN, edRelayServerToken.text.toString().trim())
            .putString(K_MON_EP, edMonitorEndpoint.text.toString().trim())
            .putString(K_MON_TOKEN, edMonitorToken.text.toString().trim())
            .putString(K_MON_INTERVAL, edMonitorInterval.text.toString().trim())
            .putString(K_MON_ALIAS, edMonitorAlias.text.toString().trim())
            .putString(K_PEERS, edPeers.text.toString())
            .apply()
    }

    /**
     * 派生并展示本机身份。
     *
     * 首次调用时两个 seed 都为空，Go 侧随机生成并把 seeds 一并返回；
     * 这里立刻存进 SharedPreferences，之后每次启动都原样传回，
     * **NodeId 才不会每次都变**（否则对端配的 ID 立刻失效）。
     */
    private fun refreshIdentity() {
        val p = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val idSeed = p.getString(K_ID_SEED, "") ?: ""
        val tunSeed = p.getString(K_TUN_SEED, "") ?: ""
        try {
            val json = Mesh().identityJSON(idSeed, tunSeed)
            val o = JSONObject(json)
            val newNodeId = o.optString("nodeId", "")
            val pub = o.optString("tunnelPublic", "")
            val identitySeed = o.optString("identitySeed", "")
            val tunnelSeed = o.optString("tunnelSeed", "")
            if (identitySeed.isNotEmpty() && identitySeed != idSeed ||
                tunnelSeed.isNotEmpty() && tunnelSeed != tunSeed
            ) {
                p.edit().putString(K_ID_SEED, identitySeed).putString(K_TUN_SEED, tunnelSeed).apply()
            }
            tvNodeId.text = "节点 ID：$newNodeId"
            tvTunnelPub.text = "隧道公钥：$pub"
        } catch (e: Exception) {
            tvNodeId.text = "节点 ID：生成失败（${e.message}）"
            tvTunnelPub.text = "隧道公钥：—"
        }
    }

    // ---- 启停 ----

    private fun requestStart() {
        savePrefs()
        val err = validate()
        if (err != null) {
            Toast.makeText(this, err, Toast.LENGTH_LONG).show()
            return
        }
        busy = true
        applyButtons()
        val intent = VpnService.prepare(this)
        if (intent != null) {
            startActivityForResult(intent, REQ_VPN)
        } else {
            startMesh()
        }
    }

    /** 必填校验：只拦真正缺的，其余交给 Go 侧报错（信息更准确）。 */
    private fun validate(): String? {
        if (edNetwork.text.toString().trim().isEmpty()) return "请填写网络名"
        if (edPsk.text.toString().trim().isEmpty()) return "请填写网络密钥 PSK"
        if (!Regex("""\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}""").matches(edVirtualIp.text.toString().trim())) {
            return "本节点虚拟 IP 格式不对（例：10.97.0.1）"
        }
        if (edRelayDomain.text.toString().trim().isEmpty()) {
            return "请填写盲中继域名（没有它跨网络基本连不上）"
        }
        val room = edRelayRoom.text.toString().trim()
        if (!Regex("""[0-9a-fA-F]{8,64}""").matches(room)) {
            return "房间名需为 8-64 位十六进制"
        }
        return null
    }

    private fun startMesh() {
        try {
            val i = Intent(this, MeshVpnService::class.java).apply {
                action = MeshVpnService.ACTION_START
                putExtra(MeshVpnService.EXTRA_CONFIG, buildConfig())
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i)
            } else {
                startService(i)
            }
            statusText.text = "正在启动…"
            armTimeout()
        } catch (e: Exception) {
            clearTimeout()
            busy = false
            applyButtons()
            statusText.text = "启动失败：${e.message}"
        }
    }

    private fun stopMesh() {
        busy = true
        applyButtons()
        statusText.text = "正在停止…"
        armTimeout()
        sendAction(MeshVpnService.ACTION_STOP)
    }

    private fun sendAction(action: String) {
        val i = Intent(this, MeshVpnService::class.java).apply { this.action = action }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
    }

    private fun armTimeout() {
        clearTimeout()
        val r = Runnable {
            if (busy) {
                busy = false
                applyButtons()
                statusText.text = if (running) "组网运行中" else "未启动（服务未响应，请重试）"
            }
        }
        timeoutRunnable = r
        handler.postDelayed(r, START_TIMEOUT_MS)
    }

    private fun clearTimeout() {
        timeoutRunnable?.let { handler.removeCallbacks(it) }
        timeoutRunnable = null
    }

    // ---- 组装配置 JSON（字段与桌面版一致） ----

    private fun buildConfig(): String {
        val p = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val o = JSONObject()
        o.put("networkName", edNetwork.text.toString().trim())
        o.put("psk", edPsk.text.toString().trim())
        o.put("virtualIp", edVirtualIp.text.toString().trim())
        o.put("listen", edListen.text.toString().trim().ifEmpty { "0.0.0.0:51820" })
        o.put("relayDomain", edRelayDomain.text.toString().trim())
        o.put("relayRoom", edRelayRoom.text.toString().trim())
        o.put("relayConnectIp", edRelayConnectIp.text.toString().trim())
        o.put("enableDegrade", cbEnableDegrade.isChecked)
        // Go 侧字段是 disablePunch（true=关闭），勾选「启用打洞」要传 false
        o.put("disablePunch", !cbEnablePunch.isChecked)
        // 身份：必须带固定 seeds，否则每次启动 NodeId 都会变
        o.put("identitySeed", p.getString(K_ID_SEED, "") ?: "")
        o.put("tunnelPrivate", p.getString(K_TUN_SEED, "") ?: "")

        val rsId = edRelayServerId.text.toString().trim()
        val rsAddr = edRelayServerAddr.text.toString().trim()
        val rsToken = edRelayServerToken.text.toString().trim()
        if (rsId.isNotEmpty() && rsAddr.isNotEmpty() && rsToken.isNotEmpty()) {
            val arr = JSONArray()
            arr.put(JSONObject().put("nodeId", rsId).put("addr", rsAddr).put("token", rsToken))
            o.put("relayServers", arr)
        }

        val ep = edMonitorEndpoint.text.toString().trim()
        if (ep.isNotEmpty()) {
            o.put("monitoringEndpoint", ep)
            o.put("monitoringToken", edMonitorToken.text.toString().trim())
            val sec = edMonitorInterval.text.toString().trim().toLongOrNull() ?: 30L
            o.put("monitoringIntervalMs", sec.coerceIn(5L, 3600L) * 1000L)
            o.put("monitoringAlias", edMonitorAlias.text.toString().trim())
        }

        o.put("peers", parsePeers(edPeers.text.toString()))
        return o.toString()
    }

    /** 每行一条：对端ID,地址,公钥,虚拟IP。空行与格式不符的行跳过。 */
    private fun parsePeers(raw: String): JSONArray {
        val arr = JSONArray()
        raw.split('\n').forEach { line ->
            val parts = line.trim().split(',')
            if (parts.size < 4) return@forEach
            val nodeId = parts[0].trim()
            val addr = parts[1].trim()
            val pub = parts[2].trim()
            val vip = parts[3].trim()
            if (nodeId.isEmpty() || addr.isEmpty() || pub.isEmpty() || vip.isEmpty()) return@forEach
            arr.put(
                JSONObject()
                    .put("nodeId", nodeId)
                    .put("addr", addr)
                    .put("staticPub", pub)
                    .put("virtualIp", vip)
            )
        }
        return arr
    }

    // ---- 生命周期：保存配置 + 订阅服务状态 ----

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(MeshVpnService.ACTION_STATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(stateReceiver, filter)
        }
    }

    override fun onStop() {
        try {
            unregisterReceiver(stateReceiver)
        } catch (_: IllegalArgumentException) {
            // 未注册（onStart 未走完）时忽略
        }
        savePrefs()
        super.onStop()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_VPN) {
            if (resultCode == RESULT_OK) {
                startMesh()
            } else {
                clearTimeout()
                busy = false
                applyButtons()
                statusText.text = "未授予 VPN 权限"
                Toast.makeText(this, "VPN 权限未授予", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
