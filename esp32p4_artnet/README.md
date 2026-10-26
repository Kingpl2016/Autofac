# ArtNet Core 固件（ESP32-P4）

Waveshare **ESP32-P4-WIFI6-POE-ETH** 核心板固件：接收上位机上传的 `.artrec` 灯光节目存到 SD 卡，在板上回放，经 Art-Net / sACN 向网络灯具推送 DMX。控制 / 文件 / 升级走 HTTP。

- 协议细节见 [`docs/protocol.md`](docs/protocol.md)。
- 节目格式见 [`doc/ArtRec 灯光节目录制文件规范.md`](../doc/ArtRec%20灯光节目录制文件规范.md)。

## 功能

- SD 卡节目增删查改（HTTP）：上传校验 `.artrec` 头、原子落盘、自动编号。
- 按编号播放：播放 / 暂停 / 停止 / 单次 / 循环 / 连播 / seek / 倍速，保活与落后合并，CRC 容错。
- Art-Net 与 sACN 输出，与上位机逐字节一致。
- UART DMX512 有线输出（自实现 DMX512 时序，经 RS-485 驱动），与网络输出并存。
- 实时转发：收网络 Art-Net / sACN，跨来源 HTP 合并后同时下发网络与 UART。
- 总线 MCU 串口协议（可选，默认关）：作纯从机经 UART（566400/8N1、帧头 `0x35`）接收 Etronet MCU 的寄存器指令并回应答。见 [`docs/protocol.md`](docs/protocol.md) 第 11 节。
- DHCP（超时回退静态 IP）、mDNS、ArtPollReply 设备发现；推送式 OTA + 回滚、coredump 落 flash、日志环形缓冲远程取回。

## 开发板

Waveshare ESP32-P4-WIFI6-POE-ETH（SKU 32832 基础款 / 32833 Camera / 32834 Display）。本项目只用**以太网**与 **microSD**，无线 / 音频 / 显示 / 摄像头不启用。

- **主控**：ESP32-P4（模组 ESP32-P4NRW32X），HP 双核 RISC-V 最高 400MHz，叠封 32MB PSRAM，模组 NOR Flash 按 **16MB** 布局。
- **以太网**：IP101(GRI) PHY + P4 EMAC(RMII)，百兆 RJ45，支持 PoE（纯供电，不占 GPIO）。
- **存储**：microSD（SDIO 3.0，4-bit），卡 IO 由片上 LDO_VO4 供电。
- **控制台**：USB-C 经 CH343P → UART0（TX=37 / RX=38）。

板载固定引脚（默认值，上板前对原理图复核）：

| 外设 | 引脚 |
|---|---|
| 以太网 RMII | REF_CLK 50 / TX_EN 49 / TXD0,1 34,35 / CRS_DV 28 / RXD0,1 29,30 / MDC,MDIO 31,52 / PHY_RST 51 / 地址 1 |
| microSD（4-bit） | CLK 43 / CMD 44 / D0–D3 39,40,41,42；LDO 通道 4 |

> 规格与引脚取自微雪官方文档与社区 BSP，经改写，以官方原理图为准。UART / DMX 引脚分配见下文「串口与引脚分配」。

## 构建

要求 **ESP-IDF v6.1**、目标 `esp32p4`。

```bash
# 1) 拉取 zstd 上游源码（仅一次，不入库）
cd components/zstd && ./fetch_zstd.sh        # Windows: ./fetch_zstd.ps1

# 2) 构建烧录
idf.py set-target esp32p4
idf.py build
idf.py -p <PORT> flash monitor
```

- 托管依赖（`ip101` / `mdns` / `cjson` / 测试用 `catch2`）按 `idf_component.yml` 自动下载。
- 若烧录提示 `requires chip revision in range ...`，**勿用 `--force`**，改叠加对应芯片版本的 defaults：
  `idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;<path>/esp32p4_rev_v3_1.defaults" set-target esp32p4 build`
- 运行时配置经 `GET/PUT /api/config`、`PUT /api/workmode`，持久化在 NVS。板级引脚在 `idf.py menuconfig → ArtNet Core 板级配置`。

一键脚本（封装 idf.py + HTTP 推送 OTA，仅标准库，需先激活 IDF 环境）：

