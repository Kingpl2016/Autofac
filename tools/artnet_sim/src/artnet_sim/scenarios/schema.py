"""场景文件的结构、解析与校验。

场景 YAML 示例::

    name: 优先级接管
    duration: 30
    sources:
      - id: a
        protocol: sacn
        universes: 1-4
        generator: rainbow
        params: {speed: 0.3}
        priority: 100
        target: multicast
    nodes:
      - id: n1
        ip: auto
        ports: [{direction: output, address: 0}]
    timeline:
      - {at: 10, action: set, target: a, values: {priority: 150}}
      - {at: 20, action: stop, target: a}

所有错误都以 :class:`ScenarioError` 抛出,消息带字段路径,例如 ``sources[1].rate: ...``。
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from artnet_sim.generators import make_generator
from artnet_sim.node.config import NodeConfig
from artnet_sim.protocol.common import (
    MAX_PORT_ADDRESS,
    SACN_MAX_UNIVERSE,
    SACN_MIN_UNIVERSE,
)
from artnet_sim.sender.impairments import Impairments
from artnet_sim.sender.source import Source, SourceConfig
from artnet_sim.util import parse_ranges

#: 作用于信号源的动作。
SOURCE_ACTIONS = frozenset({"start", "stop", "pause", "resume", "freeze", "unfreeze", "set"})

#: 作用于虚拟节点的动作。
NODE_ACTIONS = frozenset({"online", "offline"})

#: 不需要目标的动作。
OTHER_ACTIONS = frozenset({"log"})

#: ``set`` 动作允许修改的字段(与 :meth:`Source.update` 一致)。
SET_FIELDS = frozenset(
    {"rate", "priority", "channels", "source_name", "generator", "generator_params", "impairments"}
)

#: 信号源目标的前缀:``node:<id>`` 表示发给场景里那个虚拟节点,运行时替换成它的实际 IP。
NODE_TARGET_PREFIX = "node:"

#: 路径改写函数:收到场景里写的路径,返回实际使用的路径,不允许时抛 ``ValueError``。
PathResolver = Callable[[str], str]

#: 展开重复事件时的数量上限,防止写错 ``every`` 导致内存爆炸。
MAX_EVENTS = 10_000

_TOP_KEYS = {
    "name",
    "description",
    "duration",
    "interface",
    "allow_public",
    "sources",
    "nodes",
    "timeline",
}
_SOURCE_KEYS = {
    "id",
    "protocol",
    "universes",
    "generator",
    "params",
    "rate",
    "priority",
    "channels",
    "target",
    "port",
    "interface",
    "source_name",
    "cid",
    "allow_public",
    "physical",
    "impairments",
    "autostart",
}
_EVENT_KEYS = {"at", "action", "target", "values", "terminate", "message", "every", "until"}


class ScenarioError(ValueError):
    """场景文件不合法。"""


@dataclass(slots=True)
class SourceSpec:
    """场景里的一个信号源。

    Attributes:
        config: 信号源配置。
        autostart: 场景开始时是否自动启动;为 ``False`` 时需要时间线里的 ``start`` 动作。
    """

    config: SourceConfig
    autostart: bool = True


@dataclass(frozen=True, slots=True)
class TimelineEvent:
    """时间线上的一个事件(重复事件已展开)。

    Attributes:
        at: 触发时刻(场景开始后的秒数)。
        action: 动作名。
        target: 目标信号源或节点的 id;``log`` 动作没有目标。
        values: ``set`` 动作的字段。
        terminate: ``stop`` 动作是否发送 Stream_Terminated(仅 sACN)。
        message: ``log`` 动作的文字。
    """

    at: float
    action: str
    target: str | None = None
    values: dict[str, Any] = field(default_factory=dict)
    terminate: bool = True
    message: str = ""


@dataclass(slots=True)
class Scenario:
    """解析并校验后的场景。

    Attributes:
        name: 场景名称。
        description: 说明。
        duration: 运行时长(秒);``None`` 表示运行到最后一个事件。
        sources: 信号源列表。
        nodes: 虚拟节点配置列表。
        auto_ip_nodes: IP 写成 ``auto`` 的节点 id,由运行器按环境决定真实 IP。
        timeline: 按时间排序的事件列表。
        interface: 场景默认网卡。
    """

    name: str
    description: str = ""
    duration: float | None = None
    interface: str | None = None
    sources: list[SourceSpec] = field(default_factory=list)
    nodes: list[NodeConfig] = field(default_factory=list)
    auto_ip_nodes: set[str] = field(default_factory=set)
    timeline: list[TimelineEvent] = field(default_factory=list)

    @property
    def end_time(self) -> float | None:
        """场景结束时刻:有 ``duration`` 取它,否则取最后一个事件;两者都没有返回 ``None``。"""
        if self.duration is not None:
            return self.duration
        return self.timeline[-1].at if self.timeline else None

    def summary(self) -> str:
        """一行概要。"""
        end = self.end_time
        length = "持续运行" if end is None else f"{end:g} 秒"
        return (
            f"{self.name}: {len(self.sources)} 个信号源, {len(self.nodes)} 个节点, "
            f"{len(self.timeline)} 个事件, {length}"
        )


class _NullTransport:
    """校验 ``set`` 动作时用的空发送通道。"""

    def send(self, packet: bytes, dest: tuple[str, int]) -> bool:
        return True


def _guard(path: str, func: Callable[[], Any]) -> Any:
    """执行 ``func``,把其中的 ``ValueError`` 等转成带路径的 :class:`ScenarioError`。"""
    try:
        return func()
    except ScenarioError:
        raise
    except (ValueError, TypeError, LookupError) as exc:
        raise ScenarioError(f"{path}: {exc}") from exc


def _expect_mapping(path: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ScenarioError(f"{path}: 必须是键值对象,实际是 {type(value).__name__}")
    return value


def _expect_list(path: str, value: Any) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ScenarioError(f"{path}: 必须是列表,实际是 {type(value).__name__}")
    return value


def _number(path: str, value: Any, *, minimum: float = 0.0, exclusive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ScenarioError(f"{path}: 必须是数字,实际 {value!r}")
    if value < minimum or (exclusive and value == minimum):
        relation = ">" if exclusive else "≥"
        raise ScenarioError(f"{path}: 必须 {relation} {minimum:g},实际 {value!r}")
    return float(value)


def _reject_unknown(path: str, data: dict[str, Any], allowed: set[str]) -> None:
    unknown = set(data) - allowed
    if unknown:
        raise ScenarioError(
            f"{path}: 未知字段 {', '.join(sorted(map(str, unknown)))};可用字段: "
            f"{', '.join(sorted(allowed))}"
        )


def _parse_universes(protocol: str, value: Any) -> list[int]:
    low, high = (
        (0, MAX_PORT_ADDRESS) if protocol == "artnet" else (SACN_MIN_UNIVERSE, SACN_MAX_UNIVERSE)
    )
    if isinstance(value, bool):
        raise ValueError(f"universes 不能是布尔值: {value!r}")
    if isinstance(value, int):
        return parse_ranges(str(value), minimum=low, maximum=high)
    if isinstance(value, str):
        return parse_ranges(value, minimum=low, maximum=high)
    if isinstance(value, list):
        if not all(isinstance(v, int) and not isinstance(v, bool) for v in value):
            raise ValueError("universes 列表里必须都是整数")
        if len(set(value)) != len(value):
            raise ValueError("universes 含重复项")
        for v in value:
            if not low <= v <= high:
                raise ValueError(f"{protocol} 的 Universe 必须在 {low}~{high},实际 {v}")
        return list(value)
    raise ValueError(f"universes 必须是范围字符串、整数或整数列表,实际 {value!r}")


def _universes_field(protocol: str, value: Any) -> list[int]:
    """解析 ``universes`` 字段,错误信息带上字段名。"""
    try:
        return _parse_universes(protocol, value)
    except ValueError as exc:
        raise ValueError(f"universes: {exc}") from None


def _parse_source(
    index: int,
    data: Any,
    scenario_name: str,
    default_interface: str | None,
    default_public: bool,
    resolve_path: PathResolver | None = None,
) -> SourceSpec:
    path = f"sources[{index}]"
    raw = _expect_mapping(path, data)
    _reject_unknown(path, raw, _SOURCE_KEYS)
    if "id" not in raw:
        raise ScenarioError(f"{path}: 缺少 id")
    source_id = str(raw["id"])
    path = f"sources[{index}]({source_id})"

    def build() -> SourceSpec:
        protocol = raw.get("protocol", "artnet")
        if protocol not in ("artnet", "sacn"):
            raise ValueError(f"protocol 必须是 artnet 或 sacn,实际 {protocol!r}")
        autostart = raw.get("autostart", True)
        if not isinstance(autostart, bool):
            raise ValueError(f"autostart 必须是 true/false,实际 {autostart!r}")
        allow_public = raw.get("allow_public", default_public)
        if not isinstance(allow_public, bool):
            raise ValueError(f"allow_public 必须是 true/false,实际 {allow_public!r}")
        params = raw.get("params", {})
        if not isinstance(params, dict):
            raise ValueError("params 必须是键值对象")
        if resolve_path is not None and "path" in params:
            params = {**params, "path": resolve_path(str(params["path"]))}
        kwargs: dict[str, Any] = {
            key: raw[key]
            for key in (
                "rate",
                "priority",
                "channels",
                "target",
                "port",
                "source_name",
                "physical",
            )
            if key in raw
        }
        for key in ("rate", "priority", "channels", "port", "physical"):
            if key in kwargs and (
                isinstance(kwargs[key], bool) or not isinstance(kwargs[key], int | float)
            ):
                raise ValueError(f"{key} 必须是数字,实际 {kwargs[key]!r}")
        # 同一个场景里 sACN 源的 CID 固定下来:重启信号源后身份不变,多次运行也一致。
        cid = (
            raw.get("cid")
            or uuid.uuid5(uuid.NAMESPACE_URL, f"artnet-sim/{scenario_name}/{source_id}").hex
        )
        config = SourceConfig(
            id=source_id,
            protocol=protocol,
            universes=_universes_field(
                protocol, raw.get("universes", "1" if protocol == "sacn" else "0")
            ),
            generator=raw.get("generator", "fixed"),
            generator_params=dict(params),
            interface=raw.get("interface", default_interface),
            cid=cid,
            allow_public=allow_public,
            impairments=Impairments.from_dict(dict(raw.get("impairments") or {})),
            **kwargs,
        )
        config.validate()
        make_generator(config.generator, config.generator_params)
        return SourceSpec(config, autostart)

    return _guard(path, build)  # type: ignore[no-any-return]


def _parse_node(index: int, data: Any) -> tuple[NodeConfig, bool]:
    path = f"nodes[{index}]"
    raw = _expect_mapping(path, data)
    if "id" in raw:
        path = f"nodes[{index}]({raw['id']})"

    def build() -> tuple[NodeConfig, bool]:
        payload = dict(raw)
        auto = payload.get("ip") == "auto"
        if auto:
            payload["ip"] = "127.0.0.2"  # 占位,运行时再决定真实 IP
        return NodeConfig.from_dict(payload), auto

    return _guard(path, build)  # type: ignore[no-any-return]


def _dry_run_set(spec: SourceSpec, values: dict[str, Any]) -> None:
    """用一个临时信号源演练 ``set`` 动作,提前发现非法取值。"""
    cfg = spec.config
    probe = Source(
        SourceConfig(
            id=cfg.id,
            protocol=cfg.protocol,
            universes=list(cfg.universes),
            generator=cfg.generator,
            generator_params=dict(cfg.generator_params),
            rate=cfg.rate,
            priority=cfg.priority,
            channels=cfg.channels,
            cid=cfg.cid,
            impairments=Impairments.from_dict(cfg.impairments.to_dict()),
        ),
        _NullTransport(),
        {u: ("0.0.0.0", 0) for u in cfg.universes},
    )
    probe.update(values)


def _parse_event(
    index: int,
    data: Any,
    sources: dict[str, SourceSpec],
    nodes: set[str],
    duration: float | None,
    resolve_path: PathResolver | None = None,
) -> list[TimelineEvent]:
    path = f"timeline[{index}]"
    raw = _expect_mapping(path, data)
    _reject_unknown(path, raw, _EVENT_KEYS)
    if "at" not in raw or "action" not in raw:
        raise ScenarioError(f"{path}: 必须包含 at 和 action")
    at = _number(f"{path}.at", raw["at"])
    action = raw["action"]
    all_actions = SOURCE_ACTIONS | NODE_ACTIONS | OTHER_ACTIONS
    if action not in all_actions:
        raise ScenarioError(
            f"{path}.action: 未知动作 {action!r};可用: {', '.join(sorted(all_actions))}"
        )
    target = raw.get("target")
    if action in SOURCE_ACTIONS and target not in sources:
        raise ScenarioError(
            f"{path}.target: 信号源 {target!r} 不存在;已有: {', '.join(sources) or '(无)'}"
        )
    if action in NODE_ACTIONS and target not in nodes:
        raise ScenarioError(
            f"{path}.target: 节点 {target!r} 不存在;已有: {', '.join(sorted(nodes)) or '(无)'}"
        )
    values = raw.get("values", {})
    message = str(raw.get("message", ""))
    terminate = raw.get("terminate", True)
    if not isinstance(terminate, bool):
        raise ScenarioError(f"{path}.terminate: 必须是 true/false")
    if action == "set":
        values = _expect_mapping(f"{path}.values", values)
        if not values:
            raise ScenarioError(f"{path}.values: set 动作必须提供要修改的字段")
        if resolve_path is not None:
            values = dict(values)
            gen_params = values.get("generator_params")
            if isinstance(gen_params, dict) and "path" in gen_params:
                values["generator_params"] = {
                    **gen_params,
                    "path": _guard(f"{path}.values", lambda: resolve_path(str(gen_params["path"]))),
                }
        unknown = set(values) - SET_FIELDS
        if unknown:
            raise ScenarioError(
                f"{path}.values: 不支持运行中修改 {', '.join(sorted(unknown))};"
                f"可用: {', '.join(sorted(SET_FIELDS))}"
            )
        _guard(f"{path}.values", lambda: _dry_run_set(sources[target], values))  # type: ignore[index]
    if action == "log" and not message:
        raise ScenarioError(f"{path}.message: log 动作必须提供 message")

    times = [at]
    if "every" in raw:
        every = _number(f"{path}.every", raw["every"], exclusive=True)
        if "until" in raw:
            until = _number(f"{path}.until", raw["until"])
        elif duration is not None:
            until = duration
        else:
            raise ScenarioError(f"{path}: 使用 every 时必须提供 until,或在场景里设置 duration")
        if until < at:
            raise ScenarioError(f"{path}.until: 不能早于 at")
        count = int((until - at) / every + 1e-9) + 1
        if count > MAX_EVENTS:
            raise ScenarioError(f"{path}: 重复事件过多({count} > {MAX_EVENTS}),请增大 every")
        times = [round(at + i * every, 6) for i in range(count)]
    elif "until" in raw:
        raise ScenarioError(f"{path}: until 必须和 every 一起使用")
    return [
        TimelineEvent(
            t, action, target, dict(values) if action == "set" else {}, terminate, message
        )
        for t in times
    ]


def load_scenario_text(
    text: str, origin: str = "<文本>", *, resolve_path: PathResolver | None = None
) -> Scenario:
    """解析并校验场景 YAML。

    Args:
        text: YAML 文本。
        origin: 来源描述,出现在错误信息里。
        resolve_path: 可选的路径改写/检查函数,作用于生成器参数里的 ``path``(例如 ``artrec`` 回放)。
            Web 服务用它把路径限制在录制目录内;它可以抛 ``ValueError`` 拒绝某个路径。

    Returns:
        校验通过的场景。

    Raises:
        ScenarioError: YAML 语法错误或内容不合法。
    """
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f"第 {mark.line + 1} 行第 {mark.column + 1} 列" if mark else ""
        problem = getattr(exc, "problem", None) or str(exc)
        raise ScenarioError(f"{origin}: YAML 语法错误 {where}: {problem}") from exc
    if not isinstance(data, dict):
        raise ScenarioError(f"{origin}: 顶层必须是键值对象")
    try:
        return _build(data, resolve_path)
    except ScenarioError as exc:
        raise ScenarioError(f"{origin}: {exc}") from None


def _build(data: dict[str, Any], resolve_path: PathResolver | None = None) -> Scenario:
    _reject_unknown("场景", data, _TOP_KEYS)
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ScenarioError("name: 必须提供非空的场景名称")
    duration: float | None = None
    if "duration" in data and data["duration"] is not None:
        duration = _number("duration", data["duration"], exclusive=True)
    interface = data.get("interface")
    if interface is not None and not isinstance(interface, str):
        raise ScenarioError("interface: 必须是字符串")
    allow_public = data.get("allow_public", False)
    if not isinstance(allow_public, bool):
        raise ScenarioError("allow_public: 必须是 true/false")

    sources = [
        _parse_source(i, item, name, interface, allow_public, resolve_path)
        for i, item in enumerate(_expect_list("sources", data.get("sources")))
    ]
    by_id: dict[str, SourceSpec] = {}
    for spec in sources:
        if spec.config.id in by_id:
            raise ScenarioError(f"sources: id {spec.config.id!r} 重复")
        by_id[spec.config.id] = spec

    nodes: list[NodeConfig] = []
    auto_ip: set[str] = set()
    for i, item in enumerate(_expect_list("nodes", data.get("nodes"))):
        config, auto = _parse_node(i, item)
        if any(n.id == config.id for n in nodes):
            raise ScenarioError(f"nodes: id {config.id!r} 重复")
        nodes.append(config)
        if auto:
            auto_ip.add(config.id)

    node_ids = {n.id for n in nodes}
    for spec in sources:
        target = spec.config.target
        if not target.startswith(NODE_TARGET_PREFIX):
            continue
        ref = target[len(NODE_TARGET_PREFIX) :]
        if ref not in node_ids:
            raise ScenarioError(
                f"sources[{spec.config.id}].target: 节点 {ref!r} 不存在;"
                f"已有: {', '.join(sorted(node_ids)) or '(无)'}"
            )

    events: list[TimelineEvent] = []
    for i, item in enumerate(_expect_list("timeline", data.get("timeline"))):
        events.extend(_parse_event(i, item, by_id, node_ids, duration, resolve_path))
    if len(events) > MAX_EVENTS:
        raise ScenarioError(f"timeline: 展开后事件过多({len(events)} > {MAX_EVENTS})")
    events.sort(key=lambda e: e.at)  # 稳定排序:同一时刻保持书写顺序
    if duration is not None:
        late = [e for e in events if e.at > duration]
        if late:
            raise ScenarioError(
                f"timeline: 有事件的时间 {late[0].at:g} 超过了 duration={duration:g}"
            )
    if not sources and not nodes:
        raise ScenarioError("场景里至少要有一个信号源或节点")
    return Scenario(
        name=name.strip(),
        description=str(data.get("description", "")).strip(),
        duration=duration,
        interface=interface,
        sources=sources,
        nodes=nodes,
        auto_ip_nodes=auto_ip,
        timeline=events,
    )


def load_scenario_file(path: str | Path) -> Scenario:
    """读取并校验场景文件(UTF-8)。

    Args:
        path: 文件路径。

    Returns:
        校验通过的场景。

    Raises:
        ScenarioError: 文件读不了或内容不合法。
    """
    file = Path(path)
    try:
        text = file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ScenarioError(f"{file}: 无法读取: {exc}") from exc
    return load_scenario_text(text, origin=str(file))
