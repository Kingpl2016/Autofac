# ArtNet Core 固件通信协议

本文定义 ESP32-P4 核心板固件对上位机暴露的 HTTP 接口，以及它与 `.artrec` 节目格式、Art-Net / sACN 输出的互通约定。

## 1. 传输层

- 上位机控制 / 文件 / 升级全部通过 **HTTP**（默认端口 80）。原《核心板控制软件要求》里的 TCP 1227 指令通道已移除；寄存器语义保留，改由下面的 REST 接口承载。
- 另有一条**可选的总线 MCU 串口通道**（默认关）：按《总线 MCU 与核心板通信协议》经 UART 承载寄存器指令，供 Etronet MCU 直接控制核心板，详见第 11 节。它与 HTTP 并存，复用同一套寄存器语义与动作逻辑。
- 鉴权：**当前开发与生产均关闭**（`CONFIG_ART_REQUIRE_AUTH=n`），所有端点无需 token、忽略 `Authorization` 头；以下为 `CONFIG_ART_REQUIRE_AUTH=y` 时的行为。配置了 `httpToken` 时，所有 `/api/*` 与 `/files` 接口需带 `Authorization: Bearer <token>`，否则 401（token 以加盐 SHA-256 存 NVS，常量时间比较，不回显）。**未配置 token 时**，默认（`CONFIG_ART_REQUIRE_AUTH=y`）仍拒绝一切**变更类 / 高危端点**（POST/PUT/DELETE、OTA、出厂、改配、删文件、重命名）返回 401，仅放行只读 GET；关闭该 Kconfig 才退回「未配置即全开」的旧行为（仅限开发）。
- 设备发现：
  - **mDNS**：主机名 `artnet-core.local`，广播 `_http._tcp`。
  - **Art-Net ArtPoll**：固件应答 ArtPollReply（OpCode 0x2100），上报 IP 与当前节目的输出 Universe，可被上位机“设备发现”页自动发现。

## 2. 状态码

HTTP 状态码与内部状态一一对应：

| 内部 | HTTP | 含义 |
|---|---|---|
| Ok | 200 | 成功 |
| InvalidArg | 400 | 参数非法 / 鉴权失败 |
| NotFound | 404 | 编号或文件不存在 |
| Busy | 409 | 忙 / 正在播放该文件 |
| BadFile | 422 | `.artrec` 校验失败 |
| NotSupported | 501 | 未实现（录制、通道读写） |
| Again | 503 | 资源未就绪（SD 未挂载） |
| NoSpace | 507 | 空间不足 |

错误响应体：`{"error":"<name>"}`。

## 3. 控制接口（寄存器语义映射）

| 原寄存器 / 动作 | HTTP 接口 | 请求体 |
|---|---|---|
| 0x0003 读工作模式 | `GET /api/workmode` | — |
| 0x0003 写工作模式 | `PUT /api/workmode` | `{"mode":0..5}` |
| 0x0000 复位/出厂/测试 | `POST /api/board` | `{"op":0..2}` |
| 0x0002 节目操作 | `POST /api/program` | `{"no":1..255,"action":0..5}` |
| 0x0010 播放状态 | `GET /api/player` | — |
| 0x0011 seek | `POST /api/player/seek` | `{"posMs":<u32>}` |
| 0x0012 倍速 | `POST /api/player/speed` | `{"speedX100":25..200}` |
| 0x0001 通道读写 | 本期不支持（501） | — |

节目操作 action：`0` 停止、`1` 暂停、`2` 单次播放、`3` 循环播放、`4` 删除、`5` 录制（不支持）。

### 3.1 工作模式（0x0003）行为

写工作模式（`PUT /api/workmode`）后固件按模式应用动作（ModeManager）：

| 模式 | 名称 | 行为 |
|---|---|---|
| 0 | 自动 | **简化实现**：等同模式 4（停止转发、允许回放）。见下方差异说明 |
| 1 | Art-Net 转发 | 停止并关闭回放，启动实时转发（见第 9 节） |
| 2 | 回路 | 仅存取模式号，停止回放，不触发其它行为 |
| 3 | 场景 | 仅存取模式号，停止回放，不触发其它行为 |
| 4 | 节目 | 停止转发，允许回放 |
| 5 | 效果 | 仅存取模式号，停止回放，不触发其它行为 |

回放门禁：只有模式 `0`（自动）与 `4`（节目）允许播放类操作；其它模式下播放类操作返回 409（WrongMode）。切到非 0/4 模式会停止播放。

> 与《核心板控制软件要求》差异：文档中模式 0（自动）本应按“后来优先”在转发与节目间自动仲裁；本期简化为等同模式 4（仅回放）。要实时转发请显式切到模式 1。

