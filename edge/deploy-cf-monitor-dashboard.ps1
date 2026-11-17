#requires -Version 5.1
param(
    [string]$ProjectName = "mobihop-monitor-dashboard",
    [string]$WorkerUrl = "",
    [string]$AccountId = "",
    [switch]$SkipDeploy
)

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnvFile = Join-Path $Repo ".local\devices.env"
$Src = Join-Path $Repo "edge\cf-worker-relay\dashboard.html"
$Stage = Join-Path $Repo ".cf-stage\monitor-dashboard"

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
if (-not $Token) { throw "缺少 Cloudflare 令牌" }
if (-not $AccountId) { throw "缺少 Account ID" }
$env:CLOUDFLARE_API_TOKEN = $Token
$env:CLOUDFLARE_ACCOUNT_ID = $AccountId

if (-not $WorkerUrl) {
    # derive from env or prompt
    if ($vars.ContainsKey("MH_MONITOR_URL")) { $WorkerUrl = $vars["MH_MONITOR_URL"] }
    else { $WorkerUrl = Read-Host "Worker URL (e.g. https://monitor.example.com)" }
}

# stage
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
$content = Get-Content $Src -Raw -Encoding UTF8
$content = $content -replace '__MONITOR_API__', $WorkerUrl
Set-Content -Path (Join-Path $Stage "index.html") -Value $content -Encoding UTF8

if ($SkipDeploy) { Write-Host "staged at $Stage"; return }

# ensure project
$projList = & npx -y wrangler@4 pages project list 2>$null
if (-not ($projList -match [regex]::Escape($ProjectName))) {
    & npx -y wrangler@4 pages project create $ProjectName --production-branch main
}
& npx -y wrangler@4 pages deploy $Stage --project-name $ProjectName --branch main --commit-dirty
if ($LASTEXITCODE -ne 0) { throw "pages deploy 失败" }
Write-Host "`n✅ 监测面板部署完成: https://$ProjectName.pages.dev" -ForegroundColor Green
