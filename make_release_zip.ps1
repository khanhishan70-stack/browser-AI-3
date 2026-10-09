$ErrorActionPreference = 'Stop'
$base = 'C:\Users\Admin\OneDrive\Desktop\browser AI'
$stamp = Get-Date -Format 'yyyyMMdd_HHmm'
$outZip = Join-Path $base "NEXORA_Browser_$stamp.zip"
$staging = Join-Path $env:TEMP 'opencode\nexora_release_staging'

Write-Host '== NEXORA Browser release builder ==' -ForegroundColor Cyan

# 0) Nuke stale dist to prevent old junk leaking in
Remove-Item (Join-Path $base 'dist') -Recurse -Force -ErrorAction SilentlyContinue

# 1) Build the portable app (fresh, always). Uses the local cached Electron zip
#    (Widevine / ECS "wvcus" build) so no big download is needed.
Write-Host '[1/4] Building packaged browser...'
$cachedZip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Directory |
  ForEach-Object { Get-ChildItem $_.FullName -Filter '*wvcus*win32-x64*.zip' -ErrorAction SilentlyContinue } |
  Select-Object -First 1
Push-Location (Join-Path $base 'electron')
try {
  if ($cachedZip) {
    Write-Host "   Using cached ECS Electron zip: $($cachedZip.Name)"
    $ecsTmp = Join-Path $env:TEMP 'opencode\ecs_zip'
    New-Item -ItemType Directory -Path $ecsTmp -Force | Out-Null
    $renamed = Join-Path $ecsTmp 'electron-v42.3.0-win32-x64.zip'
    if (-not (Test-Path $renamed)) { Copy-Item $cachedZip.FullName $renamed -Force }
    & npx.cmd @electron/packager . NEXORA --platform=win32 --arch=x64 --out=../dist --overwrite --no-asar --icon=assets/nexora-icon.ico --version-string.ProductName="NEXORA Browser" --version-string.CompanyName="NEXORA" --version-string.FileDescription="NEXORA Browser" --version-string.OriginalFilename="NEXORA.exe" "--electronZipDir=$ecsTmp" 2>&1 | ForEach-Object { Write-Host "   $_" }
  } else {
    Write-Host '   No cached ECS zip; trying network build...'
    & npm.cmd run build 2>&1 | ForEach-Object { Write-Host "   $_" }
  }
  if ($LASTEXITCODE -ne 0) { throw "packager failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
$built = Join-Path $base 'dist\NEXORA-win32-x64\NEXORA.exe'
if (-not (Test-Path $built)) { throw "Expected build output not found: $built" }
Write-Host '   Build OK.' -ForegroundColor Green

# 1.5) Strip stale build copies that leak into resources\app (packager ignore is unreliable)
$appDir = Join-Path $base 'dist\NEXORA-win32-x64\resources\app'
foreach ($junk in @('dist_v2', 'dist_v2_COPY', 'dist_new', 'dist', 'vendor', '.git')) {
  Remove-Item (Join-Path $appDir $junk) -Recurse -Force -ErrorAction SilentlyContinue
}

# 2) Clean staging
Write-Host '[2/4] Preparing clean release folder...'
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
$stageRoot = Join-Path $staging 'NEXORA Browser'
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

# Copy the packaged app (this is the only "big" thing; short paths, no node_modules)
Copy-Item -Recurse (Join-Path $base 'dist\NEXORA-win32-x64') (Join-Path $stageRoot 'NEXORA-win32-x64')

# Copy backend SOURCES only (no venv - it is machine-specific and breaks in a zip;
# launch.bat re-creates it automatically on the first run)
$srcBackend = Join-Path $base 'ai UI DESIGN\backend'
$dstBackend = Join-Path $stageRoot 'ai UI DESIGN\backend'
New-Item -ItemType Directory -Path $dstBackend -Force | Out-Null
Get-ChildItem $srcBackend -Force | ForEach-Object {
  $skip = $_.Name -in @('venv', '__pycache__', '.git')
  if ($_.PSIsContainer -and $skip) { Write-Host "   skipped folder: $($_.Name)" ; return }
  if (-not $_.PSIsContainer -and $_.Name -like '*.log') { Write-Host "   skipped log: $($_.Name)"; return }
  Copy-Item -Recurse $_.FullName (Join-Path $dstBackend $_.Name)
}

# Launcher
Copy-Item (Join-Path $base 'launch.bat') (Join-Path $stageRoot 'launch.bat')

# Report size before zipping
$appSize = [math]::Round((Get-ChildItem "$stageRoot\NEXORA-win32-x64" -Recurse -File | Measure-Object Length -Sum).Sum/1MB, 1)
Write-Host "   App size: $appSize MB"

# 3) Zip with Compress-Archive (reliable, standard Windows ZIP)
Write-Host '[3/4] Creating ZIP...'
Compress-Archive -Path "$stageRoot" -DestinationPath $outZip -CompressionLevel Optimal -Force
if (-not (Test-Path $outZip)) { throw 'Compress-Archive produced no output' }

# Validate ZIP is actually readable
Add-Type -AssemblyName System.IO.Compression.FileSystem
$test = [System.IO.Compression.ZipFile]::OpenRead($outZip)
$fileCount = $test.Entries.Count
$test.Dispose()

$sizeMB = [math]::Round((Get-Item $outZip).Length / 1MB, 1)
Write-Host "[4/4] Done. ($fileCount files inside)" -ForegroundColor Green
Write-Host "ZIP:  $outZip" -ForegroundColor Green
Write-Host "Size: ${sizeMB} MB"
Write-Host ''
Write-Host 'To hand this to users: they extract the folder, open "NEXORA Browser",'
Write-Host 'double-click launch.bat (or NEXORA-win32-x64\NEXORA.exe directly).'
Write-Host 'First run will ask for Python (once) to auto-create the backend venv.'
