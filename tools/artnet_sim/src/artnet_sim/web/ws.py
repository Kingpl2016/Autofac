r"""WebSocket 实时推送:``/ws/live``。

客户端 → 服务端(JSON 文本)::

    {"type": "watch", "items": [
        {"kind": "universe", "protocol": "artnet", "universe": 1},
        {"kind": "node", "id": "node-1", "port": 0}
    ]}
    {"type": "ping"}

服务端 → 客户端:

- JSON 文本:``hello``(连接成功)、``stats``(每秒一次的整体状态与抓包统计)、``watching``、
  ``pong``、``error``。
- 二进制帧(监看的通道数据,每秒最多 30 次,只在数据变化时发送,静止时每秒补发一次):

  ===========  =====================================================
  类型 1       ``u8 1`` ``u8 协议(1=Art-Net, 2=sACN)`` ``u16 Universe(大端)`` ``通道数据``
  类型 2       ``u8 2`` ``u8 节点 id 长度`` ``节点 id(UTF-8)`` ``u16 端口序号(大端)`` ``通道数据``
  ===========  =====================================================
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import struct
import time
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from artnet_sim.web.state import AppCore

router = APIRouter()

#: 推送监看数据的频率(Hz)。
FRAME_HZ = 30

#: 静止的数据多久补发一次(秒),让刚连上或丢帧的客户端能追上。
KEEPALIVE_S = 1.0

#: 统计推送的间隔(秒)。
STATS_INTERVAL_S = 1.0

#: 一个连接最多监看多少项。
MAX_WATCH = 32

PROTOCOL_CODE = {"artnet": 1, "sacn": 2}


@dataclass(frozen=True, slots=True)
class Watch:
    """一个监看项。"""

    kind: str
    protocol: str = ""
    universe: int = 0
    node_id: str = ""
    port: int = 0


def parse_watch(items: Any) -> list[Watch]:
    """校验并解析客户端的监看列表。

    Args:
        items: 客户端发来的 ``items`` 字段。

    Returns:
        监看项列表。

    Raises:
        ValueError: 格式不对、数量超限或字段非法。
    """
    if not isinstance(items, list):
        raise ValueError("items 必须是列表")
    if len(items) > MAX_WATCH:
        raise ValueError(f"最多同时监看 {MAX_WATCH} 项")
    result = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("监看项必须是对象")
        kind = item.get("kind")
        if kind == "universe":
            protocol, universe = item.get("protocol"), item.get("universe")
            if protocol not in PROTOCOL_CODE:
                raise ValueError("protocol 必须是 artnet 或 sacn")
            if not isinstance(universe, int) or isinstance(universe, bool):
                raise ValueError("universe 必须是整数")
            if not 0 <= universe <= 0xFFFF:
                raise ValueError("universe 超出范围")
            result.append(Watch("universe", protocol=protocol, universe=universe))
        elif kind == "node":
            node_id, port = item.get("id"), item.get("port", 0)
            if not isinstance(node_id, str) or not node_id or len(node_id.encode()) > 255:
                raise ValueError("节点 id 不合法")
            if not isinstance(port, int) or isinstance(port, bool) or not 0 <= port <= 0xFFFF:
                raise ValueError("端口序号不合法")
            result.append(Watch("node", node_id=node_id, port=port))
        else:
            raise ValueError("kind 必须是 universe 或 node")
    return result


def encode_universe_frame(protocol: str, universe: int, data: bytes) -> bytes:
    """编码类型 1 的二进制帧。"""
    return struct.pack(">BBH", 1, PROTOCOL_CODE[protocol], universe) + data


def encode_node_frame(node_id: str, port: int, data: bytes) -> bytes:
    """编码类型 2 的二进制帧。"""
    raw = node_id.encode("utf-8")
    return struct.pack(">BB", 2, len(raw)) + raw + struct.pack(">H", port) + data


def collect_frames(
    core: AppCore, watches: list[Watch], last: dict[Watch, tuple[bytes, float]], now: float
) -> list[bytes]:
    """收集这一拍需要发送的二进制帧:数据变化了,或距上次发送已超过保活间隔。

    Args:
        core: 应用核心。
        watches: 当前监看列表。
        last: 每个监看项上次发送的(数据, 时刻),会被更新。
        now: 当前时刻(单调秒)。

    Returns:
        要发送的二进制帧。
    """
    frames: list[bytes] = []
    for watch in watches:
        if watch.kind == "universe":
            found = core.hub.latest(watch.protocol, watch.universe)
            if found is None:
                continue
            data = found[0]
        else:
            node = core._nodes.get(watch.node_id) if core._nodes else None
            if node is None:
                continue
            data = node.port_output(watch.port)
            if not data:
                continue
        previous = last.get(watch)
        if previous is not None and previous[0] == data and now - previous[1] < KEEPALIVE_S:
            continue
        last[watch] = (data, now)
        if watch.kind == "universe":
            frames.append(encode_universe_frame(watch.protocol, watch.universe, data))
        else:
            frames.append(encode_node_frame(watch.node_id, watch.port, data))
    return frames


@router.websocket("/ws/live")
async def live(ws: WebSocket) -> None:
    """实时推送端点。"""
    core: AppCore = ws.app.state.core
    await ws.accept()
    watches: list[Watch] = []
    last: dict[Watch, tuple[bytes, float]] = {}
    await ws.send_text(json.dumps({"type": "hello", "frame_hz": FRAME_HZ}))

    async def pump_frames() -> None:
        interval = 1.0 / FRAME_HZ
        while True:
            started = time.monotonic()
            for frame in collect_frames(core, watches, last, started):
                await ws.send_bytes(frame)
            await asyncio.sleep(max(0.0, interval - (time.monotonic() - started)))

    async def pump_stats() -> None:
        while True:
            snapshot = await asyncio.to_thread(core.hub.snapshot)
            payload = {"type": "stats", "state": core.state(), "capture": snapshot}
            await ws.send_text(json.dumps(payload, ensure_ascii=False))
            await asyncio.sleep(STATS_INTERVAL_S)

    async def receive_commands() -> None:
        nonlocal watches
        while True:
            text = await ws.receive_text()
            try:
                message = json.loads(text)
                if not isinstance(message, dict):
                    raise ValueError("消息必须是 JSON 对象")
                kind = message.get("type")
                if kind == "watch":
                    watches = parse_watch(message.get("items", []))
                    last.clear()
                    await ws.send_text(json.dumps({"type": "watching", "count": len(watches)}))
                elif kind == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
                else:
                    raise ValueError(f"未知消息类型: {kind!r}")
            except (ValueError, json.JSONDecodeError) as exc:
                await ws.send_text(
                    json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False)
                )

    tasks = [
        asyncio.create_task(pump_frames()),
        asyncio.create_task(pump_stats()),
        asyncio.create_task(receive_commands()),
    ]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                await task
