"""Art-Net 扩展报文编解码:ArtPollReply、ArtAddress、ArtSync、ArtTimeCode、ArtNzs。

字段偏移依据 *Art-Net 4 Protocol Release V1.4 (Document Revision 1.4di, 2023-07-29)*
的各 "packet definition" 表逐项核对。

ArtPollReply 总长 239 字节,偏移如下:

=========  =====================================================
偏移       字段
=========  =====================================================
0..8       ID ``"Art-Net\\0"``
8..10      OpCode ``0x2100``(小端)
10..14     IP Address
14..16     Port ``0x1936``(小端)
16..18     VersInfoH / VersInfoL
18         NetSwitch(低 7 位)
19         SubSwitch(低 4 位)
20..22     OemHi / OemLo
22         UbeaVersion
23         Status1
24..26     EstaManLo / EstaManHi
26..44     PortName[18]
44..108    LongName[64]
108..172   NodeReport[64]
172..174   NumPortsHi / NumPortsLo
174..178   PortTypes[4]
178..182   GoodInput[4]
182..186   GoodOutputA[4]
186..190   SwIn[4]
190..194   SwOut[4]
194        AcnPriority
195        SwMacro
196        SwRemote
197..200   Spare
200        Style
201..207   MAC
207..211   BindIp
211        BindIndex
212        Status2
213..217   GoodOutputB[4]
217        Status3
218..224   DefaultRespUID
224..226   UserHi / UserLo
226..228   RefreshRateHi / RefreshRateLo
228..239   Filler
=========  =====================================================

接收端须接受长度不小于 207 字节的 ArtPollReply,缺失的字段视为 0。
"""

from __future__ import annotations

import ipaddress
import struct
from dataclasses import dataclass, field
from enum import IntEnum

from artnet_sim.protocol.artnet import ARTNET_ID, PROTOCOL_VERSION, OpCode, opcode_of
from artnet_sim.protocol.common import MAX_CHANNELS, MAX_PORT_ADDRESS

#: ArtPollReply 的 Port 字段(0x1936)。
ARTNET_REPLY_PORT = 0x1936

#: ArtPollReply 完整长度。
POLL_REPLY_LEN = 239

#: 接收端必须接受的 ArtPollReply 最小长度。
POLL_REPLY_MIN_LEN = 207

#: ArtAddress 报文长度。
ARTADDRESS_LEN = 107

#: ArtSync 报文长度。
ARTSYNC_LEN = 14

#: ArtTimeCode 报文长度。
ARTTIMECODE_LEN = 19

#: ArtNzs 固定头长度。
ARTNZS_HEADER_LEN = 18

#: RDM 的 START Code,ArtNzs 不得使用。
RDM_START_CODE = 0xCC

#: PortTypes 位:该口可把 Art-Net 数据输出为 DMX。
PORT_TYPE_OUTPUT = 0x80

#: PortTypes 位:该口可把 DMX 输入到 Art-Net 网络。
PORT_TYPE_INPUT = 0x40

#: GoodInput / GoodOutputA 位 7:有数据在传输。
GOOD_DATA_ACTIVE = 0x80

#: GoodOutputA 位 3:输出口正在合并 Art-Net 数据。
GOOD_OUTPUT_MERGING = 0x08

#: GoodOutputA 位 1:合并模式为 LTP。
GOOD_OUTPUT_LTP = 0x02

#: GoodOutputA 位 0:输出口选择 sACN。
GOOD_OUTPUT_SACN = 0x01

#: Status2 位 3:节点支持 15 位 Port-Address。
STATUS2_PORT_ADDRESS_15BIT = 0x08

#: Status2 位 4:节点可在 Art-Net 与 sACN 间切换。
STATUS2_ARTNET_SACN_SWITCHABLE = 0x10

#: ArtAddress 中 NetSwitch/SubSwitch/SwIn/SwOut 的"有效"标志位。
ADDRESS_PROGRAM_FLAG = 0x80

#: ArtAddress.acn_priority 的"不修改"哨兵值。
ACN_PRIORITY_NO_CHANGE = 255


class Style(IntEnum):
    """ArtPollReply 的设备样式码(Style)。"""

    NODE = 0x00
    CONTROLLER = 0x01
    MEDIA = 0x02
    ROUTE = 0x03
    BACKUP = 0x04
    CONFIG = 0x05
    VISUAL = 0x06


