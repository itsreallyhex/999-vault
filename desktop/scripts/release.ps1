# Cut a release of the desktop app.
#
#   npm run release -- -Version 0.2.0 -Notes "What changed, in a line or two"
#   npm run release -- -Version 0.2.0 -NotesFile notes.md
#
# In order:
#   1. Refuses if the working tree has changes: the release commit is the
#      version bump and nothing else.
#   2. Writes the version into tauri.conf.json, Cargo.toml and package.json.
#   3. Builds with the signing key, so the NSIS installer gets its .sig.
#      The key is ~/.tauri/999-vault.key with its password in
#      ~/.tauri/999-vault.pass, both outside the repo, made once with
#      `npx tauri signer generate -p <password>`. Lose them and installed
#      copies cannot update, only reinstall. The public half is in
#      tauri.conf.json under plugins.updater.pubkey.
#   4. Writes latest.json, which the app fetches on launch: the version,
#      the notes, the date, and the installer's URL and signature.
#   5. Commits the bump as "Release <version>", pushes the current
#      branch, and creates the GitHub release v<version> with the
#      installer, its .sig and latest.json attached.
#
# Running this is the "push": it pushes and publishes on purpose, which
# is the one place the never-push rule bends, because the owner typed it.
#
# The app's endpoint is .../releases/latest/download/latest.json, and
# GitHub's "latest" skips pre-releases and drafts, so a release cut here
# is a full release. There is no -Prerelease switch for that reason.

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = "",
  [string]$NotesFile = ""
)

$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.2.3, not '$Version'" }
if ($NotesFile) { $Notes = Get-Content $NotesFile -Raw }
if (-not $Notes.Trim()) { throw "Give the release some notes: -Notes '...' or -NotesFile path" }

$desktop = Split-Path -Parent $PSScriptRoot
$repo    = Split-Path -Parent $desktop
$tauri   = Join-Path $desktop 'src-tauri'
$conf    = Join-Path $tauri 'tauri.conf.json'
$cargo   = Join-Path $tauri 'Cargo.toml'
$pkg     = Join-Path $desktop 'package.json'
$bundle  = Join-Path $tauri 'target\release\bundle\nsis'

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) { throw "GitHub CLI (gh) is not installed" }

# ---- 1. A clean tree ----
Push-Location $repo
try {
  $dirty = git status --porcelain
  if ($dirty) { throw "Commit or stash first; the release commit must be the version bump alone:`n$dirty" }
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $remoteUrl = (git remote get-url origin).Trim()
} finally { Pop-Location }
if ($remoteUrl -notmatch 'github\.com[:/]([^/]+)/([^/.]+)') { throw "origin is not a GitHub URL: $remoteUrl" }
$owner = $Matches[1]; $name = $Matches[2]

# ---- 2. The version, in three files ----
$c = Get-Content $conf -Raw | ConvertFrom-Json
$c.version = $Version
($c | ConvertTo-Json -Depth 10) + "`n" | Set-Content $conf -Encoding utf8 -NoNewline

$t = Get-Content $cargo -Raw
$t = [regex]::Replace($t, '(?m)^version = "[^"]+"', "version = `"$Version`"", 1)
Set-Content $cargo $t -Encoding utf8 -NoNewline

$p = Get-Content $pkg -Raw | ConvertFrom-Json
$p.version = $Version
($p | ConvertTo-Json -Depth 10) + "`n" | Set-Content $pkg -Encoding utf8 -NoNewline

Write-Host "version $Version written"

# ---- 3. Build, signed ----
. (Join-Path $PSScriptRoot 'env.ps1')
if (-not $signed) { throw "No signing key: expected $keyFile and $passFile" }

Get-Process vault999 -ErrorAction SilentlyContinue | Stop-Process -Force
cmd /c "$prefix set PATH=%USERPROFILE%\.cargo\bin;%PATH% && cd /d `"$desktop`" && npx tauri build"

$installer = Get-ChildItem $bundle -Filter "*_${Version}_x64-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw "No installer for $Version in $bundle; the build failed" }
if ($installer.LastWriteTime -lt (Get-Date).AddMinutes(-30)) { throw "The installer in $bundle is old; the build did not write one" }
$sig = "$($installer.FullName).sig"
if (-not (Test-Path $sig)) { throw "No signature beside $($installer.Name); was the key set?" }
Write-Host "built $($installer.Name)"

# ---- 4. latest.json ----
$tag = "v$Version"
$assetName = $installer.Name
$url = "https://github.com/$owner/$name/releases/download/$tag/" + [uri]::EscapeDataString($assetName)
$manifest = [ordered]@{
  version  = $Version
  notes    = $Notes.Trim()
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = (Get-Content $sig -Raw).Trim()
      url       = $url
    }
  }
}
$latest = Join-Path $bundle 'latest.json'
($manifest | ConvertTo-Json -Depth 5) + "`n" | Set-Content $latest -Encoding utf8 -NoNewline
Write-Host "wrote latest.json -> $url"

# ---- 5. Commit, push, release ----
Push-Location $repo
try {
  git add -- "$conf" "$cargo" "$pkg" (Join-Path $tauri 'Cargo.lock')
  git commit -q -m "Release $Version"
  git push origin $branch
  gh release create $tag "$($installer.FullName)" "$sig" "$latest" `
    --repo "$owner/$name" --target $branch --title "999 Vault $Version" --notes $Notes.Trim()
} finally { Pop-Location }

Write-Host ""
Write-Host "released $tag: https://github.com/$owner/$name/releases/tag/$tag"
Write-Host "installed copies will offer it the next time they open"
