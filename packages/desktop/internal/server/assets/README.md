# assets/ 目录说明

本目录的 `index.html` 与 `renderer.js` 是**构建中间产物**，
由 `scripts/build-desktop.mjs` 从 `packages/gui/dist/renderer/` 拷贝而来，
然后用 `//go:embed all:assets` 打进二进制。

## 为什么这里保留一个占位文件

`go:embed` 要求匹配的目录**必须存在且至少含一个文件**，
否则编译直接失败：

```text
pattern all:assets: no matching files found
```

而这两个真实产物又不能入库（否则界面源码会有两份真相，
且容易忘记同步导致 Go 版界面落后于 Electron 版）。

所以：
- **真实产物**（index.html / renderer.js）由 .gitignore 排除
- **本占位文件**入库，保证 clone 下来目录非空，`go build` / `go test` 能过

如果看到界面是空白页，说明忘了先构建界面资源：

```bash
npm run build -w @cfpilot/gui
node scripts/build-desktop.mjs
```
