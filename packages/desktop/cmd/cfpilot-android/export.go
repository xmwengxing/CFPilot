//go:build cgo

// CFPilot 安卓版：JNI 导出层。
//
// # 为什么单独一个文件
//
// 带 `import "C"` 的文件在 CGO_ENABLED=0 时会被整个排除。
// 把导出层与业务逻辑分开，好处有两个：
//  1. 业务逻辑那部分**不需要 NDK 就能编译验证**
//     （CGO_ENABLED=0 GOOS=android go build ./cmd/cfpilot-android）；
//  2. 导出层只做「C 字符串 ↔ Go 值」的搬运，不掺杂逻辑。
//
// # 内存约定
//
// 返回的字符串由 C.CString 分配（底层是 C 的 malloc），
// Java 侧在 JNI 胶水层转成 jstring 后立刻 free()。
package main

/*
#include <stdlib.h>

// Go 侧导出的函数（实现见下方 //export 注释）。
char* StartServer(char* dataDir);
void StopServer();
*/
import "C"

// StartServer 启动本地服务，返回 JSON 描述（地址、端口、令牌、数据目录）。
//
// ⚠️ 返回的字符串由 C.CString 分配，**调用方必须 free()**。
// 失败时返回的 JSON 里带 error 字段（不返回 NULL —— Java 侧统一按 JSON 解析，
// 免得为「空指针」单独写一套分支）。
//
//export StartServer
func StartServer(dataDir *C.char) *C.char {
	return C.CString(toJSON(startServer(C.GoString(dataDir))))
}

// StopServer 停止本地服务（应用退出时调用）。
//
//export StopServer
func StopServer() {
	stopServer()
}
