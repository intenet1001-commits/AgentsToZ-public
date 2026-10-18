# ============================================================
# Windows 진단 스크립트 — 포트 관리 프로그램
# 실행: PowerShell에서 .\tests\windows-diagnostics.ps1
# ============================================================

$ErrorActionPreference = "Continue"
$pass = 0
$fail = 0

function Check($label, $ok, $detail = "") {
    if ($ok) {
        Write-Host "  [PASS] $label" -ForegroundColor Green
        if ($detail) { Write-Host "         $detail" -ForegroundColor DarkGray }
        $script:pass++
    } else {
        Write-Host "  [FAIL] $label" -ForegroundColor Red
        if ($detail) { Write-Host "         $detail" -ForegroundColor Yellow }
        $script:fail++
    }
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  포트 관리 프로그램 - Windows 진단 스크립트" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# ── 1. 필수 도구 설치 확인 ────────────────────────────────────
Write-Host ""
Write-Host "[1] 필수 도구 확인" -ForegroundColor White

$bunVer = (bun --version 2>$null)
Check "Bun 설치됨" ($bunVer -ne $null) $bunVer

$gitVer = (git --version 2>$null)
Check "Git 설치됨" ($gitVer -ne $null) $gitVer

$nodeVer = (node --version 2>$null)
Check "Node.js 설치됨 (claude code용)" ($nodeVer -ne $null) $nodeVer

$claudeVer = (claude --version 2>$null)
Check "Claude Code 설치됨" ($claudeVer -ne $null) ($claudeVer ?? "미설치 (AI기능 비활성)")

$sbVer = (supabase --version 2>$null)
Check "Supabase CLI 설치됨" ($sbVer -ne $null) ($sbVer ?? "미설치 → scoop install supabase")

# ── 2. Supabase CLI 로그인 상태 ───────────────────────────────
Write-Host ""
Write-Host "[2] Supabase CLI 로그인 상태" -ForegroundColor White

if ($sbVer) {
    $sbProjects = (supabase projects list 2>&1)
    $loggedIn = $sbProjects -notmatch "not logged in|unauthorized|login"
    Check "Supabase CLI 로그인됨" $loggedIn ($loggedIn ? "프로젝트 목록 조회 성공" : "supabase login 필요")
    if ($loggedIn) {
        Write-Host "         프로젝트 목록:" -ForegroundColor DarkGray
        $sbProjects | Where-Object { $_ -match "\|" -and $_ -notmatch "REFERENCE" -and $_ -notmatch "---" } | ForEach-Object {
            Write-Host "           $_" -ForegroundColor DarkGray
        }
    }
}

# ── 3. 토큰 파일 확인 ─────────────────────────────────────────
Write-Host ""
Write-Host "[3] Supabase 토큰 저장 위치" -ForegroundColor White

$tokenPath1 = "$env:APPDATA\supabase\access-token"
$tokenPath2 = "$env:USERPROFILE\.supabase\access-token"
Check "토큰 파일 존재 ($tokenPath1)" (Test-Path $tokenPath1) $tokenPath1
Check "토큰 파일 존재 ($tokenPath2)" (Test-Path $tokenPath2) $tokenPath2

# ── 4. 앱 실행 상태 확인 ─────────────────────────────────────
Write-Host ""
Write-Host "[4] 앱 서버 상태" -ForegroundColor White

try {
    $apiStatus = Invoke-RestMethod -Uri "http://localhost:3001/api/supabase-cli/status" -TimeoutSec 3 -ErrorAction Stop
    Check "API 서버 실행 중 (포트 3001)" $true "installed=$($apiStatus.installed), loggedIn=$($apiStatus.loggedIn)"
    if ($apiStatus.projects) {
        Check "Supabase CLI 프로젝트 감지됨" $true "$($apiStatus.projects.Count)개 프로젝트"
    }
} catch {
    Check "API 서버 실행 중 (포트 3001)" $false "bun api-server.ts 실행 필요"
}

try {
    $devRes = Invoke-WebRequest -Uri "http://localhost:9000" -TimeoutSec 3 -ErrorAction Stop
    Check "개발 서버 실행 중 (포트 9000)" ($devRes.StatusCode -eq 200) "HTTP $($devRes.StatusCode)"
} catch {
    Check "개발 서버 실행 중 (포트 9000)" $false "bun run dev 실행 필요"
}

# ── 5. 빌드 환경 확인 ────────────────────────────────────────
Write-Host ""
Write-Host "[5] Tauri 빌드 환경" -ForegroundColor White

$rustVer = (rustc --version 2>$null)
Check "Rust 설치됨" ($rustVer -ne $null) ($rustVer ?? "winget install Rustlang.Rustup")

$cargoVer = (cargo --version 2>$null)
Check "Cargo 설치됨" ($cargoVer -ne $null) $cargoVer

$tauriCli = (cargo tauri --version 2>$null)
Check "Tauri CLI 설치됨" ($tauriCli -ne $null) ($tauriCli ?? "cargo install tauri-cli")

# WebView2 확인
$wv2 = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
Check "WebView2 런타임 설치됨" ($wv2 -ne $null) ($wv2?.pv ?? "https://developer.microsoft.com/microsoft-edge/webview2/")

# ── 결과 요약 ─────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  결과: PASS $pass / FAIL $fail" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Yellow" })
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""
if ($fail -gt 0) {
    Write-Host "실패 항목을 먼저 해결하세요. README.md > Windows 트러블슈팅 참고" -ForegroundColor Yellow
}
