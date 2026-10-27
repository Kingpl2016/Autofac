# Art-Net Studio

Art-Net / sACN 灯光控制与录制平台。基于 Tauri 2 + React 19 构建的桌面应用，用于 Art-Net / DMX512 信号的接收、监看、转发、录制与回放，并支持通过 HTTP 管理 ESP32-P4 核心板（网络设备）：文件、指令与固件升级。

## 功能特性

应用按「信号 / 节目 / 设备 / 系统」四个分组组织功能页面：

### 信号
- **仪表盘**：集群状态、活跃 Universe 列表、系统日志等运行态总览。
- **Universe 监看**：512 通道栅格实时查看每个 Universe 的电平。
- **设备发现**：扫描并列出网络中的 Art-Net / sACN 节点。
- **信号转发**：配置转发表（路由、Universe 偏移、延迟），将接收到的信号分发到目标设备。
- **信号流**：以 React Flow 可视化「来源 → Universe → 目的地」的信号拓扑。

### 节目
- **录制与回放**：接收 Art-Net 流并录制为 `.artrec` 节目文件，支持来源过滤（IP / Universe / 协议）、崩溃安全落盘、自动分段；回放支持倍速、循环、seek、时间线热力图与通道曲线可视化。详见 [`doc/录制与回放说明.md`](doc/录制与回放说明.md)。
- **物模型**：通过 Excel 表导入 DMX 物模型，配置标准照明设备（开关灯、调白光、冷暖白、RGB / RGBW / RGBCW 全彩灯等）。
- **回路设置**：对 512 个通道进行最多 32 回路的物模型划分。
- **场景队列**：基于物模型设备建立场景队列，按间隔时间生成渐变帧并导出为节目文件。

### 网络
- **网络设备**：管理多台 ESP32-P4 核心板（协议见 [esp32p4_artnet/docs/protocol.md](esp32p4_artnet/docs/protocol.md)）。主从布局：左侧设备栏（状态 / 版本 / 播放中，可拖动宽度、可折叠，窄窗口收进抽屉），右侧是吸顶设备头、4 张关键指标卡、跨 Tab 常驻的“正在播放”条和 5 个 Tab：
  - **文件**：SD 卡文件表（筛选、拖动排序改节目号），上传（选择 / 拖入窗口，流式读盘，带进度与取消）、下载、重命名、删除，并可直接播放；F2 / Delete / Ctrl+S 快捷键。
  - **播放控制**：播放器（进度 / 倍速 / 重复模式）、节目快选、工作模式卡片、自检 / 复位，恢复出厂在默认折叠的危险区里。
  - **配置**：网络 / 输出 / 转发分组与访问 Token，宽屏有分组目录；切走再回来草稿还在，Tab 上提示未保存的更改。
  - **诊断与日志**：堆、CPU、任务栈（可暂停实时更新）与设备日志。
  - **固件**：固件预检、单台或批量顺序 OTA，等待重启并校验版本。
  - 设备按 IP / 主机名保存，Bearer Token 存在系统凭据管理器里（不写入配置文件）。设备要求 Token 而本机没有时，页面给出提示并可直接打开设置。

### 系统
- **设置**：录制目录、压缩策略、分段、网络接口、主题与语言等偏好配置。
- **关于**：版本与运行环境信息（可一键复制诊断文本）、软件更新（检查 / 带进度下载安装 / 更新通道）。

### 关于 sACN

sACN 默认**关闭**，只在需要时到「设置 → 协议」打开 `启用 sACN`。开关实时生效，无需重启：

- **关闭时**：不接收也不发送 sACN；设备发现、转发、回放目标、录制过滤、仪表盘、信号流等处所有 sACN 相关内容都会隐藏。已有的 sACN 转发目的地数据会保留，重新开启后恢复。
- **开启时**：可配置全局监听端口（默认 5568）、订阅的 Universe（1~63999），以及在多网卡模式下逐块网卡启用或关闭 sACN。
- **每网卡开关只控制组播订阅**：关闭某块网卡，该网卡不会加入 sACN 组播。发往本机的单播 sACN 因套接字绑定 `0.0.0.0`，从任何网卡进来都会收到。未出现在多网卡配置里的网卡视为启用。
- **升级说明**：旧版本的配置文件会在首次加载时一次性把 sACN 改为关闭（`schemaVersion` 从 0 升到 1），之后你手动开启的选择会被保留。
- **Art-Net 不受影响**：Art-Net 的启用开关、端口和每网卡开关目前仍只在启动时读取，需重启生效。

## 技术栈

