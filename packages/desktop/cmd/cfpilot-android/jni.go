//go:build cgo && jnilib

// CFPilot 安卓版：JNI 字符串转换的 Go 侧包装。
//
// # 为什么单独一个文件
//
// 带 `import "C"` 的文件在 CGO_ENABLED=0 时会被整个排除。
// 把导出层与业务逻辑分开，好处有两个：
//  1. 业务逻辑那部分**不需要 NDK 就能编译验证**
//     （CGO_ENABLED=0 GOOS=android go build ./cmd/cfpilot-android）；
//  2. 导出层只做「C 字符串 ↔ Java 字符串」的搬运，不掺杂逻辑。
//
// # 为什么这里能 include <jni.h>，而 export.go 不能
//
// Go 的 `//export` 有限制：**带 //export 的文件，cgo 的 preamble 里
// 只能有声明、不能有定义**（preamble 会被复制进两个 C 文件）。
// jni.h 里有 typedef 与 static inline 函数 —— 直接 include 容易踩到这个限制。
//
// 所以 jni.h 只出现在这里（**没有 //export** 的文件不受该限制）与
// jni_bridge.c 里；export.go 的 preamble 保持干净。
package main

/*
#include <jni.h>
#include <stdlib.h>

// jni_bridge.c 提供的两个纯 C 转换函数。
jstring cf_new_jstring(JNIEnv *env, const char *s);
char *cf_read_jstring(JNIEnv *env, jstring s);
*/
import "C"

import "unsafe"

// newJavaString 把 C 字符串转成 jstring（JVM 管的引用，调用方不释放）。
func newJavaString(envPtr unsafe.Pointer, s *C.char) unsafe.Pointer {
	env := (*C.JNIEnv)(envPtr)
	return unsafe.Pointer(C.cf_new_jstring(env, s))
}

// readJavaString 把 jstring 取成 C 字符串。
//
// ⚠️ 返回的是 **malloc 出来的副本**，调用方必须 C.free 掉。
func readJavaString(envPtr unsafe.Pointer, objPtr unsafe.Pointer) *C.char {
	env := (*C.JNIEnv)(envPtr)
	return C.cf_read_jstring(env, (*C.jstring)(objPtr))
}

// freeCString 释放 readJavaString 取回来的副本。
func freeCString(p *C.char) {
	if p != nil {
		C.free(unsafe.Pointer(p))
	}
}
