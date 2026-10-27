"""场景运行器:按时间线驱动发送引擎和虚拟节点。"""

from __future__ import annotations

import dataclasses
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

from artnet_sim.net.clock import Clock, RealClock
from artnet_sim.node.manager import NodeManager
from artnet_sim.scenarios.schema import NODE_TARGET_PREFIX, Scenario, TimelineEvent
from artnet_sim.sender.engine import SendEngine
from artnet_sim.sender.source import SourceConfig

#: 等待下一个事件时,单次休眠的上限(秒),决定停止请求的响应速度。
_MAX_WAIT_S = 0.05


@dataclass(frozen=True, slots=True)
class AppliedEvent:
    """一个已执行的事件。

    Attributes:
        at: 计划时刻(秒)。
        actual: 实际执行时刻(秒)。
        description: 中文描述。
        error: 执行失败时的错误信息。
    """

    at: float
    actual: float
    description: str
    error: str | None = None


@dataclass(slots=True)
class RunReport:
    """场景运行结果。

    Attributes:
        applied: 按顺序执行的事件。
        elapsed: 实际运行的秒数。
        stopped_early: 是否被外部请求提前停止。
    """

    applied: list[AppliedEvent] = field(default_factory=list)
    elapsed: float = 0.0
    stopped_early: bool = False

    @property
    def errors(self) -> list[AppliedEvent]:
        """执行失败的事件。"""
        return [e for e in self.applied if e.error]


