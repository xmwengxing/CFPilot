//go:build cgo && jnilib

// CFPilot 安卓版：JNI 导出层。
//
// # 为什么不用 gomobile，也不用手写 JNI 胶水
//
// 常见做法有两种，都不如这个直接：
//
//   - **gomobile bind**：它会生成 Java 类 + JNI 胶水 + .aar。
//     但它要求 Go 包是**库包**（不能是 main），Java 类名由包路径推导
//     （`cmd/cfpilot-android` 这种带连字符的目录名会被拼成奇怪的东西），
//     还得额外装 gomobile 工具。
//
//   - **把 JNI 胶水 C 文件放在 Gradle 工程里**：胶水得**链进 Go 编出来的 .so**，
//     否则 JVM 在 `System.loadLibrary("cfpilot")` 加载的那个库里
//     根本找不到 `Java_..._nativeStart` 符号 —— 而这个 .so 是
//     `-buildmode=c-shared` 编出来的，链接期就把没被引用的 C 符号丢了。
//     （把 C 文件放进 Go 包目录能解决，但那样 cgo 的 preamble 与
//     `//export` 的「preamble 只能有声明」限制会打架 —— 所以转换逻辑
//     单独拆到 jni_bridge.c，见那里。）
//
// **本文件用的办法**：Go 的 `//export` 可以把函数导出成**任意 C 名字** ——
// 直接用 JNI 的命名约定（`Java_<包>_<类>_<方法>`）导出即可。
// JVM 按名字找符号，符号在不在 .so 里由 Go 的导出表说了算 ✓
//
// 于是：
//   - 不需要 gomobile（少一个工具、少一处版本漂移）
//   - Java 侧就是普通的 `external fun` 声明
//
// # 参数与返回值
//
// JNI 的 `JNIEnv*` / `jclass` / `jstring` 在 ABI 上都是**指针**，
// 所以用 unsafe.Pointer 传即可 —— 不必在本文件里 include jni.h，
// 也就不受「//export 的 preamble 不能有定义」的限制。
//
// ⚠️ **但 jstring 不是 C 字符串**（它是 Java 对象引用）。
//
//	直接把 char* 当 jstring 返回，JVM 会把字节指针当成对象引用 →
//	解析失败 + 满屏乱码。所以返回前必须用 JNIEnv 的 NewStringUTF 转一下
//	（见 jni.go 的 newJavaString）。
package main

/*
#include <stdlib.h>
*/
import "C"

import "unsafe"

// Java_com_xmwengxing_cfpilot_NativeBridge_nativeStart 启动本地服务。
//
// dataDir 是配置目录（设置、凭据、内核缓存都放这里）。
// 返回 JSON（地址、端口、令牌、数据目录）；失败时带 error 字段。
//
//export Java_com_xmwengxing_cfpilot_NativeBridge_nativeStart
func Java_com_xmwengxing_cfpilot_NativeBridge_nativeStart(
	env unsafe.Pointer,
	clazz unsafe.Pointer,
	dataDir unsafe.Pointer,
) unsafe.Pointer {
	_ = clazz

	dir := readJavaString(env, dataDir)
	defer freeCString(dir)

	cs := C.CString(toJSON(startServer(C.GoString(dir))))
	defer C.free(unsafe.Pointer(cs))

	return newJavaString(env, cs)
}

// Java_com_xmwengxing_cfpilot_NativeBridge_nativeStop 停止本地服务。
//
//export Java_com_xmwengxing_cfpilot_NativeBridge_nativeStop
func Java_com_xmwengxing_cfpilot_NativeBridge_nativeStop(
	env unsafe.Pointer,
	clazz unsafe.Pointer,
) {
	_ = env
	_ = clazz
	stopServer()
}
