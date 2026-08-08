<#
.SYNOPSIS
    Install the `pi` wrapper function that translates `pi usage` -> `pi-usage`.

.DESCRIPTION
    The pi CLI treats positional arguments as messages, so the literal form
    `pi usage` must be intercepted by a PowerShell wrapper function and
    forwarded to the standalone viewer `pi-usage` (the npm bin shipped by the
    pi-usage-statistics package). `pi-usage` opens the statistics dashboard
    directly WITHOUT starting a pi session — no AgentSession, no session
    files, no LLM calls; Esc restores the terminal and exits. Every other
    `pi` invocation passes through unchanged.

    The wrapper is installed idempotently into $PROFILE: any existing managed
    block (marked with `# === pi-usage-statistics wrapper ===`) is removed —
    complete blocks, duplicates, and orphaned fragments alike — and one fresh
    block is appended. Re-running this script always converges to a single
    copy of the latest wrapper version and never duplicates it.

.NOTES
    `pi usage` requires the standalone viewer to be installed FIRST:
      npm install -g pi-token-usage-statistics
    The viewer reads the same durable records as the pi extension
    (`<agent-dir>/token-usage-statistics/records.jsonl`), so the extension
    should also be installed (`pi install git:github.com/Techd81/pi-usage-statistics`
    and restart pi) — otherwise the dashboard has no data to show.

    The wrapper takes effect in NEW PowerShell sessions (or after `. $PROFILE`).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$markerStart = "# === pi-usage-statistics wrapper (managed by install-pi-usage.ps1) ==="
$markerEnd   = "# === end pi-usage-statistics wrapper ==="

# Single-quoted here-string: no variable expansion — the literal function body
# is stored. `pi` resolves with Get-Command -CommandType Application/ExternalScript,
# which excludes the wrapper function itself, so the real pi executable is
# resolved (no recursion). `pi-usage` is a SEPARATE npm bin, never the wrapper.
$wrapper = @'
# === pi-usage-statistics wrapper (managed by install-pi-usage.ps1) ===
# Translates `pi usage [args...]` into `pi-usage [args...]` — the standalone
# statistics viewer (htop-style TUI, no pi session, Esc to exit). All other
# invocations pass through unchanged.
# Requires the pi-usage-statistics package to be installed (`npm i -g`).
function pi {
    $realPi = $script:piUsageRealCommand
    if (-not $realPi) {
        # pi.cmd: npm shim; pi.ps1: ExternalScript (not Application); bare pi:
        # PATHEXT lookup (pi.exe / pi.bat ...). Application/ExternalScript
        # exclude the wrapper function itself, so this never recurses.
        $cmd = Get-Command pi.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cmd) { $cmd = Get-Command pi.ps1 -CommandType ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 }
        if (-not $cmd) { $cmd = Get-Command pi -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
        if (-not $cmd) { Write-Error 'pi executable not found on PATH'; return }
        $realPi = $cmd.Source
        $script:piUsageRealCommand = $realPi
    }
    if ($args.Count -gt 0 -and $args[0] -eq 'usage') {
        $rest = @($args | Select-Object -Skip 1)
        # pi-usage is a distinct npm bin (pi-usage.cmd / pi-usage.ps1); resolve
        # it explicitly so the viewer is found even when invoked as `pi usage`.
        $usageBin = Get-Command pi-usage -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $usageBin) {
            Write-Error 'pi-usage not found on PATH — install the pi-usage-statistics package (npm i -g pi-token-usage-statistics)'
            return
        }
        & $usageBin.Source @rest
    } else {
        & $realPi @args
    }
}
# === end pi-usage-statistics wrapper ===
'@

$block = $wrapper.Trim("`r", "`n")

# Ensure $PROFILE and its parent directory exist.
$profileDir = Split-Path -Parent $PROFILE
if ($profileDir -and -not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
}
if (-not (Test-Path $PROFILE)) {
    New-Item -ItemType File -Force -Path $PROFILE | Out-Null
}

$content = Get-Content -Raw -Path $PROFILE
# A freshly created (empty) profile yields $null — treat it as empty text.
if ($null -eq $content) { $content = "" }
$hadManaged = $content.IndexOf($markerStart) -ge 0

# A complete managed block is start marker ... end marker (may span lines).
$pattern = '(?s)' + [regex]::Escape($markerStart) + '.*?' + [regex]::Escape($markerEnd)

# 1. Remove every complete managed block — one, many, or stale duplicates.
$content = [regex]::Replace($content, $pattern, "")

# 2. An orphan start marker (block whose end marker was lost to a hand edit)
#    means the managed region runs to the end of the file: cut it off.
$startIdx = $content.IndexOf($markerStart)
if ($startIdx -ge 0) {
    $content = $content.Substring(0, $startIdx)
}

# 3. Drop orphan end markers (end marker without a start marker).
$content = [regex]::Replace($content, '(?m)^[ \t]*' + [regex]::Escape($markerEnd) + '[^\r\n]*\r?\n?', "")

# 4. Append one fresh block, keeping a single blank line separator.
if ($content -eq "") {
    $content = $block + "`n"
} else {
    $content = [regex]::Replace($content, '(?:\r?\n)*\z', "`n") + "`n" + $block + "`n"
}

# utf8 keeps Windows PowerShell 5.1 happy (BOM) and matches pwsh 7 defaults.
Set-Content -Path $PROFILE -Value $content -Encoding utf8

Write-Host ""
if ($hadManaged) {
    Write-Host "  pi wrapper updated in: $PROFILE" -ForegroundColor Green
} else {
    Write-Host "  pi wrapper installed in: $PROFILE" -ForegroundColor Green
}
Write-Host ""
Write-Host "  Now you can run:  pi usage" -ForegroundColor Cyan
Write-Host "  Equivalent to:     pi-usage  (standalone viewer — no pi session, Esc to exit)"
Write-Host "  All other pi calls (pi -c, pi --help, pi install ...) pass through unchanged."
Write-Host ""
Write-Host "  Requirements:" -ForegroundColor Yellow
Write-Host "    - pi-usage-statistics package installed (npm i -g pi-token-usage-statistics)"
Write-Host "    - pi extension installed for data (pi install git:github.com/Techd81/pi-usage-statistics)"
Write-Host ""
Write-Host "  The wrapper applies to NEW PowerShell sessions (or run: . $PROFILE)."
Write-Host ""
