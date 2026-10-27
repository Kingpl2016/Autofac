import pytest

from artnet_sim.cli import _parse_hex, main
from artnet_sim.protocol import artnet, sacn
from artnet_sim.protocol.decode import decode

CID = bytes(range(16))


def test_decode_artdmx():
    result = decode(artnet.build_dmx(0x0123, 9, b"\x01\x02"))
    assert (result.protocol, result.kind) == ("artnet", "ArtDmx")
    fields = dict(result.fields)
    assert fields["序号"] == "9"
    assert "Net 1 / SubNet 2 / Universe 3" in fields["Port-Address"]
    assert fields["实际通道数"] == "2"


def test_decode_artpoll():
    result = decode(artnet.build_poll())
    assert result.kind == "ArtPoll"
    assert dict(result.fields)["Flags"] == "0x02"


def test_decode_sacn_with_terminated():
    result = decode(sacn.build_terminated(7, b"\x01", CID, source_name="台A", sequence=4))
    assert (result.protocol, result.kind) == ("sacn", "sACN 数据包")
    fields = dict(result.fields)
    assert fields["Universe"] == "7"
    assert fields["源名称"] == "台A"
    assert "Stream_Terminated" in fields["Options"]


def test_decode_unknown_artnet_opcode_and_garbage():
    pkt = b"Art-Net\x00" + (0xF800).to_bytes(2, "little") + b"\x00" * 10  # ArtIpProg
    assert "0xF800" in decode(pkt).kind
    assert decode(b"hello").protocol == "unknown"


def test_decode_invalid_dmx_does_not_raise():
    short = b"Art-Net\x00" + (0x5000).to_bytes(2, "little") + b"\x00" * 3
    assert decode(short).kind == "ArtDmx(无效)"


@pytest.mark.parametrize(
    "text",
    ["41 72 74", "0x41,0x72,0x74", "41:72:74", "417274", "41-72-74"],
)
def test_parse_hex_accepts_common_formats(text):
    assert _parse_hex(text) == b"Art"


def test_cli_inspect_prints_fields(capsys):
    hex_text = artnet.build_dmx(1, 5, b"\xff\x00").hex(" ")
    assert main(["inspect", hex_text]) == 0
    out = capsys.readouterr().out
    assert "ArtDmx" in out
    assert "序号" in out


def test_cli_inspect_rejects_bad_hex(capsys):
    assert main(["inspect", "zz"]) == 2
    assert "十六进制解析失败" in capsys.readouterr().err


def test_cli_without_command_prints_help(capsys):
    assert main([]) == 0
    assert "inspect" in capsys.readouterr().out
