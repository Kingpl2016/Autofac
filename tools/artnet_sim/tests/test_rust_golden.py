"""由 Art-Net Studio 的 Rust 实现(artnet-net crate)生成的黄金向量。

Python 端构造的报文必须与它**逐字节一致**。向量用 `cargo` 里一次性的交叉验证程序生成,
之后固化在这里,所以测试本身不依赖 Rust 工具链。
"""

from artnet_sim.protocol import artnet, sacn

RUST_CID = bytes([0x11] * 16)

DMX_CASES = [
    (
        1,
        5,
        bytes.fromhex("ff 00 80"),
        "41 72 74 2d 4e 65 74 00 00 50 00 0e 05 00 01 00 00 04 ff 00 80 00",
    ),
    (
        32767,
        255,
        bytes.fromhex(
            "00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f 20 21 22 23 24 25 26 27 28 29 2a 2b 2c 2d 2e 2f 30 31 32 33 34 35 36 37 38 39 3a 3b 3c 3d 3e 3f 40 41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50 51 52 53 54 55 56 57 58 59 5a 5b 5c 5d 5e 5f 60 61 62 63 64 65 66 67 68 69 6a 6b 6c 6d 6e 6f 70 71 72 73 74 75 76 77 78 79 7a 7b 7c 7d 7e 7f 80 81 82 83 84 85 86 87 88 89 8a 8b 8c 8d 8e 8f 90 91 92 93 94 95 96 97 98 99 9a 9b 9c 9d 9e 9f a0 a1 a2 a3 a4 a5 a6 a7 a8 a9 aa ab ac ad ae af b0 b1 b2 b3 b4 b5 b6 b7 b8 b9 ba bb bc bd be bf c0 c1 c2 c3 c4 c5 c6 c7 c8 c9 ca cb cc cd ce cf d0 d1 d2 d3 d4 d5 d6 d7 d8 d9 da db dc dd de df e0 e1 e2 e3 e4 e5 e6 e7 e8 e9 ea eb ec ed ee ef f0 f1 f2 f3 f4 f5 f6 f7 f8 f9 fa fb fc fd fe ff"
        ),
        "41 72 74 2d 4e 65 74 00 00 50 00 0e ff 00 ff 7f 01 00 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f 20 21 22 23 24 25 26 27 28 29 2a 2b 2c 2d 2e 2f 30 31 32 33 34 35 36 37 38 39 3a 3b 3c 3d 3e 3f 40 41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50 51 52 53 54 55 56 57 58 59 5a 5b 5c 5d 5e 5f 60 61 62 63 64 65 66 67 68 69 6a 6b 6c 6d 6e 6f 70 71 72 73 74 75 76 77 78 79 7a 7b 7c 7d 7e 7f 80 81 82 83 84 85 86 87 88 89 8a 8b 8c 8d 8e 8f 90 91 92 93 94 95 96 97 98 99 9a 9b 9c 9d 9e 9f a0 a1 a2 a3 a4 a5 a6 a7 a8 a9 aa ab ac ad ae af b0 b1 b2 b3 b4 b5 b6 b7 b8 b9 ba bb bc bd be bf c0 c1 c2 c3 c4 c5 c6 c7 c8 c9 ca cb cc cd ce cf d0 d1 d2 d3 d4 d5 d6 d7 d8 d9 da db dc dd de df e0 e1 e2 e3 e4 e5 e6 e7 e8 e9 ea eb ec ed ee ef f0 f1 f2 f3 f4 f5 f6 f7 f8 f9 fa fb fc fd fe ff",
    ),
    (
        0,
        0,
        bytes.fromhex("01 02 03 04"),
        "41 72 74 2d 4e 65 74 00 00 50 00 0e 00 00 00 00 00 04 01 02 03 04",
    ),
]

SACN_CASES = [
    (
        1,
        100,
        0,
        False,
        "artnet-sim",
        bytes.fromhex("01 01 01 01 01 01 01 01"),
        "00 10 00 00 41 53 43 2d 45 31 2e 31 37 00 00 00 70 76 00 00 00 04 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 70 60 00 00 00 02 61 72 74 6e 65 74 2d 73 69 6d 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 64 00 00 00 00 00 01 70 13 02 a1 00 00 00 01 00 09 00 01 01 01 01 01 01 01 01",
    ),
    (
        63999,
        200,
        255,
        False,
        "x",
        bytes.fromhex("09 08"),
        "00 10 00 00 41 53 43 2d 45 31 2e 31 37 00 00 00 70 70 00 00 00 04 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 70 5a 00 00 00 02 78 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 c8 00 00 ff 00 f9 ff 70 0d 02 a1 00 00 00 01 00 03 00 09 08",
    ),
    (
        5,
        100,
        3,
        True,
        "abc",
        bytes.fromhex("00 00 00 00 00 00 00 00 00 00"),
        "00 10 00 00 41 53 43 2d 45 31 2e 31 37 00 00 00 70 78 00 00 00 04 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 11 70 62 00 00 00 02 61 62 63 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 64 00 00 03 40 00 05 70 15 02 a1 00 00 00 01 00 0b 00 00 00 00 00 00 00 00 00 00 00",
    ),
]


def test_artdmx_matches_rust_bytes():
    for pa, seq, data, expected in DMX_CASES:
        assert artnet.build_dmx(pa, seq, data).hex(" ") == expected


def test_sacn_matches_rust_bytes():
    for universe, priority, seq, terminated, name, data, expected in SACN_CASES:
        build = sacn.build_terminated if terminated else sacn.build_data
        if terminated:
            packet = build(universe, data, RUST_CID, name, priority, seq)
        else:
            packet = build(universe, data, RUST_CID, name, priority, seq)
        assert packet.hex(" ") == expected


def test_python_parses_rust_built_packets():
    for pa, seq, data, expected in DMX_CASES:
        parsed = artnet.parse_dmx(bytes.fromhex(expected))
        assert parsed is not None
        assert (parsed.port_address, parsed.sequence) == (pa, seq)
        assert parsed.data.rstrip(b"\x00") == data.rstrip(b"\x00")
    for universe, priority, seq, terminated, name, data, expected in SACN_CASES:
        parsed = sacn.parse_data(bytes.fromhex(expected))
        assert parsed is not None
        assert (parsed.universe, parsed.priority, parsed.sequence) == (universe, priority, seq)
        assert (parsed.source_name, parsed.terminated, parsed.data) == (name, terminated, data)
