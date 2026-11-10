<#
  Installs Meshbox for the current user (no admin needed):
    - copies .\dist\Meshbox to %LOCALAPPDATA%\Programs\Meshbox
    - Start menu shortcut (and a Desktop one with -Desktop)
    - adds it to "Open with" for FBX, BLEND, GLB, OBJ... (your default apps are not changed)
    - an entry in Settings > Apps so it can be uninstalled like any app
  Run .\build.ps1 first.
#>
param([switch]$Desktop, [switch]$NoOpenWith)
$ErrorActionPreference = 'Stop'
$name = 'Meshbox'
$src = Join-Path $PSScriptRoot "dist\$name"
$dest = Join-Path $env:LOCALAPPDATA "Programs\$name"
$exe = Join-Path $dest 'Meshbox.exe'
if (-not (Test-Path (Join-Path $src 'Meshbox.exe'))) { throw "Build first: .\build.ps1 (missing $src)" }

# The .NET 8 Desktop Runtime is required.
$hasRuntime = (& dotnet --list-runtimes 2>$null) -match 'Microsoft\.WindowsDesktop\.App 8\.'
if (-not $hasRuntime) { Write-Warning 'The .NET 8 Desktop Runtime was not found: https://dotnet.microsoft.com/download/dotnet/8.0' }

Get-Process Meshbox -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item "$src\*" $dest -Recurse -Force

function New-Shortcut($path) {
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($path)
    $s.TargetPath = $exe
    $s.WorkingDirectory = $dest
    $s.IconLocation = "$exe,0"
    $s.Description = 'Fast viewer and organizer for FBX, Blender and glTF models'
    $s.Save()
}
$programs = [Environment]::GetFolderPath('Programs')
New-Shortcut (Join-Path $programs "$name.lnk")
if ($Desktop) { New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk") }

if (-not $NoOpenWith) { & $exe --register | Out-Null }

# Settings > Apps entry
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Meshbox'
New-Item $key -Force | Out-Null
$size = [int]((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
$version = (Get-Item $exe).VersionInfo.ProductVersion
Set-ItemProperty $key -Name DisplayName -Value $name
Set-ItemProperty $key -Name DisplayVersion -Value $version
Set-ItemProperty $key -Name Publisher -Value 'Meshbox'
Set-ItemProperty $key -Name DisplayIcon -Value "$exe,0"
Set-ItemProperty $key -Name InstallLocation -Value $dest
Set-ItemProperty $key -Name UninstallString -Value "`"$exe`" --uninstall"
Set-ItemProperty $key -Name EstimatedSize -Value $size -Type DWord
Set-ItemProperty $key -Name NoModify -Value 1 -Type DWord
Set-ItemProperty $key -Name NoRepair -Value 1 -Type DWord

Write-Host "Installed to $dest" -ForegroundColor Green
Write-Host 'Start menu: Meshbox. To make it the default for .fbx: right-click an .fbx > Open with > Choose another app > Meshbox > Always.'