class NodeReportCode(IntEnum):
    """NodeReport 中的状态码(Table 3)。"""

    DEBUG = 0x0000
    POWER_OK = 0x0001
    POWER_FAIL = 0x0002
    SOCKET_WR1 = 0x0003
    PARSE_FAIL = 0x0004
    UDP_FAIL = 0x0005
    SH_NAME_OK = 0x0006
    LO_NAME_OK = 0x0007
    DMX_ERROR = 0x0008
    DMX_UDP_FULL = 0x0009
    DMX_RX_FULL = 0x000A
    SWITCH_ERR = 0x000B
    CONFIG_ERR = 0x000C
    DMX_SHORT = 0x000D
    FIRMWARE_FAIL = 0x000E
    USER_FAIL = 0x000F


class AddressCommand(IntEnum):
    """ArtAddress 的 Command 取值。"""

    NONE = 0x00
    CANCEL_MERGE = 0x01
    LED_NORMAL = 0x02
    LED_MUTE = 0x03
    LED_LOCATE = 0x04
    RESET_RX_FLAGS = 0x05
    ANALYSIS_ON = 0x06
    ANALYSIS_OFF = 0x07
    FAIL_HOLD = 0x08
    FAIL_ZERO = 0x09
    FAIL_FULL = 0x0A
    FAIL_SCENE = 0x0B
    FAIL_RECORD = 0x0C
    MERGE_LTP_0 = 0x10
    MERGE_LTP_1 = 0x11
    MERGE_LTP_2 = 0x12
    MERGE_LTP_3 = 0x13
    DIRECTION_TX_0 = 0x20
    DIRECTION_TX_1 = 0x21
    DIRECTION_TX_2 = 0x22
    DIRECTION_TX_3 = 0x23
    DIRECTION_RX_0 = 0x30
    DIRECTION_RX_1 = 0x31
    DIRECTION_RX_2 = 0x32
    DIRECTION_RX_3 = 0x33
    MERGE_HTP_0 = 0x50
    MERGE_HTP_1 = 0x51
    MERGE_HTP_2 = 0x52
    MERGE_HTP_3 = 0x53
    ARTNET_SEL_0 = 0x60
    ARTNET_SEL_1 = 0x61
    ARTNET_SEL_2 = 0x62
    ARTNET_SEL_3 = 0x63
    ACN_SEL_0 = 0x70
    ACN_SEL_1 = 0x71
    ACN_SEL_2 = 0x72
    ACN_SEL_3 = 0x73
    CLEAR_OP_0 = 0x90
    CLEAR_OP_1 = 0x91
    CLEAR_OP_2 = 0x92
    CLEAR_OP_3 = 0x93


class TimeCodeType(IntEnum):
    """ArtTimeCode 的帧率类型。"""

    FILM = 0
    EBU = 1
    DF = 2
    SMPTE = 3


def _pack_str(text: str, size: int) -> bytes:
    """把字符串编码为定长、NUL 结尾的字段(UTF-8,至多 ``size - 1`` 字节有效内容)。"""
    return text.encode("utf-8")[: size - 1].ljust(size, b"\x00")


def _unpack_str(raw: bytes) -> str:
    """读取定长字段中到第一个 NUL 为止的 UTF-8 字符串。"""
    return raw.split(b"\x00", 1)[0].decode("utf-8", errors="replace")


def _check_byte_list(name: str, values: tuple[int, ...], count: int = 4) -> None:
    """校验 ``values`` 恰好 ``count`` 项且每项都在 0~255。"""
    if len(values) != count:
        raise ValueError(f"{name} 必须有 {count} 项,实际 {len(values)}")
    for v in values:
        if not 0 <= v <= 0xFF:
            raise ValueError(f"{name} 含超出 0~255 的值: {v}")


def format_node_report(code: int, counter: int, text: str) -> str:
    """按规范格式 ``#xxxx [yyyy] zzzz`` 生成 NodeReport 文本。

    Args:
        code: 状态码(见 :class:`NodeReportCode`)。
        counter: 节点每发一次 ArtPollReply 就递增的计数,取低 16 位。
        text: 英文状态描述。

    Returns:
        格式化后的文本。
    """
    return f"#{code & 0xFFFF:04x} [{counter % 10000:04d}] {text}"


@dataclass(frozen=True, slots=True)
class PortInfo:
    """从 ArtPollReply 展开出的一个端口。

    Attributes:
        index: 端口序号,0~3。
        direction: ``input``(DMX → Art-Net)或 ``output``(Art-Net → DMX)。
        universe: 15 位 Port-Address。
        active: 是否有数据流。
    """

    index: int
    direction: str
    universe: int
    active: bool


