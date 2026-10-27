"""虚拟节点配置。"""

from __future__ import annotations

import hashlib
import ipaddress
from dataclasses import dataclass, field, fields
from typing import Any

from artnet_sim.protocol.artnet_ext import Style
from artnet_sim.protocol.common import MAX_PORT_ADDRESS

#: 端口方向。
DIRECTIONS = ("output", "input", "both")

#: 合并模式。
MERGE_MODES = ("htp", "ltp")

#: 输出口接收的协议。
PORT_PROTOCOLS = ("artnet", "sacn")

#: 单个节点最多的端口数(每 4 个端口一个 Bind)。
MAX_PORTS = 64

#: 每个 Bind 最多的端口数。
PORTS_PER_BIND = 4


@dataclass(slots=True)
class PortConfig:
    """一个端口的配置。

    Attributes:
        direction: ``output``(Art-Net/sACN → DMX)、``input``(DMX → Art-Net)或 ``both``。
        address: 15 位 Port-Address。
        merge_mode: 输出口的合并模式,``htp`` 逐通道取大,``ltp`` 取最后到达的一帧。
        protocol: 输出口接收的协议,``artnet`` 或 ``sacn``;可被 ArtAddress 命令改变。
    """

    direction: str = "output"
    address: int = 0
    merge_mode: str = "htp"
    protocol: str = "artnet"

    def validate(self) -> None:
        """校验字段。

        Raises:
            ValueError: 任一字段不合法。
        """
        if self.direction not in DIRECTIONS:
            raise ValueError(
                f"direction 必须是 {', '.join(DIRECTIONS)} 之一,实际 {self.direction!r}"
            )
        if not 0 <= self.address <= MAX_PORT_ADDRESS:
            raise ValueError(f"address 必须在 0~{MAX_PORT_ADDRESS},实际 {self.address}")
        if self.merge_mode not in MERGE_MODES:
            raise ValueError(
                f"merge_mode 必须是 {', '.join(MERGE_MODES)} 之一,实际 {self.merge_mode!r}"
            )
        if self.protocol not in PORT_PROTOCOLS:
            raise ValueError(
                f"protocol 必须是 {', '.join(PORT_PROTOCOLS)} 之一,实际 {self.protocol!r}"
            )


