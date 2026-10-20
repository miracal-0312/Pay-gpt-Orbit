# ============================================================
# Pay-gpt-Orbit — Windows 安装脚本 (PowerShell)
# 默认仅安装 API 服务；本地浏览器流程加 -WithBrowser
# ============================================================

param([switch]$WithBrowser)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

function Write-Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-OK($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host "  Pay-gpt-Orbit — Windows 安装" -ForegroundColor White
Write-Host "============================================" -ForegroundColor White
Write-Host ""

# 检查 Node.js
Write-Info "检查 Node.js..."
try {
    $nodeVersion = (node -v) -replace 'v', ''
    $major = [int]($nodeVersion.Split('.')[0])
    if ($major -lt 24) {
        Write-Err "需要 Node.js >= 24，当前: v$nodeVersion。请从 https://nodejs.org 安装 24 LTS。"
    }
    Write-OK "Node.js v$nodeVersion"
} catch {
    Write-Err "未安装 Node.js。请从 https://nodejs.org 下载安装 Node.js 24 LTS。"
}

# 安装 npm 依赖
Write-Info "安装 npm 依赖..."
npm.cmd ci --omit=dev --ignore-scripts
if ($LASTEXITCODE -ne 0) { Write-Err "npm ci 失败" }
Write-OK "npm 依赖已安装"

# 安装 Playwright Chromium
if ($WithBrowser) {
    Write-Info "安装 Playwright Chromium 浏览器..."
    npx.cmd playwright install chromium
    if ($LASTEXITCODE -ne 0) { Write-Err "Playwright 浏览器安装失败" }
    Write-OK "Chromium 已安装；Python 验证码组件请参阅 DEPLOY.md"
} else {
    Write-Info "Orbitcard API 模式无需 Chromium / Python；本地自动化可加 -WithBrowser 安装。"
}

# 配置环境变量
if (-Not (Test-Path ".env")) {
    Copy-Item -LiteralPath ".env.example" -Destination ".env"
    Write-Warn "已创建 .env，请填写数据库、管理员信息和 ORBITCARD_API_SECRET"
} else {
    Write-OK ".env 文件已存在"
}

Write-Host ""
Write-OK "============================================"
Write-OK "  安装完成！"
Write-OK "============================================"
Write-Host ""
Write-Host "下一步操作：" -ForegroundColor White
Write-Host "  1. 编辑配置: notepad .env"
Write-Host "  2. 确保 MySQL 已运行并填写正确的连接信息"
Write-Host "  3. 启动服务: npm.cmd start"
Write-Host "  4. 访问后台: http://localhost:3000/admin-login（或已设置的端口/路径）"
Write-Host "  5. 配置 Orbitcard API Key 和平台卡 ID，测试连接后启用第三方代充"
Write-Host ""