@dataclass(slots=True)
class ArtPollReply:
    """ArtPollReply 报文。字段含义见模块文档。

    所有 4 项数组字段用长度为 4 的元组表示。字符串字段在编码时按 UTF-8 截断。
    """

    ip: str = "0.0.0.0"
    port: int = ARTNET_REPLY_PORT
    version: tuple[int, int] = (1, 0)
    net_switch: int = 0
    sub_switch: int = 0
    oem: int = 0xFFFF
    ubea_version: int = 0
    status1: int = 0xD0
    esta_man: int = 0x7FF0
    short_name: str = "artnet-sim"
    long_name: str = "Art-Net Studio simulated node"
    node_report: str = ""
    num_ports: int = 0
    port_types: tuple[int, int, int, int] = (0, 0, 0, 0)
    good_input: tuple[int, int, int, int] = (0, 0, 0, 0)
    good_output_a: tuple[int, int, int, int] = (0, 0, 0, 0)
    sw_in: tuple[int, int, int, int] = (0, 0, 0, 0)
    sw_out: tuple[int, int, int, int] = (0, 0, 0, 0)
    acn_priority: int = 100
    sw_macro: int = 0
    sw_remote: int = 0
    style: int = Style.NODE
    mac: bytes = b"\x00" * 6
    bind_ip: str = "0.0.0.0"
    bind_index: int = 1
    status2: int = STATUS2_PORT_ADDRESS_15BIT
    good_output_b: tuple[int, int, int, int] = (0, 0, 0, 0)
    status3: int = 0
    default_resp_uid: bytes = field(default=b"\x00" * 6)
    user: int = 0
    refresh_rate: int = 0

    def expand_ports(self) -> list[PortInfo]:
        """展开端口列表,规则与 Art-Net Studio 的 ``poll_reply_ports`` 一致。

        直接遍历 4 个槽位(规范允许忽略 ``num_ports``):``port_types`` 的 bit6 表示
        输入口,bit7 表示输出口;``good_*`` 的 bit7 表示有数据流。

        Returns:
            端口列表,每个槽位按先输入后输出的顺序给出。
        """
        net = self.net_switch & 0x7F
        sub = self.sub_switch & 0x0F
        ports: list[PortInfo] = []
        for i in range(4):
            kind = self.port_types[i]
            if kind & PORT_TYPE_INPUT:
                ports.append(
                    PortInfo(
                        i,
                        "input",
                        (net << 8) | (sub << 4) | (self.sw_in[i] & 0x0F),
                        bool(self.good_input[i] & GOOD_DATA_ACTIVE),
                    )
                )
            if kind & PORT_TYPE_OUTPUT:
                ports.append(
                    PortInfo(
                        i,
                        "output",
                        (net << 8) | (sub << 4) | (self.sw_out[i] & 0x0F),
                        bool(self.good_output_a[i] & GOOD_DATA_ACTIVE),
                    )
                )
        return ports

    def build(self) -> bytes:
        """编码为 239 字节的 ArtPollReply。

        Returns:
            完整报文。

        Raises:
            ValueError: 字段超出范围、IP 不合法或 MAC 不是 6 字节。
        """
        for name, values in (
            ("port_types", self.port_types),
            ("good_input", self.good_input),
            ("good_output_a", self.good_output_a),
            ("sw_in", self.sw_in),
            ("sw_out", self.sw_out),
            ("good_output_b", self.good_output_b),
        ):
            _check_byte_list(name, values)
        if len(self.mac) != 6:
            raise ValueError("MAC 必须为 6 字节")
        if len(self.default_resp_uid) != 6:
            raise ValueError("default_resp_uid 必须为 6 字节")
        if not 0 <= self.num_ports <= 4:
            raise ValueError(f"num_ports 超出范围 0~4: {self.num_ports}")
        for name, value in (
            ("net_switch", self.net_switch),
            ("sub_switch", self.sub_switch),
            ("ubea_version", self.ubea_version),
            ("status1", self.status1),
            ("acn_priority", self.acn_priority),
            ("sw_macro", self.sw_macro),
            ("sw_remote", self.sw_remote),
            ("style", self.style),
            ("bind_index", self.bind_index),
            ("status2", self.status2),
            ("status3", self.status3),
        ):
            if not 0 <= value <= 0xFF:
                raise ValueError(f"{name} 超出范围 0~255: {value}")
        for name, value in (
            ("port", self.port),
            ("oem", self.oem),
            ("esta_man", self.esta_man),
            ("user", self.user),
            ("refresh_rate", self.refresh_rate),
        ):
            if not 0 <= value <= 0xFFFF:
                raise ValueError(f"{name} 超出范围 0~65535: {value}")
        for name, value in (("version", self.version),):
            if len(value) != 2 or not all(0 <= v <= 0xFF for v in value):
                raise ValueError(f"{name} 必须是两个 0~255 的值")

        buf = bytearray(POLL_REPLY_LEN)
        buf[0:8] = ARTNET_ID
        struct.pack_into("<H", buf, 8, OpCode.POLL_REPLY)
        buf[10:14] = ipaddress.IPv4Address(self.ip).packed
        struct.pack_into("<H", buf, 14, self.port)
        buf[16], buf[17] = self.version
        buf[18] = self.net_switch
        buf[19] = self.sub_switch
        struct.pack_into(">H", buf, 20, self.oem)
        buf[22] = self.ubea_version
        buf[23] = self.status1
        struct.pack_into("<H", buf, 24, self.esta_man)
        buf[26:44] = _pack_str(self.short_name, 18)
        buf[44:108] = _pack_str(self.long_name, 64)
        buf[108:172] = _pack_str(self.node_report, 64)
        struct.pack_into(">H", buf, 172, self.num_ports)
        buf[174:178] = bytes(self.port_types)
        buf[178:182] = bytes(self.good_input)
        buf[182:186] = bytes(self.good_output_a)
        buf[186:190] = bytes(self.sw_in)
        buf[190:194] = bytes(self.sw_out)
        buf[194] = self.acn_priority
        buf[195] = self.sw_macro
        buf[196] = self.sw_remote
        buf[200] = self.style
        buf[201:207] = self.mac
        buf[207:211] = ipaddress.IPv4Address(self.bind_ip).packed
        buf[211] = self.bind_index
        buf[212] = self.status2
        buf[213:217] = bytes(self.good_output_b)
        buf[217] = self.status3
        buf[218:224] = self.default_resp_uid
        struct.pack_into(">H", buf, 224, self.user)
        struct.pack_into(">H", buf, 226, self.refresh_rate)
        return bytes(buf)


