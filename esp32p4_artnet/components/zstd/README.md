# zstd 组件（仅解压）

本组件封装上游 [facebook/zstd](https://github.com/facebook/zstd) 的**解压**部分，供固件回放 `.artrec` 节目时解压 Chunk。

## 为什么要手动拉取源码

- 官方组件注册表里的 `rderr/esp-idf-zstd` 未把 ESP32-P4 列入 target，组件管理器可能直接拒绝。
- 直接 vendored 整个 zstd(含压缩、字典、legacy)体积大且用不到。

因此只拉取固定版本的上游源码，并裁剪到解压所需的 `lib/common` 与 `lib/decompress`。上游源码不纳入版本管理(见根 `.gitignore`)。

## 固定版本

**zstd v1.5.6**(发布 tag `v1.5.6`)。如需升级版本，改下面脚本里的 `ZSTD_TAG` 并重新验证。

## 拉取方法

在 `components/zstd/` 目录下执行其一：

Windows(PowerShell):

```powershell
./fetch_zstd.ps1
```

Linux / macOS:

```bash
./fetch_zstd.sh
```

脚本会：

1. 下载 `v1.5.6` 源码压缩包。
2. 只解压 `lib/common/*`、`lib/decompress/*`、`lib/zstd.h`、`lib/zstd_errors.h` 到 `upstream/lib/`。
3. 删除压缩、字典、legacy、deprecated 等用不到的目录。

完成后 `upstream/lib/` 应包含：

```
upstream/lib/
├── zstd.h
├── zstd_errors.h
├── common/      (error_private.c, entropy_common.c, fse_decompress.c, xxhash.c, zstd_common.c, pool.c, threading.c, debug.c ...)
└── decompress/  (huf_decompress.c, zstd_ddict.c, zstd_decompress.c, zstd_decompress_block.c ...)
```

## 注意

- 构建时若报 “zstd 上游源码缺失”，说明还没运行拉取脚本。
- 本组件在 CMake 里对上游 `.c` 加了 `-w`，避免 GCC 15 的新告警在本工程 `-Werror` 下中断构建。
- CRC16、`.artrec` 头解析在 `artrec` 组件，不依赖 zstd；无压缩的 `.artrec` 不走本组件。
