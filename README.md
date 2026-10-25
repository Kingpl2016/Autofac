# Art-Net Studio

Art-Net / sACN 灯光控制与录制平台。基于 Tauri 2 + React 19 构建的桌面应用，用于 Art-Net / DMX512 信号的接收、监看、转发、录制与回放，并支持对 ESP32P4 核心板进行指令控制与文件管理。

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

### 设备
- **核心板控制**：向 ESP32P4 核心板下发指令（复位、初始化、工作模式切换、节目播放控制等）。
- **核心板文件**：对核心板 SD 卡上的文件进行增、删、查、改，并上传录制好的节目。

### 系统
- **设置**：录制目录、压缩策略、分段、网络接口、主题与语言等偏好配置。

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
- Tauri 2（`src-tauri`），Rust edition 2021，最低 1.80
- Workspace crates（`src-tauri/crates`）：
  - `artnet-net`：Art-Net / sACN 网络收发
  - `artrec-core`：`.artrec` 格式编解码（权威实现）
  - `recorder` / `player`：录制与回放引擎
  - `signal-engine`：信号合并（HTP / LTP / Priority）
  - `forwarding` / `discovery`：转发与设备发现
  - `controller`：核心板指令与文件协议
  - `netif` / `settings` / `host-core`：网络接口、设置与宿主通用逻辑

## 开发环境要求

- [Node.js](https://nodejs.org/)（建议 LTS）与 npm
- [Rust](https://www.rust-lang.org/)（1.80 或更高）
- [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)（按操作系统安装对应的系统库 / 构建工具）

## 快速开始

```bash
# 安装前端依赖
npm install

# 启动桌面应用（Tauri 开发模式，含热重载）
npm run tauri dev

# 仅启动前端（浏览器中调试 UI，不含 Tauri 原生能力）
npm run dev
```

## 构建

```bash
# 构建桌面应用安装包
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle`。

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Vite 前端开发服务器 |
| `npm run build` | 类型检查并构建前端静态产物到 `dist` |
| `npm run preview` | 预览构建后的前端产物 |
| `npm run tauri dev` | 启动 Tauri 桌面开发模式 |
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

## 项目结构

```
art-net-studio/
├── src/                    前端源码
│   ├── app/                应用入口与路由
│   ├── layouts/            主布局、侧栏、头部
│   ├── pages/              各功能页面
│   ├── features/           按领域组织的功能模块（含组件、hooks、lib）
│   ├── components/ui/      基础 UI 组件
│   ├── shared/             导航、全局 store 等共享逻辑
│   ├── lib/ · styles/      工具函数与样式
│   └── main.tsx            入口
├── src-tauri/              Tauri / Rust 后端
│   ├── src/                命令层（录制、回放、控制器）
│   ├── crates/             领域逻辑 workspace crates
│   └── tauri.conf.json     Tauri 配置
├── doc/                    规范与说明文档
└── index.html              前端 HTML 入口
```

## 相关文档

- [ArtRec 灯光节目录制文件规范](doc/ArtRec%20灯光节目录制文件规范.md)
- [录制与回放说明](doc/录制与回放说明.md)
- [核心板控制软件要求](doc/核心板控制软件要求_D261024v1.0.md)

## 通信约定

- 核心板通过 TCP 端口 **1227** 通信，使用自定义帧协议（帧头 `0x35`、通信定义、数据长度、数据载荷、校验和）。
- 灯光数据遵循 Art-Net / DMX512，多字节整数采用大端（网络字节序）。