@dataclass(slots=True)
class NodeConfig:
    """虚拟节点配置。

    Attributes:
        id: 唯一标识。
        ip: 节点对外宣告并绑定的 IPv4。必须是本机已有的地址(物理网卡、辅助 IP 或
            ``127.0.0.x`` 环回别名),否则无法绑定。
        short_name: 短名,最多 17 字符。
        long_name: 长名,最多 63 字符。
        oem: OEM 码。
        esta_man: ESTA 厂商码,默认 ``0x7FF0``(ESTA 为原型/实验保留)。
        version: 固件版本 ``(高, 低)``。
        style: 设备样式码,见 :class:`~artnet_sim.protocol.artnet_ext.Style`。
        mac: MAC 地址(12 位十六进制,可含分隔符);``None`` 时由 ``id`` 派生一个本地管理地址。
        ports: 端口列表;每 4 个、且共享 Net/SubNet 的端口自动组成一个 Bind。
        acn_priority: 节点把收到的 DMX 转成 sACN 时使用的优先级(仅在 ArtPollReply 里宣告)。
        sacn_universe_offset: sACN 模式的输出口监听的 Universe = Port-Address + 该偏移。
            许多设备把 Art-Net Universe 0 对应 sACN Universe 1,所以默认是 1。
        merge_hold_s: 合并中的一个源停发后,在合并缓冲里保留多久(Art-Net 规范为 10 秒)。
        active_timeout_s: 超过多久没收到数据,输出口就不再算"有数据"。
        online: 是否在线;离线时既不回复 ArtPoll,也不处理数据。
    """

    id: str
    ip: str = "127.0.0.2"
    short_name: str = "artnet-sim"
    long_name: str = "Art-Net Studio simulated node"
    oem: int = 0xFFFF
    esta_man: int = 0x7FF0
    version: tuple[int, int] = (1, 0)
    style: int = Style.NODE
    mac: str | None = None
    ports: list[PortConfig] = field(default_factory=lambda: [PortConfig()])
    acn_priority: int = 100
    sacn_universe_offset: int = 1
    merge_hold_s: float = 10.0
    active_timeout_s: float = 4.0
    online: bool = True

    def validate(self) -> None:
        """校验配置。

        Raises:
            ValueError: 任一字段不合法。
        """
        if not self.id:
            raise ValueError("节点 id 不能为空")
        try:
            ipaddress.IPv4Address(self.ip)
        except ValueError:
            raise ValueError(f"ip 不是合法的 IPv4: {self.ip!r}") from None
        if len(self.short_name.encode("utf-8")) > 17:
            raise ValueError("short_name 不能超过 17 字节")
        if len(self.long_name.encode("utf-8")) > 63:
            raise ValueError("long_name 不能超过 63 字节")
        if not 0 <= self.oem <= 0xFFFF or not 0 <= self.esta_man <= 0xFFFF:
            raise ValueError("oem 与 esta_man 必须在 0~65535")
        if len(self.version) != 2 or not all(0 <= v <= 255 for v in self.version):
            raise ValueError("version 必须是两个 0~255 的值")
        if not 0 <= self.style <= 255:
            raise ValueError("style 必须在 0~255")
        if not 0 <= self.acn_priority <= 200:
            raise ValueError("acn_priority 必须在 0~200")
        if not 0 <= self.sacn_universe_offset <= 1:
            raise ValueError("sacn_universe_offset 必须是 0 或 1")
        if self.merge_hold_s < 0 or self.active_timeout_s <= 0:
            raise ValueError("merge_hold_s 须 ≥ 0,active_timeout_s 须 > 0")
        if not 1 <= len(self.ports) <= MAX_PORTS:
            raise ValueError(f"端口数必须在 1~{MAX_PORTS},实际 {len(self.ports)}")
        for port in self.ports:
            port.validate()
        if self.mac is not None:
            self.mac_bytes()

    def mac_bytes(self) -> bytes:
        """返回 6 字节 MAC。

        Returns:
            配置了 ``mac`` 时返回它;否则由 ``id`` 的哈希派生,首字节 ``0x02``
            (本地管理的单播地址),同一个 ``id`` 永远得到同一个 MAC。

        Raises:
            ValueError: 配置的 ``mac`` 不是 12 位十六进制。
        """
        if self.mac is None:
            return b"\x02" + hashlib.sha256(self.id.encode("utf-8")).digest()[:5]
        cleaned = "".join(ch for ch in self.mac if ch not in ":-. ")
        try:
            raw = bytes.fromhex(cleaned)
        except ValueError:
            raise ValueError(f"mac 不是合法的十六进制: {self.mac!r}") from None
        if len(raw) != 6:
            raise ValueError(f"mac 必须是 6 字节: {self.mac!r}")
        return raw

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> NodeConfig:
        """由字典构造并校验。

        Args:
            data: 字段字典;``ports`` 是端口字典列表。

        Returns:
            校验通过的配置。

        Raises:
            ValueError: 含未知字段或取值不合法。
        """
        known = {f.name for f in fields(cls)}
        unknown = set(data) - known
        if unknown:
            raise ValueError(f"未知的节点字段: {', '.join(sorted(unknown))}")
        payload = dict(data)
        if "ports" in payload:
            port_fields = {f.name for f in fields(PortConfig)}
            ports = []
            for item in payload["ports"]:
                bad = set(item) - port_fields
                if bad:
                    raise ValueError(f"未知的端口字段: {', '.join(sorted(bad))}")
                ports.append(PortConfig(**item))
            payload["ports"] = ports
        if "version" in payload:
            payload["version"] = tuple(payload["version"])
        config = cls(**payload)
        config.validate()
        return config


def group_binds(ports: list[PortConfig]) -> list[list[int]]:
    """把端口按顺序分组为 Bind。

    ArtPollReply 的 NetSwitch/SubSwitch 对一个 Bind 里的 4 个端口是共用的,所以只有
    连续的、共享 ``address >> 4`` 的端口才能进同一个 Bind,每个 Bind 最多 4 个端口。

    Args:
        ports: 端口配置列表。

    Returns:
        每个 Bind 一项,内容是端口在 ``ports`` 里的下标。
    """
    groups: list[list[int]] = []
    for index, port in enumerate(ports):
        if (
            groups
            and len(groups[-1]) < PORTS_PER_BIND
            and ports[groups[-1][0]].address >> 4 == port.address >> 4
        ):
            groups[-1].append(index)
        else:
            groups.append([index])
    return groups
