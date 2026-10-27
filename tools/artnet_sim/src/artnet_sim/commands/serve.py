"""``serve`` 子命令:启动 Web 界面。"""

from __future__ import annotations

import argparse
import contextlib
import socket
import sys
import webbrowser
from pathlib import Path

from artnet_sim.net.interfaces import list_interfaces
from artnet_sim.protocol.common import ARTNET_PORT, SACN_PORT
from artnet_sim.web.settings import (
    DEFAULT_MAX_PPS,
    DEFAULT_PORT,
    WebSettings,
    default_data_dir,
    new_token,
    token_from_env,
)


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """给 ``serve`` 子命令添加参数。

    Args:
        parser: 子命令的解析器。
    """
    parser.add_argument("--host", help="监听地址(默认 127.0.0.1;--lan 时默认 0.0.0.0)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"端口(默认 {DEFAULT_PORT})")
    parser.add_argument(
        "--lan",
        action="store_true",
        help="允许局域网内其他电脑访问。会强制令牌认证并在启动时打印带令牌的链接",
    )
    parser.add_argument(
        "--token",
        help="访问令牌;--lan 时不填则自动生成。也可用环境变量 ARTNET_SIM_TOKEN 预先指定",
    )
    parser.add_argument(
        "--allowed-host",
        action="append",
        default=[],
        help="--lan 时额外允许的 Host 名称(如电脑主机名),可重复",
    )
    parser.add_argument("--data-dir", type=Path, default=None, help="数据目录(录制文件保存在其下)")
    parser.add_argument(
        "--max-pps",
        type=int,
        default=DEFAULT_MAX_PPS,
        help="全局发包速率上限,包/秒(默认 %(default)s);超过会拒绝创建或修改信号源",
    )
    parser.add_argument("--allow-public", action="store_true", help="允许发往公网地址")
    parser.add_argument("--no-capture", action="store_true", help="启动时不自动开始抓包")
    parser.add_argument(
        "--artnet-port", type=int, default=ARTNET_PORT, help="Art-Net 端口(默认 %(default)s)"
    )
    parser.add_argument(
        "--sacn-port", type=int, default=SACN_PORT, help="sACN 端口(默认 %(default)s)"
    )
    parser.add_argument(
        "--max-upload-mb",
        type=int,
        default=256,
        help="上传 .artrec 的大小上限,MiB(默认 %(default)s)",
    )
    parser.add_argument("--open", action="store_true", help="启动后用浏览器打开(仅本机模式)")


def build_settings(args: argparse.Namespace) -> WebSettings:
    """由命令行参数构造并校验设置。

    Args:
        args: 解析后的命令行参数。

    Returns:
        校验通过的设置。

    Raises:
        ValueError: 设置不合法。
    """
    token = args.token or token_from_env()
    if args.lan and not token:
        token = new_token()
    settings = WebSettings(
        host=args.host or ("0.0.0.0" if args.lan else "127.0.0.1"),
        port=args.port,
        lan=args.lan,
        token=token,
        allowed_hosts=frozenset(h.lower() for h in args.allowed_host),
        data_dir=args.data_dir or default_data_dir(),
        max_pps=args.max_pps,
        allow_public=args.allow_public,
        artnet_port=args.artnet_port,
        sacn_port=args.sacn_port,
        auto_capture=not args.no_capture,
        max_upload_mb=args.max_upload_mb,
    )
    settings.validate()
    return settings


def access_urls(settings: WebSettings) -> list[str]:
    """列出访问地址;需要令牌时,带上登录用的 ``?token=``。

    Args:
        settings: Web 设置。

    Returns:
        地址列表。局域网模式列出每块可用网卡的地址。
    """
    suffix = f"/login?token={settings.token}" if settings.auth_required else "/"
    if not settings.lan:
        return [f"http://127.0.0.1:{settings.port}{suffix}"]
    hosts = [i.ip for i in list_interfaces() if i.usable]
    return [f"http://{h}:{settings.port}{suffix}" for h in hosts] or [
        f"http://127.0.0.1:{settings.port}{suffix}"
    ]


def _port_free(host: str, port: int) -> bool:
    """检查 TCP 端口能否绑定。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def run(args: argparse.Namespace) -> int:
    """执行 ``serve``。

    Args:
        args: 解析后的命令行参数。

    Returns:
        进程退出码:0 正常退出,2 参数错误,1 无法监听。
    """
    try:
        settings = build_settings(args)
    except ValueError as exc:
        print(f"参数错误: {exc}", file=sys.stderr)
        return 2
    if not _port_free(settings.host, settings.port):
        print(
            f"无法监听 {settings.host}:{settings.port}:端口已被占用,请用 --port 换一个",
            file=sys.stderr,
        )
        return 1

    import uvicorn

    from artnet_sim.web.app import create_app

    app = create_app(settings)
    print("Art-Net / sACN 模拟工具", file=sys.stderr)
    for url in access_urls(settings):
        print(f"  访问地址: {url}", file=sys.stderr)
    if settings.lan:
        print(
            "  ⚠ 已开启局域网访问:任何拿到令牌的人都能让本机向网络发送灯光信号。\n"
            "    请不要把带令牌的链接发到不受信任的地方;令牌只在本次运行有效"
            "(除非用 --token 或 ARTNET_SIM_TOKEN 固定)。",
            file=sys.stderr,
        )
    elif settings.auth_required:
        print("  已启用令牌认证。", file=sys.stderr)
    print(f"  数据目录: {settings.data_dir}    发包上限: {settings.max_pps} 包/秒", file=sys.stderr)
    if args.open and not settings.lan:
        webbrowser.open(access_urls(settings)[0])
    config = uvicorn.Config(
        app,
        host=settings.host,
        port=settings.port,
        log_level="warning",
        access_log=False,
        ws_max_size=64 * 1024,
    )
    with contextlib.suppress(KeyboardInterrupt):
        uvicorn.Server(config).run()
    return 0
