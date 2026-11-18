package com.cfpilot.mesh

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast

/** CFPilot +mesh Android 主界面（最小可用：配置 JSON + 启动/停止）。 */
class MainActivity : Activity() {
    companion object {
        private const val REQ_VPN = 1001
    }

    private lateinit var configEdit: EditText
    private lateinit var statusText: TextView
    private lateinit var btnToggle: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        configEdit = findViewById(R.id.configEdit)
        statusText = findViewById(R.id.statusText)
        btnToggle = findViewById(R.id.btnToggle)

        // 默认配置模板（用户填入节点 ID / PSK / 对端等）
        // ⚠️ 各节点的 virtualIp 必须**同一网段（前三段相同）、只改最后一段**：
        //    如本机 10.97.0.1、对端 10.97.0.2。不同 /24 默认互相到不了。
        configEdit.setText("""
{"nodeId":"0100000000000001","networkName":"my-network","psk":"secret",
 "virtualIp":"10.97.0.1","listen":"0.0.0.0:51820",
 "relayDomain":"","relayRoom":"","enableDegrade":false,
 "peers":[]}
        """.trimIndent())

        btnToggle.setOnClickListener {
            if (btnToggle.text == "停止组网") {
                sendAction(MeshVpnService.ACTION_STOP)
                btnToggle.text = "启动组网"
                statusText.text = "已停止"
            } else {
                val intent = VpnService.prepare(this)
                if (intent != null) {
                    startActivityForResult(intent, REQ_VPN)
                } else {
                    startMesh()
                }
            }
        }
    }

    private fun startMesh() {
        val config = configEdit.text.toString()
        val i = Intent(this, MeshVpnService::class.java).apply {
            action = MeshVpnService.ACTION_START
            putExtra(MeshVpnService.EXTRA_CONFIG, config)
        }
        startForegroundService(i)
        btnToggle.text = "停止组网"
        statusText.text = "组网启动中，状态见通知与日志"
    }

    private fun sendAction(action: String) {
        val i = Intent(this, MeshVpnService::class.java).apply { this.action = action }
        startService(i)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_VPN) {
            if (resultCode == RESULT_OK) startMesh()
            else Toast.makeText(this, "VPN 权限未授予", Toast.LENGTH_SHORT).show()
        }
    }
}
