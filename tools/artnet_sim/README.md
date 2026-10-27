# Art-Net / sACN 模拟测试工具

没有真实灯控设备时，可用本工具在本机或局域网里模拟 Art-Net / sACN 信号，用来测试 Art-Net Studio 的发现、监看、转发、录制与回放。需要 Python 3.11 或更高版本。

- **发送端**：固定值、渐变、正弦、彩虹、追逐、频闪、随机、`.artrec` 回放等生成器，可注入丢包、重复、乱序、抖动、序号异常，还能模拟多个来源与 sACN 优先级冲突。
- **虚拟节点**：像真实设备一样回复 ArtPoll，接收 Art-Net / sACN，按 HTP / LTP 合并，可手动上线 / 下线。
- **抓包分析**：按数据流统计丢包、乱序、重复、间隔抖动，带包日志与报文解码；可把抓到的信号保存为 `.artrec`（与 Rust 实现逐字节一致）。
- **场景**：用 YAML 编排时间线（内置 8 个，如多源冲突、源掉线重连、设备闪断、序号回绕）。
- **Web 界面**：免构建，默认只监听本机；加 `--lan` 才允许局域网访问，且强制令牌认证。

## 快速开始

在本目录（`tools/artnet_sim`）下执行：

```bash
python -m venv .venv
.venv\Scripts\activate            # Linux / macOS：source .venv/bin/activate
pip install -e .[dev]

artnet-sim serve --open           # 启动 Web 界面（http://127.0.0.1:8765）
artnet-sim --help                 # 查看全部命令：send / listen / node / scenario / artrec ...
```

> 与 Art-Net Studio 在**同一台电脑**上测试时，两边会共用 UDP 6454 / 5568 端口：广播和组播两边都能收到，发往本机 IP 的单播只会送给先绑定端口的一方。虚拟节点默认使用 `127.0.0.x` 环回别名作为 IP，并建议先启动 Art-Net Studio。
>
> 默认全局发包上限 20000 包/秒（`--max-pps` 可调），默认禁止发往公网地址（`--allow-public` 解除）。

## 打包成单文件 exe

目标机器不用装 Python，仅支持 Windows，产物约 16 MB：

```powershell
powershell -File packaging/build_exe.ps1     # 产物：dist/artnet-sim.exe
dist\artnet-sim.exe serve --open
```

## 测试与基准

| 命令 | 说明 |
|---|---|
| `python -m pytest -rs` | 运行全部测试（浏览器端到端测试需要 Node 22 与 Edge / Chrome，缺少时自动跳过） |
| `python scripts/bench_send.py --universes 64 256` | 发包性能基准：打印调度迟到、实际包速率与送达率 |
| `python scripts/probe_samehost.py` | 探测本机同端口共绑时单播 / 广播 / 组播的送达情况 |
