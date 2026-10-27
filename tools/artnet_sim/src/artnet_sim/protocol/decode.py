"""通用报文解码:自动识别协议并输出人类可读字段,供 ``inspect`` 子命令使用。"""

from __future__ import annotations

from dataclasses import dataclass

from artnet_sim.protocol import artnet, artnet_ext, sacn
from artnet_sim.protocol.common import split_port_address


@dataclass(frozen=True, slots=True)
class Decoded:
    """一个报文的解码结果。

    Attributes:
        protocol: 协议名,``artnet`` / ``sacn`` / ``unknown``。
        kind: 报文类型的中文名称。
        fields: 有序的(字段名, 字段值)列表。
    """

    protocol: str
    kind: str
    fields: list[tuple[str, str]]


def _preview(data: bytes, limit: int = 16) -> str:
    """把通道数据格式化为带省略号的十六进制预览。"""
    head = data[:limit].hex(" ")
    return f"{head} ..." if len(data) > limit else head


def _pa(port_address: int) -> str:
    """格式化 15 位 Port-Address。"""
    net, sub, uni = split_port_address(port_address)
    return f"{port_address} (Net {net} / SubNet {sub} / Universe {uni})"


def summarize(buf: bytes) -> str:
    """把一个 UDP 载荷概括成一行文本,用于抓包列表。

    Args:
        buf: UDP 载荷。

    Returns:
        单行概要;无法识别时返回 ``未知报文 (N 字节)``。
    """
    dmx = artnet.parse_dmx(buf)
    if dmx is not None:
        return f"ArtDmx  PA={dmx.port_address} seq={dmx.sequence} ch={len(dmx.data)}"
    data = sacn.parse_data(buf)
    if data is not None:
        term = " TERMINATED" if data.terminated else ""
        return (
            f"sACN    U={data.universe} prio={data.priority} seq={data.sequence} "
            f"ch={len(data.data)} src={data.source_name!r}{term}"
        )
    decoded = decode(buf)
    if decoded.protocol == "unknown":
        return f"未知报文 ({len(buf)} 字节)"
    return decoded.kind


def decode(buf: bytes) -> Decoded:
    """识别并解码一个 UDP 载荷。

    Args:
        buf: UDP 载荷。

    Returns:
        解码结果;无法识别时 ``protocol`` 为 ``unknown``。
    """
    opcode = artnet.opcode_of(buf)
    if opcode is not None:
        return _decode_artnet(buf, opcode)
    if sacn.is_sacn(buf):
        return _decode_sacn(buf)
    return Decoded("unknown", "未知报文", [("长度", f"{len(buf)} 字节")])


def _invalid(kind: str, buf: bytes) -> Decoded:
    """构造"报文无效"的解码结果。"""
    return Decoded("artnet", f"{kind}(无效)", [("长度", f"{len(buf)} 字节")])


def _decode_artnet(buf: bytes, opcode: int) -> Decoded:
    """解码 Art-Net 报文。"""
    if opcode == artnet.OpCode.DMX:
        dmx = artnet.parse_dmx(buf)
        if dmx is None:
            return _invalid("ArtDmx", buf)
        return Decoded(
            "artnet",
            "ArtDmx",
            [
                ("协议版本", str(dmx.protocol_version)),
                ("序号", str(dmx.sequence)),
                ("物理端口", str(dmx.physical)),
                ("Port-Address", _pa(dmx.port_address)),
                ("声明长度", str(dmx.declared_length)),
                ("实际通道数", str(len(dmx.data))),
                ("通道数据", _preview(dmx.data)),
            ],
        )
    if opcode == artnet.OpCode.POLL:
        poll = artnet.parse_poll(buf)
        if poll is None:
            return _invalid("ArtPoll", buf)
        return Decoded(
            "artnet",
            "ArtPoll",
            [
                ("协议版本", str(poll.protocol_version)),
                ("Flags", f"0x{poll.flags:02X}"),
                ("诊断优先级", f"0x{poll.diag_priority:02X}"),
            ],
        )
    if opcode == artnet.OpCode.POLL_REPLY:
        return _decode_poll_reply(buf)
    if opcode == artnet.OpCode.ADDRESS:
        return _decode_address(buf)
    if opcode == artnet.OpCode.SYNC:
        if not artnet_ext.parse_sync(buf):
            return _invalid("ArtSync", buf)
        return Decoded("artnet", "ArtSync", [])
    if opcode == artnet.OpCode.TIME_CODE:
        tc = artnet_ext.parse_time_code(buf)
        if tc is None:
            return _invalid("ArtTimeCode", buf)
        try:
            type_name = artnet_ext.TimeCodeType(tc.type).name
        except ValueError:
            type_name = str(tc.type)
        return Decoded(
            "artnet",
            "ArtTimeCode",
            [
                ("时间码", f"{tc.hours:02d}:{tc.minutes:02d}:{tc.seconds:02d}:{tc.frames:02d}"),
                ("类型", type_name),
            ],
        )
    if opcode == artnet.OpCode.NZS:
        nzs = artnet_ext.parse_nzs(buf)
        if nzs is None:
            return _invalid("ArtNzs", buf)
        return Decoded(
            "artnet",
            "ArtNzs",
            [
                ("序号", str(nzs.sequence)),
                ("START Code", f"0x{nzs.start_code:02X}"),
                ("Port-Address", _pa(nzs.port_address)),
                ("通道数", str(len(nzs.data))),
                ("通道数据", _preview(nzs.data)),
            ],
        )
    try:
        name = artnet.OpCode(opcode).name
    except ValueError:
        name = f"0x{opcode:04X}"
    return Decoded("artnet", f"Art-Net {name}(暂未解码)", [("长度", f"{len(buf)} 字节")])


