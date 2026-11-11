package com.xmwengxing.cfpilot;

/**
 * JNI 契约验证用的 Java 镜像类。
 *
 * <p>⚠️ 这个类**必须**与 Kotlin 侧的 {@code NativeBridge} 同包同名、同方法名 ——
 * 因为 JVM 是**按符号名**找函数的：
 *
 * <pre>
 *   Java_com_xmwengxing_cfpilot_NativeBridge_nativeStart
 * </pre>
 *
 * 包名或类名差一个字，符号就对不上，运行时直接 UnsatisfiedLinkError。
 * 所以这里刻意保持一致（Kotlin 那边用 object，方法都是实例方法）。
 */
public class NativeBridge {

    static {
        System.loadLibrary("cfpilot");
    }

    /** 启动本地服务，返回 JSON（地址、端口、令牌…）。 */
    public native String nativeStart(String dataDir);

    /** 停止本地服务。 */
    public native void nativeStop();
}
