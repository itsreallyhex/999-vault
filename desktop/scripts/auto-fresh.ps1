# Rebuild and reopen the app when its Rust side has changed.
#
# Run by the Claude Code Stop hook in .claude/settings.json, at the end
# of every turn. Without -Build it only decides: if nothing under
# src-tauri/ is newer than the release exe, it exits at once. If
# something is, it starts a hidden copy of itself with -Build and
# returns, so the hook is never waiting on a compile.
#
# With -Build it does the work: close the app, build, open the new one
# (the same three steps as `npm run fresh`, done here rather than through
# it, because cmd's `start` hands the launched app the log file handle
# and the app then holds the log for as long as it runs), then prunes the
# installers so only the newest NSIS and MSI remain. Everything goes to
# target/auto-fresh.log.
#
# A lock file stops two builds overlapping. A change that lands while
# a build is running is picked up by the next turn's check, because the
# exe it writes will be older than that change.

param([switch]$Build)

$ErrorActionPreference = 'SilentlyContinue'

$desktop = Split-Path -Parent $PSScriptRoot
$tauri   = Join-Path $desktop 'src-tauri'
$target  = Join-Path $tauri 'target'
$exe     = Join-Path $target 'release\vault999.exe'
$log     = Join-Path $target 'auto-fresh.log'
$lock    = Join-Path $target 'auto-fresh.lock'

function Log($text) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $text" | Out-File $log -Append -Encoding utf8 }

# What counts as the Rust side. target/ is excluded by not being listed.
$watched = @(
  (Join-Path $tauri 'src'),
  (Join-Path $tauri 'icons'),
  (Join-Path $tauri 'Cargo.toml'),
  (Join-Path $tauri 'Cargo.lock'),
  (Join-Path $tauri 'tauri.conf.json'),
  (Join-Path $tauri 'build.rs')
)

function NewestChange {
  $latest = [datetime]::MinValue
  foreach ($p in $watched) {
    if (-not (Test-Path $p)) { continue }
    $items = if (Test-Path $p -PathType Container) { Get-ChildItem $p -Recurse -File } else { Get-Item $p }
    foreach ($i in $items) { if ($i.LastWriteTime -gt $latest) { $latest = $i.LastWriteTime } }
  }
  return $latest
}

function BuildRunning {
  if (-not (Test-Path $lock)) { return $false }
  $owner = Get-Content $lock -ErrorAction SilentlyContinue
  if ($owner -and (Get-Process -Id $owner -ErrorAction SilentlyContinue)) { return $true }
  Remove-Item $lock -Force -ErrorAction SilentlyContinue   # stale: the process is gone
  return $false
}

if (-not $Build) {
  # ---- The hook: decide, and hand off ----
  $built = if (Test-Path $exe) { (Get-Item $exe).LastWriteTime } else { [datetime]::MinValue }
  $changed = NewestChange
  if ($changed -le $built) { exit 0 }
  if (BuildRunning) { exit 0 }

  New-Item -ItemType Directory -Force $target | Out-Null
  # The path has a space in it and Start-Process does not quote array
  # elements on its own, so the quotes go in by hand.
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Build'
  ) | Out-Null

  # Shown in the Claude Code UI
  Write-Output '{"systemMessage":"999: the Rust side changed. Rebuilding the app in the background; it will close and reopen itself when done (about 3 minutes). Log: desktop/src-tauri/target/auto-fresh.log"}'
  exit 0
}

# ---- The build, in the hidden child ----
$PID | Out-File $lock -Encoding ascii
Log "build start"

$vcvars = Get-ChildItem "C:\Program Files*\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat" -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName
$prefix = if ($vcvars) { "`"$vcvars`" >nul && " } else { "" }

# Name the linker outright rather than trusting PATH order. Claude Code's
# own environment puts Git's usr\bin first, and three builds in a row
# (2026-09-13, the first with a crate that had to be linked fresh) picked
# up Git's coreutils link.exe through npx despite vcvars, failing with
# "link: extra operand". rustc honours this variable over PATH. vcvars
# is still run for LIB and INCLUDE.
$link = Get-ChildItem "C:\Program Files*\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if ($link) {
  $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $link
  Log "linker $link"
} else {
  Log "no MSVC link.exe found; trusting PATH"
}

# 1. Close the running app: a locked exe fails the build.
Get-Process vault999 -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. Build. Output appended to the log through a build-only redirect, so
#    nothing launched afterwards inherits the handle.
$before = if (Test-Path $exe) { (Get-Item $exe).LastWriteTime } else { [datetime]::MinValue }
cmd /c "$prefix set PATH=%USERPROFILE%\.cargo\bin;%PATH% && cd /d `"$desktop`" && npx tauri build >> `"$log`" 2>&1"

# 3. Open the new one, only if the build actually produced one.
$after = if (Test-Path $exe) { (Get-Item $exe).LastWriteTime } else { [datetime]::MinValue }
if ($after -gt $before) {
  Log "exe written $after"
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
  Log "app opened"
} else {
  Log "build failed: exe not updated (was $before). See the output above."
}

# Keep only the newest installer of each kind
foreach ($kind in 'nsis', 'msi') {
  $dir = Join-Path $target "release\bundle\$kind"
  if (-not (Test-Path $dir)) { continue }
  $old = Get-ChildItem $dir -File | Sort-Object LastWriteTime -Descending | Select-Object -Skip 1
  foreach ($f in $old) { Remove-Item $f.FullName -Force; Log "deleted old installer $($f.Name)" }
}

Remove-Item $lock -Force
Log "done"
