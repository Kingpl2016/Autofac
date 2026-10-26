#!/usr/bin/env python3
"""ArtNet Core 固件：开发辅助脚本（仅用 Python 标准库）。

与 deploy.py（构建 / 烧录 / OTA）互补，聚焦日常迭代。需在**已激活 ESP-IDF 环境**
的终端运行（export.ps1 / export.sh 或设好 IDF_PATH）。idf.py 调用逻辑复用 deploy.py。

子命令：
  menuconfig   打开 idf.py menuconfig
  build        增量构建（--ccache 开缓存）
  test         构建并运行片上 Catch2 测试（test_apps 独立工程，--port 烧录监视）
  size         固件体积（--components 看各组件占用）
  erase        擦除整片 flash（--port）
  api          对运行中的设备做 HTTP 冒烟（status/config/player/diag）
  fmt          clang-format 格式化（--check 只检查不改）

示例：
  python scripts/dev.py menuconfig
  python scripts/dev.py test --port COM5
  python scripts/dev.py size --components
  python scripts/dev.py api --host artnet-core.local --token <TOKEN>
  python scripts/dev.py fmt --check
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

# 复用 deploy.py 的 idf 调用 / 日志 / zstd 等通用逻辑（单一来源，避免重复）。
sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy as D  # noqa: E402

PROJECT_DIR = D.PROJECT_DIR

# fmt 遍历时跳过的目录（第三方 / 产物 / vendored）。
FMT_SKIP = {"build", "managed_components", "upstream", ".git"}
FMT_EXTS = {".c", ".cpp", ".cc", ".h", ".hpp"}


def do_menuconfig(_a: argparse.Namespace) -> None:
    D.run(D.idf_cmd(["menuconfig"]))


def do_build(a: argparse.Namespace) -> None:
    D.ensure_zstd()
    D.run(D.idf_cmd(["build"]), env=D.build_env(a.ccache))


def do_test(a: argparse.Namespace) -> None:
    """构建并（可选）烧录运行片上 Catch2 测试工程 test_apps。"""
    D.ensure_zstd()
    base = ["-C", "test_apps"]
    if not (PROJECT_DIR / "test_apps" / "build").exists():
        D.run(D.idf_cmd([*base, "set-target", a.target]))
    D.run(D.idf_cmd([*base, "build"]))
    if a.build_only:
        D.info("已构建 test_apps；加 --port 可烧录并查看测试输出。")
        return
    port = ["-p", a.port] if a.port else []
    D.run(D.idf_cmd([*base, *port, "flash", "monitor"]))


def do_size(a: argparse.Namespace) -> None:
    D.run(D.idf_cmd(["size-components" if a.components else "size"]))


def do_erase(a: argparse.Namespace) -> None:
    port = ["-p", a.port] if a.port else []
    D.run(D.idf_cmd([*port, "erase-flash"]))


def _api_get(base: str, ep: str, token: str | None, timeout: int) -> None:
    url = base + ep
    req = urllib.request.Request(url, method="GET")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                pretty = json.dumps(json.loads(raw), ensure_ascii=False, indent=2)
            except json.JSONDecodeError:
                pretty = raw
            D.info(f"GET {ep} → {resp.status}")
            print(pretty)
    except urllib.error.HTTPError as e:
        D.info(f"GET {ep} → HTTP {e.code} {e.read().decode('utf-8', 'replace')}")
    except urllib.error.URLError as e:
        D.die(f"无法连接设备 {base}：{e.reason}")


def do_api(a: argparse.Namespace) -> None:
    base = f"http://{a.host}"
    token = a.token or os.environ.get("ARTNET_TOKEN")
    eps = a.endpoint or ["/api/status", "/api/config", "/api/player", "/api/diag"]
    for ep in eps:
        _api_get(base, ep if ep.startswith("/") else "/" + ep, token, a.timeout)


def _collect_sources() -> list[str]:
    roots = [PROJECT_DIR / "main", PROJECT_DIR / "components"]
    files: list[str] = []
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if p.suffix.lower() not in FMT_EXTS:
                continue
            if any(part in FMT_SKIP for part in p.parts):
                continue
            files.append(str(p))
    return files


def do_fmt(a: argparse.Namespace) -> None:
    fmt = shutil.which("clang-format")
    if not fmt:
        D.die("未找到 clang-format，请安装 LLVM 工具链或将其加入 PATH。")
    if not (PROJECT_DIR / ".clang-format").is_file():
        D.die("缺少项目级 .clang-format：直接格式化会用默认风格破坏现有排版。"
              "请先在工程根添加 .clang-format（可让我按现有代码风格生成）。")
    files = _collect_sources()
    if not files:
        D.info("未找到可格式化的源文件。")
        return
    opts = ["--dry-run", "--Werror"] if a.check else ["-i"]
    D.info(f"clang-format {'检查' if a.check else '格式化'} {len(files)} 个文件")
    D.run([fmt, *opts, *files])


def main() -> None:
    p = argparse.ArgumentParser(description="ArtNet Core 固件开发辅助")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("menuconfig", help="打开 menuconfig").set_defaults(func=do_menuconfig)

    sp_build = sub.add_parser("build", help="增量构建")
    sp_build.add_argument("--ccache", action="store_true", help="启用 ccache")
    sp_build.set_defaults(func=do_build)

    sp_test = sub.add_parser("test", help="构建并运行片上 Catch2 测试")
    sp_test.add_argument("-p", "--port", help="串口（烧录并查看测试输出）")
    sp_test.add_argument("--target", default=D.DEFAULT_TARGET, help="目标芯片")
    sp_test.add_argument("--build-only", action="store_true", help="只构建测试，不烧录")
    sp_test.set_defaults(func=do_test)

    sp_size = sub.add_parser("size", help="固件体积")
    sp_size.add_argument("--components", action="store_true", help="按组件细分")
    sp_size.set_defaults(func=do_size)

    sp_erase = sub.add_parser("erase", help="擦除整片 flash")
    sp_erase.add_argument("-p", "--port", help="串口")
    sp_erase.set_defaults(func=do_erase)

    sp_api = sub.add_parser("api", help="HTTP 冒烟（GET 只读端点）")
    sp_api.add_argument("--host", required=True, help="设备地址（IP 或 artnet-core.local）")
    sp_api.add_argument("--token", help="Bearer token（或环境变量 ARTNET_TOKEN）")
    sp_api.add_argument("--endpoint", action="append",
                        help="自定义端点（可多次；默认 status/config/player/diag）")
    sp_api.add_argument("--timeout", type=int, default=10, help="HTTP 超时秒数")
    sp_api.set_defaults(func=do_api)

    sp_fmt = sub.add_parser("fmt", help="clang-format 格式化")
    sp_fmt.add_argument("--check", action="store_true", help="只检查不改（CI 用）")
    sp_fmt.set_defaults(func=do_fmt)

    a = p.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
