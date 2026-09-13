# The environment a build needs. Dot-sourced by build.ps1, auto-fresh.ps1
# and release.ps1, so the three cannot drift.
#
#   $prefix   a cmd fragment that runs vcvars64.bat first, for LIB and
#             INCLUDE, or empty if no Visual Studio was found.
#   linker    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER is set to the
#             MSVC link.exe outright. PATH order is not trusted: Claude
#             Code's own environment puts Git's usr\bin first and three
#             builds picked up its coreutils link.exe despite vcvars.
#   signing   TAURI_SIGNING_PRIVATE_KEY and its password, read from
#             ~/.tauri/999-vault.key and ~/.tauri/999-vault.pass. The
#             installers are signed for the in-app updater and the
#             build refuses without a key. Contents, not a path: the
#             CLI only reads the contents variable, and the key has a
#             password because Windows cannot hold an empty variable,
#             so a passwordless key hangs the build on a prompt.

$vcvars = Get-ChildItem "C:\Program Files*\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat" -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName
$prefix = if ($vcvars) { "`"$vcvars`" >nul && " } else { "" }

$link = Get-ChildItem "C:\Program Files*\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if ($link) { $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $link }

$keyFile  = Join-Path $env:USERPROFILE '.tauri\999-vault.key'
$passFile = Join-Path $env:USERPROFILE '.tauri\999-vault.pass'
$signed = $false
if ((Test-Path $keyFile) -and (Test-Path $passFile)) {
  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyFile -Raw).Trim()
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $passFile -Raw).Trim()
  $signed = $true
}