```bash
# 构建 / 烧录 / OTA（deploy.py）
python scripts/deploy.py build  --prod --ccache           # 生产构建
python scripts/deploy.py flash  --port COM5 --monitor      # 串口烧录并监视
python scripts/deploy.py ota    --host artnet-core.local --token <TOKEN>   # OTA 推送

# 日常开发（dev.py）
python scripts/dev.py menuconfig
python scripts/dev.py test  --port COM5                    # 片上 Catch2 测试
python scripts/dev.py size  --components                   # 各组件体积
python scripts/dev.py api   --host artnet-core.local --token <TOKEN>   # HTTP 只读冒烟
```

## 串口与引脚分配（已核对官方引脚图）

已对照 Waveshare 官方 40PIN 引脚定义图与《ESP32-P4 数据手册 v0.7》；下表 GPIO 均引出到 40PIN 排针、不与以太网 / SD / 控制台冲突。

ESP32-P4 共 5 个 HP UART，信号经 GPIO 交换矩阵映射：

| 串口 | TX | RX | 波特率 | 用途 | 配置项 |
|---|---|---|---|---|---|
| UART0 | GPIO37 | GPIO38 | 115200 | 控制台（CH343P / SH1.0 座，固定）| — |
| UART1 | GPIO4 | GPIO5 | 566400 | 总线 MCU 串口（Etronet）| `ART_ETRONET_*` |
| UART2 | GPIO2 | — | 250000 | DMX512 口1（TX only）| `ART_DMX_P1_*` |
| UART3 | GPIO20 | — | — | DMX 口2 / 备用 | `ART_DMX_P2_*` |
| UART4 | GPIO22 | — | — | DMX 口3 / 备用 | `ART_DMX_P3_*` |

- **DMX512**：250kbaud/8N2，用 `uart_write_bytes_with_break` 连续刷新（帧尾 BREAK 作下一帧前导）；一口一 universe，口数 1~4 可配；运行时开关为 `PUT /api/config` 的 `uartOutputEnabled`。启用 Etronet（占 UART1）后 DMX 最多 3 口（勿将 `ART_DMX_UART_PORTS` 设为 4）。
- **Etronet**：默认关（`ART_ETRONET_ENABLE=n`），menuconfig 打开。GPIO4/5 在 40PIN 右列相邻且紧邻 GND，便于引 3 线到 MCU。
- **引脚性质**（据数据手册）：strapping 脚为 GPIO34~38（本分配已避开，仅控制台固定用 37/38）；GPIO2/3/4/5 是 JTAG 接口脚（非 strapping，用作 UART 仅占焊盘 JTAG）；GPIO0 为 boot strap、GPIO24/25 为 USB-Serial/JTAG。

<details>
<summary>40PIN 排针完整引脚图</summary>

```
左列                         右列
3V3                          5V
SDA/GPIO7 (I2C)              5V
SCL/GPIO8 (I2C)              GND
GPIO23                       TXD/GPIO37 (UART0)
GND                          RXD/GPIO38 (UART0)
GPIO21                       GPIO22   ← DMX 口3
GPIO20  ← DMX 口2            GND
GPIO6                        GPIO5    ← Etronet RX
3V3                          GPIO4    ← Etronet TX
GPIO3                        GND
GPIO2   ← DMX512 口1 TX      GPIO1
GPIO0 (boot strap)           GPIO36
GND                          GPIO32
GPIO24 (USB-JTAG)            GPIO25 (USB-JTAG)
GPIO33                       GND
GPIO26                       GPIO54
GPIO48                       GND
GPIO53                       GPIO46
GPIO47                       GPIO27
GND                          GPIO45
```
</details>

## 网络

默认 **DHCP** 自动获取；约 10s（`CONFIG_ART_DHCP_TIMEOUT_MS`）拿不到则回退编译期静态地址（默认 `192.168.1.200` / `255.255.255.0` / `192.168.1.1`，见 menuconfig「网络回退与服务」）。mDNS 主机名默认 `artnet-core`，可直接 `http://artnet-core.local` 访问。

**查设备 IP**：`GET http://artnet-core.local/api/status`、串口日志（启动打印 `取得 IP：…`）、上位机 ArtPoll 设备发现、或路由器 DHCP 客户端列表。

