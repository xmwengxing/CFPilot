package com.xmwengxing.cfpilot;

/**
 * JNI 契约验证。
 *
 * <p>用**真的 JVM** 走一遍安卓端会走的路径：
 * 同名类、同名方法、同样的符号查找方式。
 *
 * <p>为什么需要它：JNI 的符号是按名字找的，**编译期完全检查不出来**。
 * 比如返回类型写成 {@code char*} 而不是 {@code jstring} ——
 * 编译通过、链接通过、CI 全绿，只在真机上炸成满屏乱码。
 * 这一步把「只在真机暴露」的那类错挪到了 CI 里。
 */
public class JniCheck {

    public static void main(String[] args) throws Exception {
        String dataDir = args.length > 0 ? args[0] : System.getProperty("java.io.tmpdir");

        NativeBridge bridge = new NativeBridge();
        String json = bridge.nativeStart(dataDir);

        System.out.println("nativeStart 返回：" + json);

        // 返回值必须是**合法的 JSON 对象** —— 安卓侧就是按 JSON 解析的，
        // 解析失败会显示成「内核返回异常：Value」。
        if (json == null || json.isEmpty()) {
            fail("返回值为空");
        }
        if (!json.trim().startsWith("{") || !json.trim().endsWith("}")) {
            fail("返回值不是 JSON 对象：" + json);
        }
        if (!json.contains("\"url\"")) {
            fail("返回值里没有 url 字段：" + json);
        }
        if (json.contains("\"error\"")) {
            fail("内核启动报错：" + json);
        }

        // 顺带确认服务端真的起来了：访问返回的地址应当拿到面板。
        String url = json.replaceAll(".*\"url\"\\s*:\\s*\"([^\"]+)\".*", "$1");
        java.net.URI uri = java.net.URI.create(url);
        int port = uri.getPort();
        if (port <= 0) {
            fail("返回的 url 里没有端口：" + url);
        }
        try (java.net.Socket sock = new java.net.Socket("127.0.0.1", port)) {
            System.out.println("本地服务已监听 127.0.0.1:" + port);
        } catch (Exception e) {
            fail("本地服务没起来：" + e);
        }

        bridge.nativeStop();
        System.out.println("JNI 契约验证通过");
    }

    private static void fail(String msg) {
        System.err.println("JNI 契约验证失败：" + msg);
        System.exit(1);
    }
}
