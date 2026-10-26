package server

// 服务版本号。
//
// 由 main 在启动时用构建时注入的版本调用 SetVersion 写入 ——
// 不在这里写死，避免与根 package.json 的版本号出现两份真相。

// appVersion 是当前程序版本（默认 dev，由 main 覆盖）。
var appVersion = "dev"

// SetVersion 由 main 注入构建版本号。
func SetVersion(v string) {
	if v != "" {
		appVersion = v
	}
}

// Version 返回当前程序版本号。
func Version() string { return appVersion }