**运行时自定义**（`PUT /api/config`，网络字段需重启生效，响应带 `netRebootRequired:true`）：

```jsonc
{"dhcp": true}                        // 用 DHCP
{"dhcp": false, "ip": "192.168.1.50", // 固定 IP
 "netmask": "255.255.255.0", "gateway": "192.168.1.1"}
{"hostname": "my-node"}               // 改主机名
```

`GET /api/config` 回显当前 `dhcp/ip/netmask/gateway/hostname`；`GET /api/status` 另有 `netmask/gateway/viaDhcp`。关闭 DHCP 但未给非 0 `ip` 会被拒（避免落到 0.0.0.0）。

## 架构

```
main/                组合根（均在 main 组件内）
  app_main.cpp         装配与启动时序
  app_context.hpp      Context：集中持有全部子系统实例
  mode_manager.*       工作模式 → 转发/回放门禁
  outputs.*            Kconfig → 串口端口映射，重建网络/UART 输出
  board_lifecycle.*    出厂 / 延迟重启
  etronet_bridge.*     串口帧 → BoardControl
  Kconfig.projbuild    板级配置
components/
  common/            Status / Result、字节序、输出配置、日志环形缓冲
  zstd/              上游 libzstd 解压（源码由脚本拉取）
  artrec/            .artrec 解析 + CRC16 + 随机定位
  dmx_out/           Art-Net/sACN 打包 + UDP 发送 + UART DMX512 + 输出路由
  settings/          NVS 配置（schema 版本）
  storage/           SD 挂载、路径校验、原子替换、剩余空间
  program_store/     编号↔文件映射（programs.json，自愈）
  player/            回放状态机 + 调度
  forwarder/         实时转发（收 Art-Net/sACN → HTP 合并 → 输出路由）
  net/               以太网 + DHCP/静态 + mDNS + ArtPoll 应答
  ota/               推送式 OTA + 回滚
  api_server/        统一 HTTP 服务（控制/文件/节目/配置/OTA/日志）
  control/           核心板控制层：寄存器语义唯一实现，HTTP 与串口共用
  etronet/           总线 MCU 串口协议（566400 / 0x35 帧，纯从机）
test_apps/           Catch2 片上测试
docs/protocol.md     HTTP 协议与互通约定
```

寄存器语义（复位 / 出厂 / 节目操作 / 工作模式 / seek / 倍速）在 `control` 的 `BoardControl` 里只实现一份；`api_server`（HTTP）与 `etronet_bridge`（串口）都是调用它的薄适配器。

## 测试

```bash
idf.py -C test_apps set-target esp32p4
idf.py -C test_apps -p <PORT> flash monitor
```

片上 Catch2：CRC16、Art-Net / sACN 打包、`.artrec` 头解析、文件名校验、总线 MCU 协议编解码/派发等纯逻辑。

## 分区表

16MB flash，双 OTA（各 4MB）+ otadata + coredump（见 `partitions.csv`）。大文件在 SD 卡，flash 不含存储分区。

## 安全

默认（`CONFIG_ART_REQUIRE_AUTH=y`）：

- **HTTP 鉴权**：未配 token 时，变更类 / 高危端点（POST/PUT/DELETE、OTA、出厂、改配、删文件）返回 401，仅放行只读；配 token 后全端点要求 `Authorization: Bearer`。token 经 `PUT /api/config` 的 `httpToken` 设置。
- **token 存储**：NVS 只存 `盐 + SHA-256(salt‖token)`，常量时间比较，永不回显（仅 `tokenSet` 布尔）。
- **OTA**：镜像 SHA-256 校验 + 首启回滚。
- **出厂默认 token**（`CONFIG_ART_DEFAULT_HTTP_TOKEN`）：生产建议设强随机值，避免新设备「无 token 全开放」又无法远程改配的自锁。

生产加固（叠加 `sdkconfig.prod.defaults`，可选）：

- **OTA 固件签名校验**（可逆、不烧 eFuse，推荐）：设备只接受私钥签名的固件。
  ```bash
  espsecure.py generate_signing_key --version 2 secure_boot_signing_key.pem   # 离线保管，勿入库
  idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.prod.defaults" set-target esp32p4 build
  ```
