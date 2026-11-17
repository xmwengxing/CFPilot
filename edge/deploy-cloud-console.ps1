#requires -Version 5.1
<#
.SYNOPSIS
    MobiHop 云控制台（cloud.html SPA）一键部署到 Cloudflare Pages。

.DESCRIPTION
    把 ui/ 的 cloud 入口构建并部署到 Cloudflare Pages。可选绑定自定义域并自动创建 DNS CNAME。

    云控制台是纯前端 SPA：设备/网络/ACL/审计等数据由控制面后端（mobihop-control）
    提供，Pages 只托管静态资源。无后端时页面可渲染但 API 调用会失败（预期）。

.PARAMETER ProjectName
    Pages 项目名（缺省 mobi-cloud-console）。

.PARAMETER Domain
    自定义域（如 console.example.com）。不提供则使用 *.pages.dev。

.PARAMETER AccountId
    覆盖 MH_CLOUDFLARE_ACCOUNT_ID。

.PARAMETER SkipBuild
    跳过 npm run build（使用现有 ui/dist）。

.PARAMETER SkipDeploy
    只做构建/暂存，不上传。

.PARAMETER DryRun
    wrangler --dry-run。

.EXAMPLE
    powershell -File edge/deploy-cloud-console.ps1 -Domain console.example.com
#>
[CmdletBinding()]
param(
    [string]$ProjectName = "mobi-cloud-console",
    [string]$Domain = "",
    [string]$AccountId = "",
    [switch]$SkipBuild,
    [switch]$SkipDeploy,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnvFile = Join-Path $Repo ".local\devices.env"
$UiDir = Join-Path $Repo "ui"
$DistDir = Join-Path $UiDir "dist"
$StageDir = Join-Path $Repo ".cf-stage\cloud-console"

# ---------------------------------------------------------------- credentials
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
} else {
    $Token = $env:CLOUDFLARE_API_TOKEN
    if (-not $AccountId) { $AccountId = $env:CLOUDFLARE_ACCOUNT_ID }
}
if (-not $Token) { throw "缺少 Cloudflare 令牌" }
if (-not $AccountId) { throw "缺少 Account ID" }
$env:CLOUDFLARE_API_TOKEN = $Token
$env:CLOUDFLARE_ACCOUNT_ID = $AccountId

# ---------------------------------------------------------------- build
if (-not $SkipBuild) {
    Write-Host "`n=== 构建云控制台 (npm run build) ===" -ForegroundColor Cyan
    Push-Location $UiDir
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build 失败" }
    } finally { Pop-Location }
}

if (-not (Test-Path (Join-Path $DistDir "cloud.html"))) {
    throw "缺少 ui/dist/cloud.html，请先构建"
}

# ---------------------------------------------------------------- stage
Write-Host "`n=== 暂存 Pages 产物 ===" -ForegroundColor Cyan
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
Copy-Item (Join-Path $DistDir "assets") (Join-Path $StageDir "assets") -Recurse -Force
Copy-Item (Join-Path $DistDir "cloud.html") (Join-Path $StageDir "index.html") -Force
if (Test-Path (Join-Path $DistDir "favicon.svg")) {
    Copy-Item (Join-Path $DistDir "favicon.svg") (Join-Path $StageDir "favicon.svg") -Force
}

# ---------------------------------------------------------------- deploy
if (-not $SkipDeploy) {
    # ensure project exists
    $projList = & npx -y wrangler@4 pages project list 2>$null
    if (-not ($projList -match [regex]::Escape($ProjectName))) {
        Write-Host "创建 Pages 项目 $ProjectName" -ForegroundColor DarkGray
        & npx -y wrangler@4 pages project create $ProjectName --production-branch main
    }

    $wranglerArgs = @("-y", "wrangler@4", "pages", "deploy", $StageDir, "--project-name", $ProjectName, "--branch", "main", "--commit-dirty")
    if ($DryRun) { $wranglerArgs += "--dry-run" }

    Write-Host "`n=== 部署 Pages: $ProjectName ===" -ForegroundColor Cyan
    & npx @wranglerArgs
    if ($LASTEXITCODE -ne 0) { throw "wrangler pages deploy 失败" }

    if ($DryRun) { Write-Host "`n(--dry-run)"; return }

    # ---------------------------------------------------------------- domain + DNS
    if ($Domain) {
        Write-Host "`n=== 绑定自定义域 $Domain ===" -ForegroundColor Cyan
        $body = @{ name = $Domain } | ConvertTo-Json -Compress
        try {
            Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/accounts/$AccountId/pages/projects/$ProjectName/domains" -Headers @{Authorization="Bearer $Token"} -ContentType "application/json" -Body $body | Out-Null
        } catch {
            # already exists is fine
            if ($_.Exception.Message -notmatch "already") { Write-Host "attach domain: $($_.Exception.Message)" -ForegroundColor Yellow }
        }

        # DNS CNAME
        $zoneName = ($Domain -split '\.',2)[1]
        $zoneResp = Invoke-RestMethod -Method GET -Uri "https://api.cloudflare.com/client/v4/zones?name=$zoneName" -Headers @{Authorization="Bearer $Token"}
        $zoneId = $zoneResp.result[0].id
        if ($zoneId) {
            $recBody = @{ type = "CNAME"; name = ($Domain -split '\.',2)[0]; content = "$ProjectName.pages.dev"; proxied = $true } | ConvertTo-Json -Compress
            try {
                Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records" -Headers @{Authorization="Bearer $Token"} -ContentType "application/json" -Body $recBody | Out-Null
                Write-Host "DNS CNAME 已创建：$Domain -> $ProjectName.pages.dev"
            } catch {
                if ($_.Exception.Message -notmatch "already") { Write-Host "DNS create: $($_.Exception.Message)" -ForegroundColor Yellow }
            }
        }
    }
}

Write-Host "`n✅ 云控制台部署完成" -ForegroundColor Green
if ($Domain) { Write-Host "  URL: https://$Domain/" } else { Write-Host "  URL: https://$ProjectName.pages.dev/" }
Write-Host "  提示：控制面后端需单独部署；Pages 仅托管前端静态资源。" -ForegroundColor DarkGray