UART DMX512 输出与网络输出在所有模式下**并存**：无论回放还是转发，产生的每一帧都同时下发到网络（若启用）与匹配的 UART 口（若启用）。

`GET /api/player` 响应：

```json
{ "state":0..3, "programNo":0..255, "repeat":0..2, "speedX100":25..200,
  "posMs":0, "durMs":0, "universes":0, "frames":0, "badFrames":0 }
```

`state`：0 空闲 / 1 已停止 / 2 播放中 / 3 暂停。`repeat`：0 关闭 / 1 循环 / 2 连播。

`GET /api/status` 返回版本、IP、链路、SD 容量与播放摘要；`GET /api/logs` 返回最近日志文本。

`GET /api/diag` 返回运行期诊断（只读）：`heap{free,minFree,largestBlock,psramFree}`、`tasks[{name,prio,core,stackMin,runtime,cpuPermille}]`（`stackMin` 为该任务运行以来最小剩余栈字节，越小越危险；`cpuPermille` 为 CPU 占比千分数）、`dmxUart{ports,txTimeouts}`（`txTimeouts` 为 TX 发送超时累计，正常恒 0，非 0 提示 DMX 帧中欠载）、`player{state,badFrames}`。用于核验栈余量、core 负载、长跑堆碎片与 DMX 输出健康。

## 4. 节目映射（按编号）

| 接口 | 作用 |
|---|---|
| `GET /api/programs` | 列出 `[{no,file,size}]` |
| `GET /api/programs/{no}` | 查某编号元信息 |
| `GET /api/programs/{no}/file` | 按编号下载节目文件（支持 Range） |
| `PUT /api/programs/{no}` | `{"file":"...","force":false}` 把编号指到某文件 |
| `DELETE /api/programs/{no}` | 解除映射（不删文件） |

编号 1~255。映射持久化在 `/sdcard/programs.json`，启动时与 `/sdcard/programs/` 目录对账自愈：文件消失则移除映射，新文件分配最小空闲编号，JSON 损坏则从目录重建。

## 5. 文件接口

根目录为 `/sdcard/programs/`。

| 接口 | 作用 |
|---|---|
| `GET /files` | 列出 `[{name,size,isDir,program?}]`（`program` 为该文件的编号） |
| `GET /files/{name}` | 下载（支持 `Range`，返回 206） |
| `PUT /files/{name}` | 上传/覆盖；写 `.part` → 校验 `.artrec` 头 → 原子替换 → 自动分配编号 |
| `DELETE /files/{name}` | 删除（正在播放则 409） |
| `POST /rename` | `{"from":"...","to":"..."}` |

文件名须为合法 UTF-8、无路径分隔符 / `..` / 控制字符、以 `.artrec` 结尾、长度 ≤ 128 字节；URL 中按百分号编码传输，固件自行解码。

## 6. OTA 固件升级

推送式，基于官方 `esp_ota_ops`，双 OTA 分区 + 回滚。

| 接口 | 作用 |
|---|---|
| `POST /api/ota` | 上传固件 `.bin`（请求体为裸字节），写入非活动分区、校验、设为启动分区后重启 |
| `GET /api/ota/status` | 当前运行分区、版本、是否待确认、回滚是否启用 |
| `POST /api/ota/confirm` | 手动确认当前固件有效（取消回滚） |

安全：默认不做镜像签名校验，仅 `esp_ota_end` 的镜像完整性校验 + 回滚，建议配合 Bearer token。需要签名校验时开启 `CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT`（见 README）。首启自检：网络就绪 + SD 挂载视为成功并自动确认；失败自动回滚。

## 7. `.artrec` 互通约定（与上位机 artrec-core 对齐）

- 字节序：文件内多字节字段大端（`endian_tag=0xAA55`）；同时支持小端标记 `0x55AA`。
- 文件头按偏移字段定位分区，兼容 64 / 88 字节两种头尺寸（当前写 64）。
- Universe 编码：`universe = net*16 + subuni`，该线性编号同时作为 Art-Net Port-Address 与 sACN Universe。
- CRC16-CCITT（poly 0x1021 / init 0xFFFF / 不反转）校验的是**解压后**的原始 Payload。
- 压缩：无压缩或 Zstd；**不支持差分帧**，文件头置 `ALLOW_DIFF_FRAME` 时固件拒绝打开。

## 8. 输出包格式（与上位机 artnet-net 逐字节一致）

- **ArtDmx**（端口 6454）：`Port-Address` 小端、`Length` 大端补偶、`ProtVer`=14、`Physical`=0。
- **sACN E1.31**（端口 5568）：126 字节头 + 通道，组播 `239.255.hi.lo`，停止时发 Stream_Terminated。
- Universe 越界（Art-Net > 0x7FFF，sACN 不在 1~63999）跳过并计数。
- **UART DMX512**（见第 10 节）：与上面两路 UDP 输出并存，一个 UART 口输出一个 universe。

