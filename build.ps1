<#
  Builds Meshbox:
    1. bundles the web UI (three.js) with esbuild
    2. publishes the .NET 8 host into .\dist\Meshbox\ (framework-dependent, ReadyToRun for a faster start)
    3. makes .\dist\MeshboxSetup.exe, a one-file installer with dist\Meshbox inside
  Install by running dist\MeshboxSetup.exe (or .\install.ps1 while developing).
#>
param([switch]$SkipWeb, [switch]$SkipSetup)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$out = Join-Path $root 'dist\Meshbox'

Push-Location $root
try {
    if (-not (Test-Path 'node_modules\three')) { npm ci }
    if (-not $SkipWeb) { node tools/patch-fbxloader.mjs; node tools/build-web.mjs }

    Get-Process Meshbox -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$out*" } | Stop-Process -Force
    Start-Sleep -Milliseconds 500
    if (Test-Path $out) { Remove-Item $out -Recurse -Force }
    dotnet publish src\Host\Meshbox.csproj -c Release -r win-x64 --self-contained false `
        -p:PublishReadyToRun=true -p:DebugType=none -o $out
    if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

    # Leftovers the app does not need.
    Get-ChildItem $out -Recurse -Include '__pycache__' -Directory | Remove-Item -Recurse -Force
    $size = (Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
    Write-Host ("Built {0} ({1:N1} MB)" -f $out, $size) -ForegroundColor Green

    if (-not $SkipSetup) {
        # One-file installer: the app folder zipped and embedded in MeshboxSetup.exe.
        $version = (Get-Item (Join-Path $out 'Meshbox.exe')).VersionInfo.ProductVersion.Split('+')[0]
        $stage = Join-Path $root 'obj\setup'
        $payload = Join-Path $stage 'Meshbox.zip'
        if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
        New-Item -ItemType Directory -Force $stage | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::CreateFromDirectory($out, $payload, [System.IO.Compression.CompressionLevel]::Optimal, $false)
        dotnet publish src\Setup\MeshboxSetup.csproj -c Release -r win-x64 --self-contained false `
            -p:PublishSingleFile=true -p:DebugType=none "-p:Version=$version" "-p:PayloadZip=$payload" -o (Join-Path $stage 'publish')
        if ($LASTEXITCODE -ne 0) { throw 'dotnet publish (setup) failed' }
        $setup = Join-Path $root 'dist\MeshboxSetup.exe'
        Copy-Item (Join-Path $stage 'publish\MeshboxSetup.exe') $setup -Force
        Write-Host ("Built {0} ({1:N1} MB)" -f $setup, ((Get-Item $setup).Length / 1MB)) -ForegroundColor Green
    }
}
finally { Pop-Location }
