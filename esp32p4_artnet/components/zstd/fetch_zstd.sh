#!/usr/bin/env bash
# 拉取固定版本的 libzstd 源码，只保留解压所需部分到 upstream/lib。
# 用法：在 components/zstd/ 目录下执行 ./fetch_zstd.sh
set -euo pipefail

ZSTD_TAG="v1.5.6"
here="$(cd "$(dirname "$0")" && pwd)"
upstream="$here/upstream"
tmp="$here/.zstd_tmp"

echo "拉取 zstd $ZSTD_TAG ..."
rm -rf "$tmp"
mkdir -p "$tmp"

curl -fsSL "https://github.com/facebook/zstd/archive/refs/tags/$ZSTD_TAG.tar.gz" -o "$tmp/zstd.tar.gz"
tar -xzf "$tmp/zstd.tar.gz" -C "$tmp"

src_lib="$tmp/zstd-${ZSTD_TAG#v}/lib"

rm -rf "$upstream"
mkdir -p "$upstream/lib/common" "$upstream/lib/decompress"

cp "$src_lib/zstd.h" "$upstream/lib/"
cp "$src_lib/zstd_errors.h" "$upstream/lib/"
cp -r "$src_lib/common/." "$upstream/lib/common/"
cp -r "$src_lib/decompress/." "$upstream/lib/decompress/"

rm -rf "$tmp"
echo "完成。upstream/lib 已就绪。"
