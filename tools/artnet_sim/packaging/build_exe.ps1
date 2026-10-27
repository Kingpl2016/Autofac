# 把 artnet-sim 打成单文件 exe,产物在 tools/artnet_sim/dist/artnet-sim.exe。
# 用法(在 tools/artnet_sim 下):  powershell -File packaging/build_exe.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $python = Join-Path $root ".venv\Scripts\python.exe"
    if (-not (Test-Path $python)) { $python = "python" }
    & $python -m pip install -e ".[build]"
    if ($LASTEXITCODE -ne 0) { throw "安装构建依赖失败" }
    & $python -m PyInstaller packaging/artnet-sim.spec --noconfirm --clean `
        --distpath dist --workpath build/pyinstaller
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller 构建失败" }
    Write-Host "完成:$(Join-Path $root 'dist\artnet-sim.exe')"
}
finally {
    Pop-Location
}