def parse_poll_reply(buf: bytes) -> ArtPollReply | None:
    """解析 ArtPollReply。

    长度不小于 207 字节即接受,缺失字段按 0 处理。

    Args:
        buf: UDP 载荷。

    Returns:
        解析结果;不是 ArtPollReply 或长度不足时返回 ``None``。
    """
    if opcode_of(buf) != OpCode.POLL_REPLY or len(buf) < POLL_REPLY_MIN_LEN:
        return None
    b = bytes(buf).ljust(POLL_REPLY_LEN, b"\x00")
    return ArtPollReply(
        ip=str(ipaddress.IPv4Address(b[10:14])),
        port=int.from_bytes(b[14:16], "little"),
        version=(b[16], b[17]),
        net_switch=b[18],
        sub_switch=b[19],
        oem=int.from_bytes(b[20:22], "big"),
        ubea_version=b[22],
        status1=b[23],
        esta_man=int.from_bytes(b[24:26], "little"),
        short_name=_unpack_str(b[26:44]),
        long_name=_unpack_str(b[44:108]),
        node_report=_unpack_str(b[108:172]),
        num_ports=int.from_bytes(b[172:174], "big"),
        port_types=tuple(b[174:178]),  # type: ignore[arg-type]
        good_input=tuple(b[178:182]),  # type: ignore[arg-type]
        good_output_a=tuple(b[182:186]),  # type: ignore[arg-type]
        sw_in=tuple(b[186:190]),  # type: ignore[arg-type]
        sw_out=tuple(b[190:194]),  # type: ignore[arg-type]
        acn_priority=b[194],
        sw_macro=b[195],
        sw_remote=b[196],
        style=b[200],
        mac=bytes(b[201:207]),
        bind_ip=str(ipaddress.IPv4Address(b[207:211])),
        bind_index=b[211],
        status2=b[212],
        good_output_b=tuple(b[213:217]),  # type: ignore[arg-type]
        status3=b[217],
        default_resp_uid=bytes(b[218:224]),
        user=int.from_bytes(b[224:226], "big"),
        refresh_rate=int.from_bytes(b[226:228], "big"),
    )