## 9. 实时转发（工作模式 1）

切到工作模式 1 后，固件启动实时转发：接收网络侧 Art-Net / sACN 实时流，合并后下发到输出路由（网络 UDP + UART DMX512 两路）。

- **接收**：绑定 UDP `6454`（Art-Net ArtDmx）与 `5568`（sACN，按订阅范围 join 组播 `239.255.hi.lo`）。sACN 仅接收 NULL 起始码（0x00）的数据包。
- **订阅范围**：由 `/api/config` 的 `forwardUniStart` / `forwardUniCount` 指定 `[start, start+count)`；范围外的 universe 丢弃，以界定内存与组播数量。`forwardSacn` 控制是否同时接收 sACN（否则只收 Art-Net）。
- **优先级 + HTP 合并**：同一 universe 的多个来源（按来源 IP 区分）先按 E1.31 **优先级**取最高优先级来源集合，再在该集合内 **HTP（Highest Takes Precedence）** 逐通道取最大值输出。Art-Net 无优先级概念，归一化为默认 100，与默认 sACN（100）对等参与 HTP；更高优先级的 sACN 源会覆盖之。
- **Stream_Terminated**：收到带该 Options 位的 sACN 包即剔除对应来源并重算下发。
- **来源上限**：每 universe 最多 8 个来源（防伪造源 IP 灌爆内存），满则丢弃新来源。
- **来源超时**：某来源 3 秒无更新则剔除并对该 universe 重算下发；某 universe 全部来源超时后停止该 universe（接收端按各自逻辑保持最后值，UART 口持续刷新最后一帧）。

> 实时转发与 ArtPoll 设备发现共用 6454 端口（均设 `SO_REUSEADDR`）。广播 / 组播能正常分发给各监听 socket；**单播** ArtDmx 在同端口多 socket 下的投递需实机核对。

## 10. UART DMX512 输出

板上通过 UART 自实现标准 DMX512 时序，经 Etronet MCU 作 RS-485 线驱动输出，可驱动有线 DMX 灯具。

- **电气**：250000 baud、8 数据位、无校验、2 停止位；帧 = BREAK（默认 44 位 ≈ 176µs）+ 起始码 `0x00` + 最多 512 通道。
- **生成方式**：用官方 `driver/uart` 的 `uart_write_bytes_with_break` 连续刷新，帧尾 BREAK 充当下一帧前导 BREAK；每个 UART 口一个后台线程持续发送当前帧（静止时即保活）。
- **映射**：一个 UART 口 = 一个 universe。口数（1~4）、每口 UART 编号 / TX GPIO / universe 均在 `idf.py menuconfig → ArtNet Core 板级配置 → DMX 串口输出` 配置；按串口分配表默认口1=UART2/TX GPIO2、口2=UART3/TX GPIO20、口3=UART4/TX GPIO22（GPIO2/3/4/5 是 JTAG 接口脚，非 strapping，用作 GPIO/UART 仅占焊盘 JTAG），**上板前必须对照 POE-ETH 引脚图核对**。启用总线 MCU 串口（占 UART1）后 DMX 最多 3 口。
- **开关**：由 `/api/config` 的 `uartOutputEnabled` 控制；与网络输出（`netOutputEnabled`）相互独立、可并存。
- **BREAK 时序**（`ART_DMX_BREAK_BITS`）与引脚需实机示波器核对。

`/api/config` 输出 / 转发相关字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `uartOutputEnabled` | bool | 启用 UART DMX512 输出 |
| `netOutputEnabled` | bool | 启用网络 UDP 输出（与 `artnetEnabled` / `sacnEnabled` 结合）|
| `forwardUniStart` | u16 | 转发订阅起始 universe |
| `forwardUniCount` | u16 | 转发订阅 universe 数量 |
| `forwardSacn` | bool | 转发时是否同时接收并合并 sACN |
| `dhcp` | bool | 是否用 DHCP（关闭则用下方静态地址）|
| `ip` / `netmask` / `gateway` | string | 静态 IPv4（点分十进制，`dhcp=false` 时生效）|
| `hostname` | string | 主机名（mDNS / DHCP 用）|
| `httpToken` | string | **只写**：设置 / 清除 HTTP Bearer token（空串=清除；非空须 8~64 可见 ASCII）。不随 `GET` 回显 |
| `tokenSet` | bool | **只读**（仅 `GET` 返回）：是否已配置 token |

字段校验：`sacnPriority` 0~200、`targetMode`/`stopBehavior` 枚举、`keepaliveMs` 0~600000、`forwardUniStart` 0~32767、`forwardUniCount` 1~512、`sourceName` 1~63 字节无控制字符、`hostname` RFC1123 子集、`ip`/`netmask`/`gateway` 合法 IPv4；任一非法整体拒绝（400）。另：若最终 `dhcp=false` 但静态 `ip` 为 0，也拒绝（避免落到 0.0.0.0）。

