package com.xmwengxing.cfpilot

/**
 * Go 内核的 JNI 桥。
 *
 * 真正的实现在 `src/main/cpp/cfpilot_jni.c` —— 它只是把 Go 导出的 C 函数
 * 包成 JNI 方法。Go 侧见 `packages/desktop/cmd/cfpilot-android/`。
 *
 * ⚠️ 为什么不用 gomobile：
 * gomobile 会自动生成一层 Java 绑定，但它只能导出有限类型，
 * 而且多一个需要额外安装的工具。这里接口只有两个函数，
 * 手写一层 C 胶水更可控 —— 少一个工具，少一处版本漂移。
 */
object NativeBridge {

    init {
        // 库名对应 Go 侧产出的 libcfpilot.so
        System.loadLibrary("cfpilot")
    }

    /**
     * 启动本地服务，返回 JSON。
     *
     * @param dataDir 配置目录（设置、凭据、内核缓存都放这里）
     * @return JSON：`{"url":"http://127.0.0.1:19726/?t=...","port":19726,...}`
     *         失败时带 `error` 字段。
     */
    external fun nativeStart(dataDir: String): String

    /** 停止本地服务。 */
    external fun nativeStop()
}
