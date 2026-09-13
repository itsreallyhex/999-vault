# Build the app by hand: `npm run build`, or `npm run fresh` to close the
# running app first and open the new one after. The environment (MSVC
# linker, signing key) comes from env.ps1, which is why this is a script
# rather than a line in package.json: cmd cannot read the key file into
# a variable, and PowerShell cannot hold an empty one.

param([switch]$Fresh)

$ErrorActionPreference = 'Continue'
$desktop = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $desktop 'src-tauri\target\release\vault999.exe'

. (Join-Path $PSScriptRoot 'env.ps1')
if (-not $signed) { Write-Warning "No signing key in ~/.tauri; the build will stop at the updater artifacts" }

if ($Fresh) { Get-Process vault999 -ErrorAction SilentlyContinue | Stop-Process -Force }

$before = if (Test-Path $exe) { (Get-Item $exe).LastWriteTime } else { [datetime]::MinValue }
cmd /c "$prefix set PATH=%USERPROFILE%\.cargo\bin;%PATH% && cd /d `"$desktop`" && npx tauri build"
$after = if (Test-Path $exe) { (Get-Item $exe).LastWriteTime } else { [datetime]::MinValue }

if ($after -le $before) { Write-Error "the build did not write a new exe"; exit 1 }
if ($Fresh) { Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) }