网络字段（`dhcp` / `ip` / `netmask` / `gateway` / `hostname`）改动**需重启生效**，响应带 `netRebootRequired: true`；输出 / 转发类字段即时生效（重建 UART 输出并按当前工作模式重启转发）。`netOutputEnabled` 为总开关：关闭时 Art-Net / sACN 均不发包，无论 `artnetEnabled` / `sacnEnabled`。

`GET /api/config` 回显当前 `dhcp` / `ip` / `netmask` / `gateway` / `hostname`；`GET /api/status` 额外返回 `netmask` / `gateway` / `viaDhcp`（是 DHCP 分配还是静态回退）。

## 11. 总线 MCU 串口协议（Etronet）

实现《总线 MCU 与核心板通信协议 D261022 v1.0》：ESP32 核心板作**纯从机**，经 UART 接收 Etronet MCU 下发的寄存器指令并回应答帧。默认关闭，由 `idf.py menuconfig → ArtNet Core 板级配置 → 总线 MCU 串口 (Etronet)` 开启并配置口 / 引脚。与 HTTP、DMX512 输出并存、互不影响。

- **电气**：566400 baud、8 数据位、1 停止位、无校验、无流控。
- **帧格式**：`[帧头 0x35][通信定义 1B][数据长度 n(2B)][数据载荷 n*B][校验和 1B]`；数据载荷 = `[寄存器 2B][交互数据 (n-2)*B]`。
  - 通信定义：bit7 传输模式（0 单帧 / 1 分组，暂不支持，收到即丢弃），bit6-4 操作码，bit3-0 预留(0)。
  - 操作码：0 set-ack / 1 set-需确认 / 2 set-无需确认 / 3 get / 4 get-响应 / 5 push-需确认 / 6 push-无需确认 / 7 push-ack。
- **应答规则**（从机侧）：set-需确认→回 set-ack(0)，交互数据首字节为应答码(0~7)；set-无需确认→执行不回；get→回 get-响应(4) 带数据（失败时首字节为应答码）；push-需确认→回 push-ack(7)；push-无需确认→不回；应答类入帧(0/4/7)忽略。应答码沿用全局 `Status`（0 成功、1 参数非法、2 未找到、3 忙、4 不支持、5 IO 错、6 文件非法、7 模式不允许）。
- **寄存器**（复用与 HTTP 同源的动作逻辑）：

| 寄存器 | 交互数据 | 行为 |
|---|---|---|
| `0x0000` 核心板操作 | `op(1B)`：0 复位 / 1 出厂 / 2 测试 | 复位 / 出厂延迟 300ms 执行（先把应答帧发出）；测试为空操作成功 |
| `0x0001` 通道读写 | — | 本期不支持（应答码 4） |
| `0x0002` 节目操作 | `节目号(1B)`，`op(1B)`：0 停 / 1 暂停 / 2 单次 / 3 循环 / 4 删除 / 5 录制 | 同 `POST /api/program`：录制不支持；播放类受工作模式门禁（仅 0/4 允许） |
| `0x0003` 工作模式 | set：`mode(1B, 0~5)`；get：无 | set 写模式并应用（启停转发 / 回放门禁）；get 回当前模式 |

- **串口分配**：按整板分配表用 **UART1（TX=GPIO4 / RX=GPIO5）**，与控制台 UART0(GPIO37/38)、DMX512 UART2(GPIO2)、备用 UART3/UART4 错开。GPIO4/5 在 40PIN 排针右列相邻且紧邻 GND，便于引 3 线到 MCU。完整分配与 40PIN 排针图（已核对 Waveshare 官方引脚定义图）见 [`README.md`](../README.md) 的「串口与引脚分配」一节。
- **配置项**（Kconfig）：`ART_ETRONET_ENABLE` 使能、`ART_ETRONET_UART`（默认 1）、`ART_ETRONET_TX`（默认 4）/ `ART_ETRONET_RX`（默认 5）、`ART_ETRONET_BAUD`（默认 566400）、`ART_ETRONET_MAX_FRAME` 载荷上限。**上板前对照 POE-ETH 引脚图核对**。
- **实现**：固件组件 `components/etronet`（纯逻辑 `etronet_proto` + UART 传输 `etronet_link`）。
- **待实机核对项**：① 校验和算法（当前实现为「帧头至数据载荷字节和取低 8 位」）；② 数据长度与寄存器字节序（当前实现为小端）；③ 566400 为非标波特率，P4 靠分数分频产生，需核对误差率与稳定性。三者均在 `etronet_proto` 里集中封装（`checksum` / `rd_u16` / `wr_u16`），如与真实 MCU 不符只需改一处。
