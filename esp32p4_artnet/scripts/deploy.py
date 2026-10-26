#!/usr/bin/env python3
"""ArtNet Core 固件：构建 / 烧录 / OTA 部署脚本（仅用 Python 标准库）。

必须在**已激活 ESP-IDF 环境**的终端运行（先 source export.sh / export.ps1，
或设置好 IDF_PATH）。脚本只是对 idf.py 的封装，外加一个 HTTP 推送式 OTA。

子命令：
  build    构建固件（--prod 叠加生产配置，--ccache 开编译缓存）
  flash    构建并经串口烧录（--port）
  monitor  打开串口监视器（--port）
  ota      构建并经 HTTP 把固件 OTA 推送到设备（--host / --token）
  clean    fullclean

示例：
  python scripts/deploy.py build
  python scripts/deploy.py build --prod --ccache
  python scripts/deploy.py flash --port COM5
  python scripts/deploy.py ota --host artnet-core.local --token <TOKEN>
  python scripts/deploy.py ota --host 192.168.1.50 --token <TOKEN> --no-build
  python scripts/deploy.py ota --host 192.168.1.50 --prod   # token 取环境变量 ARTNET_TOKEN
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

# 工程根目录（本脚本在 <project>/scripts/ 下）。
PROJECT_DIR = Path(__file__).resolve().parent.parent
# 与 CMakeLists.txt 的 project(artnet_core ...) 对应，决定产物名 build/<PROJECT>.bin。
PROJECT = "artnet_core"
DEFAULT_TARGET = "esp32p4"


def info(msg: str) -> None:
    print(f"\033[36m[deploy]\033[0m {msg}", flush=True)


def die(msg: str) -> None:
    sys.exit(f"\033[31m[deploy] 错误：{msg}\033[0m")


def idf_cmd(args: list[str]) -> list[str]:
    """组装调用 idf.py 的命令（优先用 IDF_PATH 下的脚本，跨平台稳妥）。"""
    idf_path = os.environ.get("IDF_PATH")
    if idf_path:
        script = Path(idf_path) / "tools" / "idf.py"
        if script.is_file():
            return [sys.executable, str(script), *args]
    exe = shutil.which("idf.py")
    if exe:
        return [exe, *args]
    die("找不到 idf.py：请先激活 ESP-IDF 环境（export.ps1 / export.sh）或设置 IDF_PATH。")
    return []  # 不会到达（die 已退出）


def run(cmd: list[str], env: dict | None = None, cwd: Path | None = None) -> None:
    info("$ " + " ".join(cmd))
    try:
        subprocess.run(cmd, cwd=str(cwd or PROJECT_DIR), env=env, check=True)
    except subprocess.CalledProcessError as e:
        die(f"命令失败（退出码 {e.returncode}）")
    except FileNotFoundError:
        die(f"找不到可执行文件：{cmd[0]}")


def ensure_zstd() -> None:
    """构建前确保 vendored 的 zstd 上游源码已拉取（首次自动拉取）。"""
    upstream = PROJECT_DIR / "components" / "zstd" / "upstream"
    if upstream.exists():
        return
    info("zstd 上游源码缺失，自动拉取...")
    zstd_dir = PROJECT_DIR / "components" / "zstd"
    if os.name == "nt":
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "fetch_zstd.ps1"],
            cwd=zstd_dir)
    else:
        run(["bash", "fetch_zstd.sh"], cwd=zstd_dir)


def build_env(use_ccache: bool) -> dict:
    env = os.environ.copy()
    if use_ccache:
        env["IDF_CCACHE_ENABLE"] = "1"
    return env


def sdkconfig_flag(prod: bool) -> list[str]:
    defaults = "sdkconfig.defaults"
    if prod:
        defaults += ";sdkconfig.prod.defaults"
    return ["-D", f"SDKCONFIG_DEFAULTS={defaults}"]


def do_build(a: argparse.Namespace) -> None:
    ensure_zstd()
    env = build_env(a.ccache)
    dflag = sdkconfig_flag(a.prod)
    build_dir = PROJECT_DIR / "build"
    # 首次或显式 --reconfigure 时设定目标（会按 SDKCONFIG_DEFAULTS 重建 sdkconfig）。
    if a.reconfigure or not build_dir.exists():
        run(idf_cmd([*dflag, "set-target", a.target]), env=env)
    run(idf_cmd([*dflag, "build"]), env=env)
    info(f"构建完成：build/{PROJECT}.bin")


def do_flash(a: argparse.Namespace) -> None:
    if not a.no_build:
        do_build(a)
    port = ["-p", a.port] if a.port else []
    run(idf_cmd([*port, "flash"]))
    if a.monitor:
        run(idf_cmd([*port, "monitor"]))


def do_monitor(a: argparse.Namespace) -> None:
    port = ["-p", a.port] if a.port else []
    run(idf_cmd([*port, "monitor"]))


def do_clean(_a: argparse.Namespace) -> None:
    run(idf_cmd(["fullclean"]))


def do_ota(a: argparse.Namespace) -> None:
    if not a.no_build:
        do_build(a)
    binp = PROJECT_DIR / "build" / f"{PROJECT}.bin"
    if not binp.is_file():
        die(f"找不到固件产物 {binp}，请先成功构建。")
    token = a.token or os.environ.get("ARTNET_TOKEN")
    data = binp.read_bytes()
    url = f"http://{a.host}/api/ota"
    info(f"OTA 推送 {binp.name}（{len(data)} 字节）→ {url}")
    if not token:
        info("未提供 token（--token 或 ARTNET_TOKEN）；若设备开启鉴权将返回 401。")

    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/octet-stream")
    req.add_header("Content-Length", str(len(data)))
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=a.timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            info(f"响应 {resp.status}：{body}")
            info("设备将在校验通过后重启并切换到新分区（首启自检失败会自动回滚）。")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        die(f"OTA 被拒绝：HTTP {e.code} {body}")
    except urllib.error.URLError as e:
        die(f"无法连接设备 {a.host}：{e.reason}")


def main() -> None:
    p = argparse.ArgumentParser(description="ArtNet Core 固件构建 / 烧录 / OTA 部署")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_build_opts(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--prod", action="store_true",
                        help="叠加 sdkconfig.prod.defaults（OTA 签名 + 生产日志裁剪）")
        sp.add_argument("--ccache", action="store_true", help="启用 ccache 编译缓存")
        sp.add_argument("--reconfigure", action="store_true",
                        help="重新 set-target（切换 dev/prod 配置时用）")
        sp.add_argument("--target", default=DEFAULT_TARGET, help=f"目标芯片（默认 {DEFAULT_TARGET}）")

    sp_build = sub.add_parser("build", help="构建固件")
    add_build_opts(sp_build)
    sp_build.set_defaults(func=do_build)

    sp_flash = sub.add_parser("flash", help="构建并串口烧录")
    add_build_opts(sp_flash)
    sp_flash.add_argument("-p", "--port", help="串口（如 COM5 / /dev/ttyUSB0）")
    sp_flash.add_argument("--no-build", action="store_true", help="跳过构建，直接烧录现有产物")
    sp_flash.add_argument("--monitor", action="store_true", help="烧录后打开监视器")
    sp_flash.set_defaults(func=do_flash)

    sp_mon = sub.add_parser("monitor", help="打开串口监视器")
    sp_mon.add_argument("-p", "--port", help="串口")
    sp_mon.set_defaults(func=do_monitor)

    sp_ota = sub.add_parser("ota", help="构建并经 HTTP 推送 OTA")
    add_build_opts(sp_ota)
    sp_ota.add_argument("--host", required=True, help="设备地址（IP 或 artnet-core.local）")
    sp_ota.add_argument("--token", help="HTTP Bearer token（或设环境变量 ARTNET_TOKEN）")
    sp_ota.add_argument("--no-build", action="store_true", help="跳过构建，推送现有产物")
    sp_ota.add_argument("--timeout", type=int, default=180, help="HTTP 超时秒数（默认 180）")
    sp_ota.set_defaults(func=do_ota)

    sp_clean = sub.add_parser("clean", help="fullclean")
    sp_clean.set_defaults(func=do_clean)

    a = p.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
