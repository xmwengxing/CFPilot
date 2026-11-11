package com.xmwengxing.cfpilot

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * 面板界面。
 *
 * ## 形态
 *
 * 桌面版的界面本来就是**浏览器里的网页**（`packages/ui`），
 * 通过 `fetch('/api/...')` 与本地服务说话。
 * 安卓上不重写界面 —— 直接用 WebView 加载本地服务，
 * **一套界面、两种形态**，不会出现两边功能不一样的情况。
 *
 * ## 令牌
 *
 * 界面脚本（adapter.js）从地址栏的 `?t=` 里取一次性令牌换会话 Cookie，
 * 所以 WebView 必须加载**带令牌**的地址。地址由 Go 内核启动后返回。
 */
class MainActivity : AppCompatActivity() {

    private var webView: WebView? = null
    private var statusView: TextView? = null
    private var container: FrameLayout? = null

    private val pollIntervalMs = 300L
    private val pollTimeoutMs = 20_000L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        container = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(0xFF0B0D12.toInt())
        }
        statusView = TextView(this).apply {
            text = "正在启动本地服务…"
            setTextColor(0xFF9AA4B2.toInt())
            textSize = 14f
            setPadding(32, 64, 32, 32)
        }
        container?.addView(statusView)
        setContentView(container)

        requestNotificationPermissionIfNeeded()
        startService(Intent(this, ServerService::class.java))
        waitForServer()
    }

    /**
     * 等内核起来。
     *
     * 内核是在服务的后台线程里启动的（起进程、做目录准备、监听端口），
     * 所以这里轮询 [ServerService.url]。
     */
    private fun waitForServer() {
        val deadline = System.currentTimeMillis() + pollTimeoutMs
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val tick = object : Runnable {
            override fun run() {
                val err = ServerService.error
                if (err != null) {
                    statusView?.text = "启动失败：$err"
                    return
                }
                val u = ServerService.url
                if (u != null) {
                    openPanel(u)
                    return
                }
                if (System.currentTimeMillis() > deadline) {
                    statusView?.text = "启动超时，请重试"
                    return
                }
                handler.postDelayed(this, pollIntervalMs)
            }
        }
        handler.post(tick)
    }

    private fun openPanel(url: String) {
        statusView?.visibility = android.view.View.GONE
        val wv = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, finishedUrl: String?) {
                    super.onPageFinished(view, finishedUrl)
                    // 令牌只在这一跳的地址栏里，换掉之后就没了 ——
                    // 刷新页面时不能把带令牌的地址再放回去（会留在历史里）。
                }
            }
        }
        webView = wv
        container?.addView(wv)
        wv.loadUrl(url)
    }

    private fun requestNotificationPermissionIfNeeded() {
        // Android 13+ 要显式申请通知权限，否则前台服务的常驻通知不显示。
        // 不申请也能跑（服务照常前台运行），只是用户看不到通知。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                ActivityCompat.requestPermissions(
                    this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001
                )
            }
        }
    }

    override fun onBackPressed() {
        // 优先让界面里的 JS 处理返回（面板内部有页面切换）。
        val wv = webView
        if (wv != null && wv.canGoBack()) {
            wv.goBack()
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }
}