**前端**
- React 19 + TypeScript + Vite 8
- React Router 7、TanStack Query、Zustand
- Tailwind CSS 4 + Radix UI（shadcn 风格组件）
- i18next（国际化）、Sonner（通知）、React Flow（信号流图）
- Vitest + Testing Library（测试）

**后端（Tauri / Rust）**
- Tauri 2（`src-tauri`），Rust edition 2021，最低 1.90
- Tauri 官方插件：`store`（界面偏好持久化）、`dialog` / `fs`（文件对话框与读写）、`opener`、`log`（统一日志，Rust `tracing` 经 `log` 桥接 + 前端日志汇入应用内日志面板）、`global-shortcut`（录制开始 / 停止全局热键）、`updater`（自动更新）、`upload`（HTTP 文件传输）、`persisted-scope`（持久化已授权的文件范围）
- Workspace crates（`src-tauri/crates`）：
  - `artnet-net`：Art-Net / sACN 网络收发
  - `artrec-core`：`.artrec` 格式编解码（权威实现）
  - `recorder` / `player`：录制与回放引擎
  - `signal-engine`：信号合并（HTP / LTP / Priority）
  - `forwarding` / `discovery`：转发与设备发现
  - `netdev`：网络设备（核心板）HTTP 客户端、多设备注册表与凭据存储
  - `netif` / `settings` / `host-core`：网络接口、设置与宿主通用逻辑

## 开发环境要求