- **Secure Boot v2 / Flash 加密 / eFuse 反回滚**（一次性不可逆）：相关开关在 `sdkconfig.prod.defaults` 末尾注释备查，默认关闭；务必先读 ESP-IDF 安全文档并在报废样片验证。

## 生产日志与编译加速

### 关闭 / 精简日志（生产）

日志经 `esp_log_set_vprintf` tee 到环形缓冲——既出串口也供 `GET /api/logs` 远程取回；**裁掉日志会同时清空这两处**。已在 `sdkconfig.prod.defaults` 内置（叠加该文件即生效，叠加命令见「安全 → 生产加固」）：

- **推荐**（静默但保留 ERROR 供远程诊断）：`CONFIG_LOG_DEFAULT_LEVEL_ERROR=y` + `CONFIG_LOG_MAXIMUM_LEVEL_ERROR=y`（编译期裁掉 INFO/DEBUG/VERBOSE，省 flash 与 CPU）。
- **完全关闭**（`GET /api/logs` 将为空）：`CONFIG_LOG_DEFAULT_LEVEL_NONE=y` + `CONFIG_LOG_MAXIMUM_LEVEL_NONE=y`。
- **关控制台串口**（UART0 不再打任何日志 / 启动信息）：`CONFIG_ESP_CONSOLE_UART_NONE=y`。
- 引导器日志基线已设为 WARN（`CONFIG_BOOTLOADER_LOG_LEVEL_WARN`）。

运行时临时调级（不改固件）：`esp_log_level_set("*", ESP_LOG_ERROR)`；但编译期 `MAXIMUM_LEVEL` 以上的日志已不在固件里，运行时无法再调高。

### 编译加速

- **ccache**（收益最大，清理重建尤其明显）：装好 ccache 后开 `IDF_CCACHE_ENABLE`，再构建：
  ```powershell
  $env:IDF_CCACHE_ENABLE=1   # Linux/macOS: export IDF_CCACHE_ENABLE=1
  idf.py build
  ```
- **增量构建**：改代码后直接 `idf.py build`，别随意 `fullclean`；`set-target` 只需一次。Ninja（默认）已自动并行占满 CPU。
- **开发期降优化换速度**：`menuconfig → Compiler options → Optimization Level → Debug (-Og)` 比基线 `-O2`(PERF) 编得快；**生产仍用 PERF / Size**。
- **只编所需**：片上测试走独立工程 `idf.py -C test_apps build`，不随固件一起编；vendored 的 zstd 体量大，但仅在其源码变动时重编（ccache 可免重编）。
- 日志按上文裁到 ERROR/NONE 也会少编一部分代码。

## 已知限制 / 待实机验证

- 引脚 / PHY 地址为官方示例默认值，上板前对原理图复核。
- 回放默认启用预读 / 解码分线程（`CONFIG_ART_PLAYER_PREFETCH`）消除读盘抖动，未命中回退同线程同步读；尚未实机压测，异常可关闭该项。
- DMX512 时序（250kbaud/8N2、BREAK 连续刷新、~42Hz）为确定性推算，建议示波器复核；TX 装了 ≥1 整帧环形缓冲防欠载，可经 `GET /api/diag` 的 `dmxUart.txTimeouts` 监控（正常恒 0）。
- 实时转发按 E1.31 做优先级 + HTP 合并，每 universe 来源上限 8；跨来源合并、sACN 组播、6454 单播投递需实机验证。
- 566400 为非标波特率（P4 分数分频），校验和算法与字节序（见 `etronet` 组件）需与真实 MCU 联调核对。
- 未与真实灯具 / 上位机端到端联调，未做长时间稳定性测试。

## 已适配的 ESP-IDF 6.x 变化

`json`→`espressif/cjson`；IP101 PHY 移出 IDF，用 `espressif/ip101` 并在代码配 RMII 时钟（`EMAC_CLK_EXT_IN`）；`esp_vfs_fat_sdmmc_unmount`→`esp_vfs_fat_sdcard_unmount`；FATFS 开 UTF-8 长文件名 + fastseek；默认编译告警当错误（vendored zstd 单独放宽）。
