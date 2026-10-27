"""Web 服务的运行设置。"""

from __future__ import annotations

import ipaddress
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

from artnet_sim.protocol.common import ARTNET_PORT, SACN_PORT

#: 默认监听端口。
DEFAULT_PORT = 8765

#: 默认的全局发包速率上限(包/秒)。
DEFAULT_MAX_PPS = 20_000

#: 环境变量:预先指定令牌,免得每次启动都变。
TOKEN_ENV = "ARTNET_SIM_TOKEN"

#: 只在本机访问时允许的 Host 名称。
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})


def default_data_dir() -> Path:
    """默认数据目录:当前目录下的 ``artnet-sim-data``(录制文件放在这里)。"""
    return Path.cwd() / "artnet-sim-data"


def new_token() -> str:
    """生成一个随机访问令牌。"""
    return secrets.token_urlsafe(24)


@dataclass(slots=True)
class WebSettings:
    """Web 服务设置。

    Attributes:
        host: 监听地址。``lan`` 为真时通常是 ``0.0.0.0``。
        port: 监听端口。
        lan: 是否允许局域网访问。开启后强制要求令牌。
        token: 访问令牌;``lan`` 为真时必须非空。
        allowed_hosts: 额外允许的 ``Host`` 名称(例如电脑的主机名)。
        data_dir: 数据目录,录制的 ``.artrec`` 保存在 ``<data_dir>/recordings``。
        max_pps: 全局发包速率上限(包/秒),防止误把局域网打满。
        allow_public: 是否允许发往公网地址。
        artnet_port: Art-Net 监听/回复端口。
        sacn_port: sACN 监听端口。
        auto_capture: 启动时自动开始抓包。
        max_upload_mb: 上传 ``.artrec`` 的大小上限(MiB)。
    """

    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    lan: bool = False
    token: str | None = None
    allowed_hosts: frozenset[str] = field(default_factory=frozenset)
    data_dir: Path = field(default_factory=default_data_dir)
    max_pps: int = DEFAULT_MAX_PPS
    allow_public: bool = False
    artnet_port: int = ARTNET_PORT
    sacn_port: int = SACN_PORT
    auto_capture: bool = True
    max_upload_mb: int = 256

    def validate(self) -> None:
        """校验设置。

        Raises:
            ValueError: 开启局域网访问却没有令牌,或数值不合法。
        """
        if self.lan and not self.token:
            raise ValueError("开启局域网访问(--lan)时必须设置访问令牌")
        if not self.lan and not _is_loopback(self.host):
            raise ValueError(
                f"监听地址 {self.host} 不是本机地址;要让其他电脑访问请使用 --lan(会强制令牌认证)"
            )
        if not 1 <= self.port <= 65535:
            raise ValueError(f"端口必须在 1~65535,实际 {self.port}")
        if self.max_pps < 1:
            raise ValueError("max_pps 必须 ≥ 1")
        if self.max_upload_mb < 1:
            raise ValueError("max_upload_mb 必须 ≥ 1")

    @property
    def auth_required(self) -> bool:
        """是否要求令牌认证。"""
        return self.lan or bool(self.token)

    @property
    def recordings_dir(self) -> Path:
        """录制文件目录。"""
        return self.data_dir / "recordings"


def _is_loopback(host: str) -> bool:
    """判断监听地址是否是环回地址。"""
    if host in LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def token_from_env() -> str | None:
    """读取环境变量里预设的令牌;没设置返回 ``None``。"""
    value = os.environ.get(TOKEN_ENV, "").strip()
    return value or None