@dataclass(slots=True)
class ArtAddress:
    """ArtAddress 报文(远程修改节点配置)。

    ``net_switch`` / ``sub_switch`` / ``sw_in`` / ``sw_out`` 的编码规则:最高位(0x80)置位
    表示"按低位值编程",``0x00`` 表示恢复到物理开关设置,其余值被节点忽略。
    字符串为空表示"不修改"。

    Attributes:
        net_switch: Net 编程值。
        bind_index: 目标 BindIndex,1 表示根设备。
        port_name: 端口名(≤17 字符)。
        long_name: 节点长名(≤63 字符)。
        sw_in: 四个输入口的 Universe 编程值。
        sw_out: 四个输出口的 Universe 编程值。
        sub_switch: SubNet 编程值。
        acn_priority: sACN 优先级,255 表示不修改。
        command: 节点配置命令,见 :class:`AddressCommand`。
    """

    net_switch: int = 0
    bind_index: int = 1
    port_name: str = ""
    long_name: str = ""
    sw_in: tuple[int, int, int, int] = (0, 0, 0, 0)
    sw_out: tuple[int, int, int, int] = (0, 0, 0, 0)
    sub_switch: int = 0
    acn_priority: int = ACN_PRIORITY_NO_CHANGE
    command: int = AddressCommand.NONE

    def build(self) -> bytes:
        """编码为 107 字节的 ArtAddress。

        Returns:
            完整报文。

        Raises:
            ValueError: 字段超出 0~255 或数组长度不是 4。
        """
        _check_byte_list("sw_in", self.sw_in)
        _check_byte_list("sw_out", self.sw_out)
        for name, value in (
            ("net_switch", self.net_switch),
            ("bind_index", self.bind_index),
            ("sub_switch", self.sub_switch),
            ("acn_priority", self.acn_priority),
            ("command", self.command),
        ):
            if not 0 <= value <= 0xFF:
                raise ValueError(f"{name} 超出范围 0~255: {value}")
        return (
            ARTNET_ID
            + struct.pack("<H", OpCode.ADDRESS)
            + bytes(PROTOCOL_VERSION)
            + bytes((self.net_switch, self.bind_index))
            + _pack_str(self.port_name, 18)
            + _pack_str(self.long_name, 64)
            + bytes(self.sw_in)
            + bytes(self.sw_out)
            + bytes((self.sub_switch, self.acn_priority, self.command))
        )


def parse_address(buf: bytes) -> ArtAddress | None:
    """解析 ArtAddress。

    Args:
        buf: UDP 载荷。

    Returns:
        解析结果;不是 ArtAddress 或长度不足 107 字节时返回 ``None``。
    """
    if opcode_of(buf) != OpCode.ADDRESS or len(buf) < ARTADDRESS_LEN:
        return None
    return ArtAddress(
        net_switch=buf[12],
        bind_index=buf[13],
        port_name=_unpack_str(bytes(buf[14:32])),
        long_name=_unpack_str(bytes(buf[32:96])),
        sw_in=tuple(buf[96:100]),  # type: ignore[arg-type]
        sw_out=tuple(buf[100:104]),  # type: ignore[arg-type]
        sub_switch=buf[104],
        acn_priority=buf[105],
        command=buf[106],
    )


def decode_switch(value: int) -> tuple[str, int | None]:
    """解释 ArtAddress 里的开关编程值。

    Args:
        value: ``net_switch`` / ``sub_switch`` / ``sw_in`` / ``sw_out`` 的原始字节。

    Returns:
        ``(动作, 值)``:最高位置位时为 ``("program", 低 7 位)``;``0x00`` 为
        ``("reset", None)``,表示恢复到物理开关设置;其它值为 ``("ignore", None)``。
    """
    if value & ADDRESS_PROGRAM_FLAG:
        return "program", value & 0x7F
    if value == 0:
        return "reset", None
    return "ignore", None


def build_sync() -> bytes:
    """构造 ArtSync(14 字节)。

    Returns:
        完整报文。
    """
    return ARTNET_ID + struct.pack("<H", OpCode.SYNC) + bytes(PROTOCOL_VERSION) + b"\x00\x00"


