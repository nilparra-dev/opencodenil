# Installs or updates opencodenil (the nilparra-dev/opencodenil fork of OpenCode) on Windows x64.
#
#   irm https://raw.githubusercontent.com/nilparra-dev/opencodenil/custom/script/fork-install.ps1 | iex
#
# Set $env:OPENCODENIL_VERSION (for example "2.0.16-nil.1") to install a specific release.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repo = "nilparra-dev/opencodenil"
$dir = Join-Path $HOME ".opencodenil\bin"
$exe = Join-Path $dir "opencodenil.exe"

$tag = if ($env:OPENCODENIL_VERSION) { "v$($env:OPENCODENIL_VERSION.TrimStart('v'))" } else {
  (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
}
$zip = Join-Path ([IO.Path]::GetTempPath()) "opencodenil-$tag.zip"

Write-Host "Downloading opencodenil $tag"
Invoke-WebRequest "https://github.com/$repo/releases/download/$tag/opencodenil-windows-x64.zip" -OutFile $zip

New-Item -ItemType Directory -Force $dir | Out-Null
# Windows cannot overwrite a running executable, but it can rename it. The background server
# may still run an older binary, so each replaced one gets its own name and is removed once free.
Get-ChildItem $dir -Filter "opencodenil.exe.*.old" | Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path $exe) { Move-Item $exe "$exe.$([guid]::NewGuid().ToString('N')).old" }
Expand-Archive -Force $zip $dir
Remove-Item $zip
Get-ChildItem $dir -Filter "opencodenil.exe.*.old" | Remove-Item -Force -ErrorAction SilentlyContinue

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($userPath -split ";") -contains $dir)) {
  [Environment]::SetEnvironmentVariable("Path", (@($userPath, $dir) | Where-Object { $_ }) -join ";", "User")
  $env:Path = "$env:Path;$dir"
  Write-Host "Added $dir to your user PATH. Open a new terminal to use it everywhere."
}

Write-Host "Installed $(& $exe --version) at $exe"
