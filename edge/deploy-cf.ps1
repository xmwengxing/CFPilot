#requires -Version 5.1
<#
.SYNOPSIS
    MobiHop Cloudflare 边缘部署向导（盲中继 + 监测台 + 面板）。

.DESCRIPTION
    交互式向导：选择部署模式 → 输入令牌 → 输入域名 → 输入面板密码 → 开始部署。
    - Workers（盲中继/监测）：域名必填（*.workers.dev 国内被污染）。
    - Pages（监测面板）：域名可选；未填则用 *.pages.dev。
    - 密码在部署时配置并写入 D1，面板不再允许首次设置。

.PARAMETER Mode
    部署模式：worker / pages / both（默认交互选择）。

.PARAMETER Domain
    自定义域（Workers 必填；Pages 可选）。

.PARAMETER WorkerUrl
    Pages 面板对应的 Worker URL（Pages 模式下必填或交互输入）。

.PARAMETER Password
    监测台登录密码（至少 8 位）；未提供时交互输入或自动生成。

.PARAMETER AccountId
    覆盖 MH_CLOUDFLARE_ACCOUNT_ID。

.PARAMETER Probe
    部署后做协议级验证。

.PARAMETER SkipDeploy
    跳过部署，仅验证。

.EXAMPLE
    powershell -File edge/deploy-cf.ps1
#>
[CmdletBinding()]
param(
    [string]$Mode = "",
    [string]$Domain = "",
    [string]$WorkerUrl = "",
    [string]$Password = "",
    [string]$AccountId = "",
    [string]$Room = "0a1b2c3d4e5f",
    [switch]$Probe,
    [switch]$SkipDeploy,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnvFile = Join-Path $Repo ".local\devices.env"
$WorkerDir = Join-Path $Repo "edge\cf-worker-relay"
$DashScript = Join-Path $PSScriptRoot "deploy-cf-monitor-dashboard.ps1"

# ---------------------------------------------------------------------------
# 交互向导
# ---------------------------------------------------------------------------
$interactive = ($Mode -eq "" -and -not $SkipDeploy -and -not $DryRun -and -not $Probe)
if ($interactive) {
    Write-Host ""
    Write-Host "===== MobiHop Cloudflare 部署向导 =====" -ForegroundColor Cyan
    Write-Host " 1. 仅部署 Worker（盲中继 + 监测 API）"
    Write-Host " 2. 仅部署 Pages 监测面板"
    Write-Host " 3. 部署 Worker + Pages 面板（推荐）"
    Write-Host " 4. 协议级验证（不部署）"
    Write-Host " 5. 退出"
    $c = Read-Host "请选择 (1-5)"
    switch ($c) {
        "1" { $Mode = "worker" }
        "2" { $Mode = "pages" }
        "3" { $Mode = "both" }
        "4" { $Mode = "probe" }
        "5" { return }
        default { throw "无效选项" }
    }
}
if ($Mode -eq "") { $Mode = "both" }

# ---------------------------------------------------------------------------
# 凭据
# ---------------------------------------------------------------------------
$Token = $null
$vars = @{}
if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith("#")) { continue }
        $i = $t.IndexOf("=")
        if ($i -lt 1) { continue }
        $vars[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
    }
    if (-not $AccountId -and $vars.ContainsKey("MH_CLOUDFLARE_ACCOUNT_ID")) { $AccountId = $vars["MH_CLOUDFLARE_ACCOUNT_ID"] }
    $Token = $vars["MH_CLOUDFLARE_TOKEN"]
}
if (-not $Token) { $Token = $env:CLOUDFLARE_API_TOKEN }
if (-not $AccountId) { $AccountId = $env:CLOUDFLARE_ACCOUNT_ID }
if (-not $Token) { throw "缺少 Cloudflare 令牌：请在 .local/devices.env 写 MH_CLOUDFLARE_TOKEN" }
if (-not $AccountId) { throw "缺少 Account ID：请在 .local/devices.env 写 MH_CLOUDFLARE_ACCOUNT_ID" }

$env:CLOUDFLARE_API_TOKEN = $Token
$env:CLOUDFLARE_ACCOUNT_ID = $AccountId
Write-Host ("凭据已注入（token 长度 {0}，account {1}…）" -f $Token.Length, $AccountId.Substring(0, 8)) -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 前置检查
# ---------------------------------------------------------------------------
foreach ($cmd in @("node", "npx")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "缺少 $cmd" }
}

# ---------------------------------------------------------------------------
# Worker 部署
# ---------------------------------------------------------------------------
$workerDomain = ""
$monitorToken = ""
if ($vars.ContainsKey("MH_MONITOR_TOKEN")) { $monitorToken = $vars["MH_MONITOR_TOKEN"] }