- [Node.js](https://nodejs.org/)（建议 LTS）与 npm
- [Rust](https://www.rust-lang.org/)（1.90 或更高）
- [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)（按操作系统安装对应的系统库 / 构建工具）

## 快速开始

```bash
# 安装前端依赖
npm install

# 启动桌面应用（Tauri 开发模式，含热重载）
npm run tauri dev
```

> 本应用为**桌面专用**：所有后端调用直接走 Tauri IPC，不再提供浏览器降级。请使用 `npm run tauri dev` 开发；`npm run dev` 仅作为 Tauri 加载的 Vite 前端服务器，在纯浏览器中打开时涉及后端能力的界面将不可用。

### 演示模式（没有灯光设备时看完整界面）

```bash
npm run dev:demo
```

窗口标题带「[演示模式]」。所有页面（仪表盘、Universe 监看、设备发现、信号转发、信号流、录制与回放、网络设备、设置、关于）都会有一套完整的测试数据，并且会动起来：

- **实时信号**：25 个 Universe（Art-Net + sACN，含多来源冲突、频闪、保活等情形），包速率、通道值随时间变化。
- **设备**：34 台设备覆盖 5 种类别，有离线、周期性掉线的，网络扫描会陆续发现新设备。
- **转发 / 输出**：8 个目的地（含停用、重映射、延迟），其中一个会周期性丢帧并报错。
- **录制与回放**：节目库 12 个节目（含自动恢复的、损坏的）；可以真的开始 / 停止录制，录完进节目库；回放支持播放、暂停、跳转、倍速、循环、连播，时间线热力图与通道曲线都有数据。
- **网络设备**：4 台模拟核心板覆盖不同情形——`.200` 正常（循环播放中）、`.201` 要求 Token 而本机未保存、`.202` 离线、`.203` 未配置 Token（只读模式）；文件可上传、下载、播放、重命名、删除，可改配置、看诊断与日志，并能演示单台 / 批量固件升级（含重启等待）。
- **关于**：检查更新总是发现新版本，可看到完整的下载进度与安装流程。

写操作（保存转发表 / 设置、重命名或删除节目、改设备名、增删网络设备上的文件等）在内存里立即生效，刷新页面后还原。

测试数据全部放在 [`src/demo/data/*.json`](src/demo/data)，想增删或调整只改 JSON，不用碰代码。演示代码只在 `vite --mode demo`（或 `VITE_DEMO_MODE=1`）时动态导入，普通构建的产物里没有它。演示模式没有接管的命令（退出守卫、信号检测器窗口）仍走真实后端。

## 构建

```bash
# 构建桌面应用安装包
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle`。

### 自动更新（Updater）

应用已集成 `tauri-plugin-updater`，但**发布更新前需先完成签名配置**（当前 `src-tauri/tauri.conf.json` 的 `plugins.updater` 为占位值）：

1. 生成签名密钥对：`npm run tauri signer generate -- -w ~/.tauri/artnetstudio.key`
2. 把生成的**公钥**填入 `tauri.conf.json` 的 `plugins.updater.pubkey`，并把 `endpoints` 改为真实更新服务器地址（支持 `{{target}}` / `{{arch}}` / `{{current_version}}` 变量）。
3. 构建前在环境变量中提供**私钥**：`TAURI_SIGNING_PRIVATE_KEY`（及可选的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`），`npm run tauri build` 会生成带签名的更新制品（`bundle.createUpdaterArtifacts` 已开启）。

配置就绪后，可在「关于 → 软件更新 → 检查更新」触发检查与安装。

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Vite 前端开发服务器 |
| `npm run build` | 类型检查并构建前端静态产物到 `dist` |
| `npm run preview` | 预览构建后的前端产物 |
| `npm run tauri dev` | 启动 Tauri 桌面开发模式 |
| `npm run dev:demo` | 以演示模式启动桌面应用（全部页面使用 `src/demo/data` 的测试数据） |
| `npm run tauri build` | 构建桌面应用安装包 |
| `npm run lint` | 运行 ESLint |
| `npm run test` | 运行一次 Vitest 测试 |
| `npm run test:watch` | 监听模式运行 Vitest |
| `npm run verify` | 类型检查 + ESLint + 测试（提交前校验） |

Rust 侧测试：

```bash
cargo test --workspace
```

（在 `src-tauri` 目录下执行）

### 性能基准与压测

以下命令都在 `src-tauri` 目录下执行。

| 命令 | 说明 |
|---|---|
| `cargo bench -p <crate> --benches` | 运行某个 crate 的全部 divan 微基准（报告中位耗时与每次迭代的分配次数），如 `-p host-core`、`-p signal-engine`、`-p artrec-core`、`-p player`、`-p recorder`、`-p artnet-net`、`-p discovery` |
| `cargo bench -p host-core --bench dispatch -- --sample-count 10` | 只跑单个基准文件；`--sample-count` 等 divan 参数只能配合 `--bench <名称>` 使用 |
| `cargo build --release -p artnet-net --example loadgen` | 构建 Art-Net 压测发包器 |
| `target/release/examples/loadgen --universes 256 --hz 44 --sources 1 --seconds 60` | 向本机发 256 Universe × 44Hz 的 ArtDmx（`--sources 2` 模拟双来源合并） |
| `cargo test -p host-core playback_timing_44hz -- --ignored --nocapture` | 回放计时测试：64 Universe × 44Hz 播放到 UDP 回环，打印迟到 p50 / p99 / max（需在空闲机器上运行） |
| `cargo build --profile profiling` | 与 release 相同优化、保留符号，供 samply / WPA 采样分析 |

计时类基准在负载波动的机器上误差较大，对比前后结果时建议重复运行几次。

## 模拟测试工具（Python）

没有真实灯控设备时，可用 [`tools/artnet_sim`](tools/artnet_sim) 在本机或局域网里模拟 Art-Net / sACN 信号，用来测试本应用的发现、监看、转发、录制与回放。安装、使用与打包方式见 [`tools/artnet_sim/README.md`](tools/artnet_sim/README.md)。

## 项目结构

```
art-net-studio/
├── src/                    前端源码
│   ├── app/                应用入口与路由
│   ├── layouts/            主布局、侧栏、头部
│   ├── demo/               演示模式：模拟后端 + 测试数据（data/*.json）
│   ├── pages/              各功能页面
│   ├── features/           按领域组织的功能模块（含 components、hooks、stores、lib）
│   ├── components/ui/      基础 UI 组件
│   ├── shared/             导航、全局 store 等共享逻辑
│   ├── lib/ · styles/      工具函数与样式
│   └── main.tsx            入口
├── src-tauri/              Tauri / Rust 后端
│   ├── src/                命令层（录制、回放、控制器）
│   ├── crates/             领域逻辑 workspace crates
│   └── tauri.conf.json     Tauri 配置
├── tools/artnet_sim/       Python 版 Art-Net / sACN 模拟测试工具
├── doc/                    规范与说明文档
└── index.html              前端 HTML 入口
```

## 相关文档

- [ArtRec 灯光节目录制文件规范](doc/ArtRec%20灯光节目录制文件规范.md)
- [录制与回放说明](doc/录制与回放说明.md)
- [核心板控制软件要求](doc/核心板控制软件要求_D261024v1.0.md)

## 通信约定

- 核心板固件只暴露 HTTP 接口（默认端口 80，REST + JSON，文件与 OTA 用裸字节请求体），原 TCP 1227 指令通道已移除。写类接口需要 `Authorization: Bearer <token>`。
- 灯光数据遵循 Art-Net / DMX512，多字节整数采用大端（网络字节序）。