def parse_sync(buf: bytes) -> bool:
    """判断缓冲是否为合法 ArtSync。

    Args:
        buf: UDP 载荷。

    Returns:
        是长度不小于 14 字节的 ArtSync 返回 ``True``。
    """
    return opcode_of(buf) == OpCode.SYNC and len(buf) >= ARTSYNC_LEN


@dataclass(frozen=True, slots=True)
class ArtTimeCode:
    """ArtTimeCode 报文。

    Attributes:
        frames: 帧,0~29(取决于类型)。
        seconds: 秒,0~59。
        minutes: 分,0~59。
        hours: 时,0~23。
        type: 帧率类型,见 :class:`TimeCodeType`。
    """

    frames: int
    seconds: int
    minutes: int
    hours: int
    type: int = TimeCodeType.SMPTE

    def build(self) -> bytes:
        """编码为 19 字节的 ArtTimeCode。

        Returns:
            完整报文。

        Raises:
            ValueError: 任一时间分量或类型超出范围。
        """
        for name, value, high in (
            ("frames", self.frames, 29),
            ("seconds", self.seconds, 59),
            ("minutes", self.minutes, 59),
            ("hours", self.hours, 23),
            ("type", self.type, 3),
        ):
            if not 0 <= value <= high:
                raise ValueError(f"{name} 超出范围 0~{high}: {value}")
        return (
            ARTNET_ID
            + struct.pack("<H", OpCode.TIME_CODE)
            + bytes(PROTOCOL_VERSION)
            + b"\x00\x00"
            + bytes((self.frames, self.seconds, self.minutes, self.hours, self.type))
        )


def parse_time_code(buf: bytes) -> ArtTimeCode | None:
    """解析 ArtTimeCode。

    Args:
        buf: UDP 载荷。

    Returns:
        解析结果;不是 ArtTimeCode 或长度不足 19 字节时返回 ``None``。
    """
    if opcode_of(buf) != OpCode.TIME_CODE or len(buf) < ARTTIMECODE_LEN:
        return None
    return ArtTimeCode(
        frames=buf[14], seconds=buf[15], minutes=buf[16], hours=buf[17], type=buf[18]
    )


@dataclass(frozen=True, slots=True)
class ArtNzs:
    """ArtNzs 报文(非零起始码的 DMX512 数据)。

    Attributes:
        sequence: 序号,0 表示不启用。
        start_code: DMX512 START Code,不得为 0 或 RDM(0xCC)。
        port_address: 15 位 Port-Address。
        data: 通道数据,1~512 字节。
    """

    sequence: int
    start_code: int
    port_address: int
    data: bytes

    def build(self) -> bytes:
        """编码为 ArtNzs 报文(18 字节头 + 数据)。

        Returns:
            完整报文。

        Raises:
            ValueError: 序号、START Code、Port-Address 或数据长度不合法。
        """
        if not 0 <= self.sequence <= 0xFF:
            raise ValueError(f"序号超出范围 0~255: {self.sequence}")
        if not 0 <= self.start_code <= 0xFF or self.start_code in (0, RDM_START_CODE):
            raise ValueError(f"START Code 不能为 0 或 0xCC: {self.start_code}")
        if not 0 <= self.port_address <= MAX_PORT_ADDRESS:
            raise ValueError(f"Port-Address 超出范围 0~{MAX_PORT_ADDRESS}: {self.port_address}")
        if not 1 <= len(self.data) <= MAX_CHANNELS:
            raise ValueError(f"数据长度须为 1~{MAX_CHANNELS},实际 {len(self.data)}")
        return (
            ARTNET_ID
            + struct.pack("<H", OpCode.NZS)
            + bytes(PROTOCOL_VERSION)
            + bytes((self.sequence, self.start_code))
            + bytes((self.port_address & 0xFF, self.port_address >> 8))
            + struct.pack(">H", len(self.data))
            + self.data
        )


def parse_nzs(buf: bytes) -> ArtNzs | None:
    """解析 ArtNzs。

    Args:
        buf: UDP 载荷。

    Returns:
        解析结果;不是 ArtNzs 或长度不足 18 字节时返回 ``None``。
    """
    if opcode_of(buf) != OpCode.NZS or len(buf) < ARTNZS_HEADER_LEN:
        return None
    port_address = buf[14] | (buf[15] << 8)
    if port_address > MAX_PORT_ADDRESS:
        return None
    return ArtNzs(
        sequence=buf[12],
        start_code=buf[13],
        port_address=port_address,
        data=bytes(buf[ARTNZS_HEADER_LEN:]),
    )