def _decode_poll_reply(buf: bytes) -> Decoded:
    """解码 ArtPollReply。"""
    reply = artnet_ext.parse_poll_reply(buf)
    if reply is None:
        return _invalid("ArtPollReply", buf)
    try:
        style = artnet_ext.Style(reply.style).name
    except ValueError:
        style = f"0x{reply.style:02X}"
    fields = [
        ("IP", reply.ip),
        ("固件版本", f"{reply.version[0]}.{reply.version[1]}"),
        ("短名", reply.short_name),
        ("长名", reply.long_name),
        ("节点报告", reply.node_report),
        ("OEM", f"0x{reply.oem:04X}"),
        ("ESTA", f"0x{reply.esta_man:04X}"),
        ("Style", style),
        ("MAC", reply.mac.hex(":")),
        ("BindIp / BindIndex", f"{reply.bind_ip} / {reply.bind_index}"),
        ("NetSwitch / SubSwitch", f"{reply.net_switch} / {reply.sub_switch}"),
        ("声明端口数", str(reply.num_ports)),
    ]
    for p in reply.expand_ports():
        direction = "输入" if p.direction == "input" else "输出"
        fields.append(
            (
                f"端口 {p.index + 1} {direction}",
                f"Universe {p.universe}" + ("  有数据" if p.active else ""),
            )
        )
    return Decoded("artnet", "ArtPollReply", fields)


def _decode_address(buf: bytes) -> Decoded:
    """解码 ArtAddress。"""
    addr = artnet_ext.parse_address(buf)
    if addr is None:
        return _invalid("ArtAddress", buf)
    try:
        command = artnet_ext.AddressCommand(addr.command).name
    except ValueError:
        command = f"0x{addr.command:02X}"

    def sw(value: int) -> str:
        action, low = artnet_ext.decode_switch(value)
        return {"program": f"编程为 {low}", "reset": "恢复物理设置", "ignore": "忽略"}[action]

    return Decoded(
        "artnet",
        "ArtAddress",
        [
            ("BindIndex", str(addr.bind_index)),
            ("端口名", addr.port_name),
            ("长名", addr.long_name),
            ("NetSwitch", sw(addr.net_switch)),
            ("SubSwitch", sw(addr.sub_switch)),
            ("SwIn", ", ".join(sw(v) for v in addr.sw_in)),
            ("SwOut", ", ".join(sw(v) for v in addr.sw_out)),
            (
                "sACN 优先级",
                "不修改"
                if addr.acn_priority == artnet_ext.ACN_PRIORITY_NO_CHANGE
                else str(addr.acn_priority),
            ),
            ("命令", command),
        ],
    )


def _decode_sacn(buf: bytes) -> Decoded:
    """解码 sACN 报文。"""
    kind = sacn.packet_kind(buf)
    if kind == "sync":
        sync = sacn.parse_sync(buf)
        if sync is None:
            return Decoded("sacn", "sACN 同步包(无效)", [("长度", f"{len(buf)} 字节")])
        return Decoded(
            "sacn",
            "sACN 同步包",
            [
                ("同步地址", str(sync.sync_address)),
                ("序号", str(sync.sequence)),
                ("CID", sync.cid.hex()),
            ],
        )
    if kind == "discovery":
        disc = sacn.parse_discovery(buf)
        if disc is None:
            return Decoded("sacn", "sACN Discovery(无效)", [("长度", f"{len(buf)} 字节")])
        return Decoded(
            "sacn",
            "sACN Universe Discovery",
            [
                ("源名称", disc.source_name),
                ("CID", disc.cid.hex()),
                ("页", f"{disc.page + 1} / {disc.last_page + 1}"),
                ("Universe 数", str(len(disc.universes))),
                (
                    "Universe 列表",
                    ", ".join(str(u) for u in disc.universes[:32])
                    + (" ..." if len(disc.universes) > 32 else ""),
                ),
            ],
        )
    data = sacn.parse_data(buf)
    if data is None:
        return Decoded("sacn", "sACN(非数据包或无效)", [("长度", f"{len(buf)} 字节")])
    flags = []
    if data.terminated:
        flags.append("Stream_Terminated")
    if data.preview:
        flags.append("Preview")
    return Decoded(
        "sacn",
        "sACN 数据包",
        [
            ("Universe", str(data.universe)),
            ("优先级", str(data.priority)),
            ("序号", str(data.sequence)),
            ("Options", f"0x{data.options:02X}" + (f" ({', '.join(flags)})" if flags else "")),
            ("同步地址", str(data.sync_address)),
            ("源名称", data.source_name),
            ("CID", data.cid.hex()),
            ("START Code", str(data.start_code)),
            ("通道数", str(len(data.data))),
            ("通道数据", _preview(data.data)),
        ],
    )