if ($Mode -in @("worker", "both")) {
    if (-not $Domain) {
        $Domain = Read-Host "Workers 自定义域（必填，如 relay.example.com）"
    }
    if (-not $Domain) { throw "Workers 部署必须提供自定义域" }
    $workerDomain = $Domain

    # 密码
    if (-not $Password) {
        $Password = Read-Host "监测台登录密码（至少 8 位；留空则自动生成）"
    }
    if (-not $Password) {
        $Password = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
        Write-Host "已自动生成密码（见末尾汇总）" -ForegroundColor Yellow
    }
    if ($Password.Length -lt 8) { throw "密码至少 8 位" }

    if (-not $SkipDeploy) {
        Push-Location $WorkerDir
        try {
            $args = @("-y", "wrangler@4", "deploy", "--domain", $Domain)
            if ($DryRun) { $args += "--dry-run" }
            Write-Host "`n=== 部署 Worker: $Domain ===" -ForegroundColor Cyan
            & npx @args | ForEach-Object { Write-Host $_ }
            if ($LASTEXITCODE -ne 0) { throw "wrangler deploy 失败" }
        } finally { Pop-Location }
        if ($DryRun) { Write-Host "`n(--dry-run，未上传)"; return }

        # secret: MONITOR_TOKEN
        if ($monitorToken) {
            Write-Host "`n=== 写入 MONITOR_TOKEN secret ===" -ForegroundColor Cyan
            $monitorToken | & npx -y wrangler@4 secret put MONITOR_TOKEN --name mobihop-edge-relay 2>&1 | ForEach-Object { Write-Host $_ }
        }

        # 设置初始密码 via /auth/setup
        $workerUrl = "https://$Domain"
        Write-Host "`n=== 设置监测台初始密码 ===" -ForegroundColor Cyan
        $body = @{ password = $Password } | ConvertTo-Json
        $r = Invoke-RestMethod -Method Post -Uri "$workerUrl/auth/setup" -ContentType "application/json" -Body $body -ErrorAction Stop
        if (-not $r.ok) { throw "设置密码失败: $($r | ConvertTo-Json)" }
        Write-Host "密码已设置" -ForegroundColor Green
    }
    if (-not $workerUrl -and $Domain) { $workerUrl = "https://$Domain" }
}

# Pages 面板域名/URL
if ($Mode -in @("pages", "both")) {
    if (-not $WorkerUrl) {
        if ($workerDomain) { $WorkerUrl = "https://$workerDomain" }
        else { $WorkerUrl = Read-Host "Worker URL（监测 API 地址，如 https://relay.example.com）" }
    }
    if (-not $WorkerUrl) { throw "Pages 面板需要 Worker URL" }

    # Pages 域名可选
    $pagesDomain = ""
    if ($interactive) {
        $pagesDomain = Read-Host "Pages 自定义域（可选，留空用 *.pages.dev）"
    }

    Write-Host "`n=== 部署 Pages 监测面板 ===" -ForegroundColor Cyan
    $dashArgs = @("-File", $DashScript, "-WorkerUrl", $WorkerUrl)
    if ($pagesDomain) { $dashArgs += @("-ProjectName", "mobihop-monitor-dashboard") }
    & powershell -File $DashScript -WorkerUrl $WorkerUrl
    if ($LASTEXITCODE -ne 0) { throw "Pages 部署失败" }
}

# ---------------------------------------------------------------------------
# 协议验证
# ---------------------------------------------------------------------------
if ($Probe -or $Mode -eq "probe") {
    if (-not $Domain) { $Domain = Read-Host "中继域名" }
    if ($Room -notmatch '^[0-9a-f]{8,64}$') { throw "房间名必须 8-64 位小写 hex" }
    Write-Host "`n=== 协议级验证 ===" -ForegroundColor Cyan
    $probeScript = Join-Path $Repo "tools\netlab\cf-edge-probe.mjs"
    & node $probeScript $Domain $Room
    if ($LASTEXITCODE -ne 0) { throw "协议验证失败" }
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "================ 部署完成 ================" -ForegroundColor Green
if ($workerDomain) {
    Write-Host "实例名称 (Worker): mobihop-edge-relay"
    Write-Host "盲中继/监测域名:  https://$workerDomain"
    Write-Host "WSS 端点:         wss://$workerDomain/mesh/<ROOM>?peer_id=<16 hex>"
}
if ($Mode -in @("pages","both")) {
    Write-Host "实例名称 (Pages): mobihop-monitor-dashboard"
    Write-Host "监测台面板链接:   https://mobihop-monitor-dashboard.pages.dev"
}
if ($Password) {
    Write-Host "登录密码:         $Password" -ForegroundColor Yellow
}
Write-Host "==========================================" -ForegroundColor Green
Write-Host "请妥善保存登录密码；可通过面板内「修改密码」更改。" -ForegroundColor DarkGray