class ScenarioRunner:
    """场景运行器。

    Args:
        scenario: 已校验的场景。
        engine: 发送引擎(调用方负责 ``start`` / ``stop``)。
        nodes: 节点管理器;场景含节点时必须提供(调用方负责 ``start`` / ``stop``)。
        clock: 时钟;测试可传 ``FakeClock``。
        log: 输出一行日志的函数。
        interface_ip_resolver: 把 ``ip: auto`` 的节点解析成真实 IP 的函数。
    """

    def __init__(
        self,
        scenario: Scenario,
        engine: SendEngine,
        nodes: NodeManager | None = None,
        *,
        clock: Clock | None = None,
        log: Callable[[str], None] = print,
        interface_ip_resolver: Callable[[], str] | None = None,
    ) -> None:
        if scenario.nodes and nodes is None:
            raise ValueError("场景含虚拟节点,必须提供 NodeManager")
        self.scenario = scenario
        self._engine = engine
        self._nodes = nodes
        self._clock: Clock = clock or RealClock()
        self._log = log
        self._resolve_ip = interface_ip_resolver
        self._pending = list(scenario.timeline)
        self._t0: float | None = None
        self.report = RunReport()
        self._active_nodes: list[str] = []
        self._node_ips: dict[str, str] = {}
        self._configs: dict[str, SourceConfig] = {}

    # ------------------------------------------------------------------ 准备与收尾
    def prepare(self) -> None:
        """创建节点并启动 ``autostart`` 的信号源,把时间零点定在这一刻。"""
        for config in self.scenario.nodes:
            if config.id in self.scenario.auto_ip_nodes and self._resolve_ip is not None:
                config = dataclasses.replace(config, ip=self._resolve_ip())
            assert self._nodes is not None
            _node, warnings = self._nodes.add_node(config)
            self._node_ips[config.id] = config.ip
            self._active_nodes.append(config.id)
            self._log(f"[节点] {config.id} 已启动于 {config.ip}")
            for text in warnings:
                self._log(f"[提示] {text}")
        for spec in self.scenario.sources:
            self._configs[spec.config.id] = self._resolve_target(spec.config)
        for spec in self.scenario.sources:
            if spec.autostart:
                self._engine.add_source(self._configs[spec.config.id])
                self._log(
                    f"[信号源] {spec.config.id} 已启动 ({spec.config.protocol}, "
                    f"{len(spec.config.universes)} 个 Universe)"
                )
        self._t0 = self._clock.now()

    def _resolve_target(self, config: SourceConfig) -> SourceConfig:
        """把 ``node:<id>`` 目标替换成该节点的实际 IP 与端口。"""
        if not config.target.startswith(NODE_TARGET_PREFIX):
            return config
        node_id = config.target[len(NODE_TARGET_PREFIX) :]
        ip = self._node_ips.get(node_id)
        if ip is None:
            raise LookupError(f"节点 {node_id} 没有启动,信号源 {config.id} 无法找到目标")
        port = config.port or (self._nodes.artnet_port if self._nodes else 0)
        return dataclasses.replace(config, target=ip, port=port)

    def teardown(self) -> None:
        """停止场景里创建的信号源与节点。sACN 信号源会发送 Stream_Terminated。"""
        for spec in self.scenario.sources:
            self._engine.remove_source(spec.config.id, terminate=True)
        if self._nodes is not None:
            for node_id in self._active_nodes:
                self._nodes.remove_node(node_id)
        self._active_nodes.clear()

    # ------------------------------------------------------------------ 执行事件
    def elapsed(self) -> float:
        """场景开始后经过的秒数;尚未 :meth:`prepare` 时为 0。"""
        return 0.0 if self._t0 is None else self._clock.now() - self._t0

    def advance(self) -> int:
        """执行所有已到期的事件。

        Returns:
            本次执行的事件数。
        """
        now = self.elapsed()
        count = 0
        while self._pending and self._pending[0].at <= now:
            event = self._pending.pop(0)
            self._apply(event, now)
            count += 1
        return count

    def _apply(self, event: TimelineEvent, actual: float) -> None:
        """执行一个事件并记录结果。"""
        description = describe_event(event)
        error: str | None = None
        try:
            self._dispatch(event)
        except (ValueError, LookupError, OSError) as exc:
            error = str(exc)
        self.report.applied.append(AppliedEvent(event.at, actual, description, error))
        suffix = f"  ✗ {error}" if error else ""
        self._log(f"[{actual:7.2f}s] {description}{suffix}")

    def _dispatch(self, event: TimelineEvent) -> None:
        """把事件落实到引擎或节点。"""
        action, target = event.action, event.target
        if action == "log":
            return
        if action in ("online", "offline"):
            node = self._nodes.get(target) if self._nodes and target else None
            if node is None:
                raise LookupError(f"节点 {target} 不存在")
            node.set_online(action == "online")
            return
        assert target is not None
        if action == "start":
            if self._engine.get(target) is not None:
                raise ValueError(f"信号源 {target} 已在运行")
            self._engine.add_source(self._configs[target])
            return
        source = self._engine.get(target)
        if action == "stop":
            if not self._engine.remove_source(target, terminate=event.terminate):
                raise LookupError(f"信号源 {target} 没有在运行")
            return
        if source is None:
            raise LookupError(f"信号源 {target} 没有在运行")
        if action == "pause":
            source.pause()
        elif action == "resume":
            source.resume()
        elif action == "freeze":
            source.frozen = True
        elif action == "unfreeze":
            source.frozen = False
        elif action == "set":
            source.update(event.values)

    # ------------------------------------------------------------------ 主循环
    def run(self, stop: threading.Event | None = None) -> RunReport:
        """完整运行场景:准备 → 按时间线执行 → 等到结束时刻 → 收尾。

        Args:
            stop: 外部停止信号;被置位时提前结束并正常收尾。

        Returns:
            运行结果。
        """
        stop = stop or threading.Event()
        self.prepare()
        end = self.scenario.end_time
        try:
            while not stop.is_set():
                self.advance()
                now = self.elapsed()
                if end is not None and now >= end and not self._pending:
                    break
                targets = []
                if self._pending:
                    targets.append(self._pending[0].at - now)
                if end is not None:
                    targets.append(end - now)
                wait = min(targets) if targets else _MAX_WAIT_S
                self._clock.sleep(max(0.0, min(wait, _MAX_WAIT_S)))
            self.report.stopped_early = stop.is_set()
        finally:
            self.report.elapsed = self.elapsed()
            self.teardown()
        return self.report


def describe_event(event: TimelineEvent) -> str:
    """生成事件的中文描述。

    Args:
        event: 时间线事件。

    Returns:
        一句话描述。
    """
    labels = {
        "start": "启动信号源",
        "stop": "停止信号源",
        "pause": "静默停发信号源",
        "resume": "恢复信号源",
        "freeze": "冻结信号源画面",
        "unfreeze": "解除冻结",
        "online": "节点上线",
        "offline": "节点离线",
    }
    if event.action == "log":
        return f"备注: {event.message}"
    label = labels.get(event.action, event.action)
    if event.action == "set":
        changes = ", ".join(f"{k}={v}" for k, v in event.values.items())
        return f"修改 {event.target}: {changes}"
    if event.action == "stop" and not event.terminate:
        return f"{label} {event.target}(不发送 Stream_Terminated)"
    return f"{label} {event.target}"
