#requires -Version 5.1
# 拉取固定版本的 libzstd 源码，只保留解压所需部分到 upstream/lib。
# 用法：在 components/zstd/ 目录下执行 ./fetch_zstd.ps1
$ErrorActionPreference = "Stop"

$ZstdTag = "v1.5.6"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$upstream = Join-Path $here "upstream"
$tmp = Join-Path $here ".zstd_tmp"

Write-Host "拉取 zstd $ZstdTag ..."

if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Path $tmp | Out-Null

$zipUrl = "https://github.com/facebook/zstd/archive/refs/tags/$ZstdTag.zip"
$zipPath = Join-Path $tmp "zstd.zip"
Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath

Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
$srcLib = Join-Path $tmp "zstd-$($ZstdTag.TrimStart('v'))/lib"

if (Test-Path $upstream) { Remove-Item -Recurse -Force $upstream }
$dstLib = Join-Path $upstream "lib"
New-Item -ItemType Directory -Path (Join-Path $dstLib "common") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dstLib "decompress") | Out-Null

# 头文件
Copy-Item (Join-Path $srcLib "zstd.h") $dstLib
Copy-Item (Join-Path $srcLib "zstd_errors.h") $dstLib
# 仅解压所需源码与头
Copy-Item (Join-Path $srcLib "common/*") (Join-Path $dstLib "common") -Recurse
Copy-Item (Join-Path $srcLib "decompress/*") (Join-Path $dstLib "decompress") -Recurse

Remove-Item -Recurse -Force $tmp

Write-Host "完成。upstream/lib 已就绪。"
