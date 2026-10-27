"""Web 服务的核心状态:把发送引擎、抓包、虚拟节点、录制和场景组合在一起。

所有对象都是线程安全的,路由处理函数(同步 ``def``,在线程池里运行)可以直接调用这里的方法。
需要拒绝请求时抛 :class:`ApiError`,由应用统一转成 JSON 错误响应。
"""

from __future__ import annotations

import dataclasses
import itertools
import logging
import re
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from artnet_sim import __version__
from artnet_sim.capture.hub import Hub
from artnet_sim.capture.recorder import ArtRecRecorder, RecorderOptions, RecordReport
from artnet_sim.capture.service import CaptureService
from artnet_sim.generators import describe_generators
from artnet_sim.generators.artrec_player import source_config_from_artrec
from artnet_sim.net.interfaces import (
    NetInterface,
    default_interface,
    find_interface,
    list_interfaces,
)
from artnet_sim.node.config import NodeConfig
from artnet_sim.node.manager import NodeManager, auto_node_ip
from artnet_sim.protocol.artrec import ArtRecError, ArtRecReader, Compress
from artnet_sim.protocol.common import SACN_MAX_UNIVERSE, SACN_MIN_UNIVERSE
from artnet_sim.scenarios.runner import RunReport, ScenarioRunner
from artnet_sim.scenarios.schema import Scenario
from artnet_sim.sender.engine import SendEngine
from artnet_sim.sender.impairments import Impairments
from artnet_sim.sender.source import STATE_STOPPED, Source, SourceConfig
from artnet_sim.web.settings import WebSettings

logger = logging.getLogger(__name__)

#: 同时存在的信号源数量上限。
MAX_SOURCES = 64

#: 同时存在的虚拟节点数量上限。
MAX_NODES = 32

#: 录制文件名:不含路径分隔符和 Windows 保留字符,必须以 ``.artrec`` 结尾。
_RECORDING_NAME = re.compile(r'[^\\/:*?"<>|\x00-\x1f]{1,100}\.artrec')


class ApiError(Exception):
    """请求被拒绝或失败,携带 HTTP 状态码与中文说明。"""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class ScenarioSession:
    """后台运行的一个场景。

    Args:
        core: 应用核心。
        scenario: 已校验的场景。
    """

    def __init__(self, core: AppCore, scenario: Scenario) -> None:
        self.scenario = scenario
        self._core = core
        self._stop = threading.Event()
        self._log: deque[str] = deque(maxlen=200)
        self._thread: threading.Thread | None = None
        self._runner: ScenarioRunner | None = None
        self.report: RunReport | None = None
        self.error: str | None = None
        self.finished = False
        self.started_at = time.time()

    def start(self) -> None:
        """准备并在后台线程中开始运行场景。"""
        core = self._core
        manager = core.node_manager() if self.scenario.nodes else None
        iface = core.default_iface()
        self._runner = ScenarioRunner(
            self.scenario,
            core.engine,
            manager,
            log=self._log.append,
            interface_ip_resolver=lambda: auto_node_ip(core.settings.artnet_port, iface),
        )
        self._thread = threading.Thread(target=self._run, name="scenario", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        """线程主体。"""
        assert self._runner is not None
        try:
            self.report = self._runner.run(self._stop)
        except Exception as exc:
            logger.exception("场景运行失败")
            self.error = str(exc)
            self._runner.teardown()
        finally:
            self.finished = True

    def stop(self, timeout: float = 5.0) -> None:
        """请求停止并等待线程退出。"""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)

    @property
    def running(self) -> bool:
        """场景是否仍在运行。"""
        return self._thread is not None and self._thread.is_alive() and not self.finished

    def status(self) -> dict[str, Any]:
        """导出状态,供界面轮询。"""
        runner = self._runner
        applied = runner.report.applied if runner else []
        return {
            "name": self.scenario.name,
            "description": self.scenario.description,
            "running": self.running,
            "finished": self.finished,
            "elapsed": round(runner.elapsed(), 2) if runner else 0.0,
            "end_time": self.scenario.end_time,
            "events_total": len(self.scenario.timeline),
            "events_applied": len(applied),
            "errors": [
                {"at": e.at, "description": e.description, "error": e.error}
                for e in applied
                if e.error
            ],
            "error": self.error,
            "log": list(self._log)[-50:],
        }


class AppCore:
    """应用核心。

    Args:
        settings: Web 设置。
    """

    def __init__(self, settings: WebSettings) -> None:
        self.settings = settings
        self.started_at = time.time()
        self.hub = Hub()
        self.engine = SendEngine()
        self.capture: CaptureService | None = None
        self.capture_error: str | None = None
        self.capture_info: dict[str, Any] = {}
        self._nodes: NodeManager | None = None
        self.node_warnings: list[str] = []
        self.recorder: ArtRecRecorder | None = None
        self.last_recording: RecordReport | None = None
        self.recorder_target: str | None = None
        self.recording_started = 0.0
        self.recording_over_limit: list[int] = []
        self.scenario: ScenarioSession | None = None
        self._lock = threading.RLock()
        self._ids = itertools.count(1)

    # ------------------------------------------------------------------ 生命周期
    def start(self) -> None:
        """启动发送引擎,并按设置尽力开始抓包。"""
        self.settings.recordings_dir.mkdir(parents=True, exist_ok=True)
        self.engine.start()
        if self.settings.auto_capture:
            try:
                self.start_capture()
            except ApiError as exc:
                logger.warning("自动抓包未能启动: %s", exc.message)

    def stop(self) -> None:
        """按依赖顺序关闭全部组件。"""
        if self.scenario is not None:
            self.scenario.stop()
        if self.recorder is not None:
            self.last_recording = self.recorder.stop()
            self.recorder = None
        self.engine.stop()
        if self._nodes is not None:
            self._nodes.stop()
            self._nodes = None
        self.stop_capture()

    # ------------------------------------------------------------------ 网卡
    def default_iface(self) -> NetInterface | None:
        """默认出口网卡。"""
        return default_interface()

    def resolve_iface(self, spec: str | None) -> NetInterface | None:
        """按名称或 IP 查找网卡,未指定时用默认网卡。

        Raises:
            ApiError: 网卡不存在或名称不唯一。
        """
        try:
            return find_interface(spec) if spec else default_interface()
        except LookupError as exc:
            raise ApiError(400, str(exc)) from exc

    # ------------------------------------------------------------------ 抓包
    def start_capture(
        self,
        *,
        artnet: bool = True,
        sacn: bool = True,
        interface: str | None = None,
        universes: list[int] | None = None,
    ) -> dict[str, Any]:
        """(重新)开始抓包。

        Args:
            artnet: 是否监听 Art-Net。
            sacn: 是否监听 sACN。
            interface: 加入 sACN 组播所用的网卡。
            universes: 初始订阅的 sACN Universe。

        Returns:
            抓包状态。

        Raises:
            ApiError: 参数不合法或端口绑定失败。
        """
        if not artnet and not sacn:
            raise ApiError(400, "至少要启用 Art-Net 或 sACN 之一")
        wanted = sorted(set(universes or []))
        for u in wanted:
            if not SACN_MIN_UNIVERSE <= u <= SACN_MAX_UNIVERSE:
                raise ApiError(400, f"sACN Universe 必须在 {SACN_MIN_UNIVERSE}~{SACN_MAX_UNIVERSE}")
        iface = self.resolve_iface(interface)
        with self._lock:
            self.stop_capture()
            service = CaptureService(
                self.hub,
                artnet=artnet,
                sacn=sacn,
                artnet_port=self.settings.artnet_port,
                sacn_port=self.settings.sacn_port,
                interface_ips=[iface.ip] if iface else [],
                universes=wanted,
            )
            try:
                report = service.start()
            except OSError as exc:
                self.capture_error = f"绑定失败: {exc}"
                raise ApiError(409, self.capture_error) from exc
            self.capture = service
            self.capture_error = None
            self.capture_info = {
                "artnet": artnet,
                "sacn": sacn,
                "interface": iface.name if iface else None,
                "interface_ip": iface.ip if iface else None,
                "artnet_port_shared": report.artnet_port_shared,
                "sacn_port_shared": report.sacn_port_shared,
                "join_failures": list(report.sacn_join.failed),
            }
        return self.capture_status()

    def stop_capture(self) -> None:
        """停止抓包(包日志与统计保留)。"""
        with self._lock:
            if self.capture is not None:
                self.capture.stop()
                self.capture = None

    def set_sacn_universes(self, universes: list[int]) -> dict[str, Any]:
        """调整 sACN 组播订阅。

        Raises:
            ApiError: 抓包没有运行,或 Universe 不合法。
        """
        service = self.capture
        if service is None or not service.running:
            raise ApiError(409, "抓包没有运行")
        if service.sacn_receiver is None:
            raise ApiError(409, "抓包没有启用 sACN")
        for u in universes:
            if not SACN_MIN_UNIVERSE <= u <= SACN_MAX_UNIVERSE:
                raise ApiError(400, f"sACN Universe 必须在 {SACN_MIN_UNIVERSE}~{SACN_MAX_UNIVERSE}")
        report = service.set_sacn_universes(universes)
        self.capture_info["join_failures"] = list(report.failed)
        return self.capture_status()

    def capture_status(self) -> dict[str, Any]:
        """抓包状态。"""
        service = self.capture
        return {
            "running": bool(service and service.running),
            "error": self.capture_error,
            "sacn_universes": service.sacn_universes if service else [],
            **self.capture_info,
        }

    # ------------------------------------------------------------------ 信号源
    def current_pps(self, exclude: str | None = None) -> float:
        """当前所有运行中信号源的合计发包速率(包/秒)。"""
        total = 0.0
        for source in self.engine.sources():
            if source.state != STATE_STOPPED and source.config.id != exclude:
                total += source.config.rate * len(source.config.universes)
        return total

    def _check_pps(self, extra: float, exclude: str | None = None) -> None:
        """超过全局发包上限时拒绝。"""
        total = self.current_pps(exclude) + extra
        if total > self.settings.max_pps:
            raise ApiError(
                429,
                f"发包速率将达到 {total:.0f} 包/秒,超过上限 {self.settings.max_pps};"
                "可用 --max-pps 调高",
            )

    def next_source_id(self) -> str:
        """生成一个未被占用的信号源 id。"""
        while True:
            candidate = f"src-{next(self._ids)}"
            if self.engine.get(candidate) is None:
                return candidate

    def build_source_config(self, data: dict[str, Any]) -> SourceConfig:
        """把请求字典转成已校验的 :class:`SourceConfig`,应用安全策略。

        ``generator`` 为 ``artrec`` 时,``params.recording`` 是录制文件名(只能引用数据目录里的文件),
        省略 ``universes`` 则取文件里的 Universe。

        Raises:
            ApiError: 参数不合法或违反策略。
        """
        data = dict(data)
        params = dict(data.pop("params", {}) or {})
        try:
            impairments = Impairments.from_dict(dict(data.pop("impairments", {}) or {}))
            if "path" in params:
                raise ValueError("不能直接指定 path;回放录制文件请用 params.recording")
            if data.get("generator") == "artrec":
                recording = params.pop("recording", None)
                if not recording:
                    raise ValueError("artrec 生成器需要 params.recording(录制文件名)")
                path = self.recording_path(str(recording))
                if not path.is_file():
                    raise ApiError(404, f"录制文件不存在: {recording}")
                universes = data.pop("universes", None)
                config = source_config_from_artrec(
                    str(path),
                    source_id=data.pop("id", None) or self.next_source_id(),
                    protocol=data.pop("protocol", "artnet"),
                    universe_offset=int(params.pop("universe_offset", 0)),
                    generator_params=params,
                    impairments=impairments,
                    **{k: v for k, v in data.items() if k not in ("generator", "allow_public")},
                )
                if universes:
                    config.universes = list(universes)
            else:
                config = SourceConfig(
                    id=data.pop("id", None) or self.next_source_id(),
                    generator_params=params,
                    impairments=impairments,
                    **{k: v for k, v in data.items() if k != "allow_public"},
                )
            config.allow_public = self.settings.allow_public
            config.validate()
        except ApiError:
            raise
        except (ValueError, TypeError, ArtRecError) as exc:
            raise ApiError(400, str(exc)) from exc
        return config

    def add_source(self, data: dict[str, Any]) -> Source:
        """创建并启动信号源。

        Raises:
            ApiError: 参数不合法、数量或速率超限、id 冲突、目标被策略拒绝。
        """
        if len(self.engine.sources()) >= MAX_SOURCES:
            raise ApiError(409, f"信号源数量已达上限 {MAX_SOURCES}")
        config = self.build_source_config(data)
        self._check_pps(config.rate * len(config.universes))
        return self._engine_add(config)

    def _engine_add(self, config: SourceConfig) -> Source:
        """把配置交给引擎,并把错误翻译成 API 错误。"""
        try:
            return self.engine.add_source(config)
        except ValueError as exc:
            status = 409 if "已存在" in str(exc) else 400
            raise ApiError(status, str(exc)) from exc
        except LookupError as exc:
            raise ApiError(400, str(exc)) from exc
        except OSError as exc:
            raise ApiError(500, f"网络错误: {exc}") from exc

    def get_source(self, source_id: str) -> Source:
        """按 id 取信号源。

        Raises:
            ApiError: 不存在。
        """
        source = self.engine.get(source_id)
        if source is None:
            raise ApiError(404, f"信号源不存在: {source_id}")
        return source

    def update_source(self, source_id: str, changes: dict[str, Any]) -> Source:
        """运行中修改信号源参数。

        Raises:
            ApiError: 不存在、参数不合法或速率超限。
        """
        source = self.get_source(source_id)
        gen_params = changes.get("generator_params")
        if changes.get("generator") == "artrec" or (
            isinstance(gen_params, dict) and "path" in gen_params
        ):
            raise ApiError(400, "不能在运行中切换到文件回放,请重新创建信号源")
        if "rate" in changes and isinstance(changes["rate"], int | float):
            self._check_pps(float(changes["rate"]) * len(source.config.universes), source_id)
        try:
            source.update(changes)
        except (ValueError, TypeError) as exc:
            raise ApiError(400, str(exc)) from exc
        return source

    def source_action(self, source_id: str, action: str, terminate: bool = True) -> dict[str, Any]:
        """对信号源执行动作:pause / resume / freeze / unfreeze / stop。

        Raises:
            ApiError: 不存在或动作未知。
        """
        source = self.get_source(source_id)
        if action == "pause":
            source.pause()
        elif action == "resume":
            source.resume()
        elif action == "freeze":
            source.frozen = True
        elif action == "unfreeze":
            source.frozen = False
        elif action == "stop":
            self.engine.remove_source(source_id, terminate=terminate)
            return {"id": source_id, "state": STATE_STOPPED}
        else:
            raise ApiError(400, f"未知动作: {action}")
        return source.status()

    # ------------------------------------------------------------------ 虚拟节点
    def node_manager(self) -> NodeManager:
        """取得(必要时创建并启动)节点管理器。

        Raises:
            ApiError: 端口绑定失败。
        """
        with self._lock:
            if self._nodes is None:
                manager = NodeManager(
                    interface=self.default_iface(),
                    artnet_port=self.settings.artnet_port,
                    sacn_port=self.settings.sacn_port,
                )
                try:
                    started = manager.start()
                except OSError as exc:
                    raise ApiError(409, f"虚拟节点无法启动: {exc}") from exc
                self.node_warnings = list(started.warnings)
                self._nodes = manager
            return self._nodes

    def nodes_snapshot(self) -> dict[str, Any]:
        """节点状态快照;管理器还没创建时为空。"""
        if self._nodes is None:
            return {"nodes": [], "sacn_universes": [], "warnings": [], "reply_errors": 0}
        return self._nodes.snapshot()

    def add_node(self, data: dict[str, Any]) -> dict[str, Any]:
        """创建虚拟节点。``ip`` 写 ``auto`` 时自动选择。

        Raises:
            ApiError: 参数不合法、数量超限、id 冲突或绑定失败。
        """
        payload = dict(data)
        if not payload.get("id"):
            payload["id"] = f"node-{next(self._ids)}"
        try:
            if payload.get("ip", "auto") == "auto":
                payload["ip"] = auto_node_ip(self.settings.artnet_port, self.default_iface())
            config = NodeConfig.from_dict(payload)
        except ValueError as exc:
            raise ApiError(400, str(exc)) from exc
        manager = self.node_manager()
        if len(manager.nodes()) >= MAX_NODES:
            raise ApiError(409, f"虚拟节点数量已达上限 {MAX_NODES}")
        try:
            node, warnings = manager.add_node(config)
        except ValueError as exc:
            status = 409 if "已存在" in str(exc) else 400
            raise ApiError(status, str(exc)) from exc
        except OSError as exc:
            raise ApiError(409, str(exc)) from exc
        snapshot = node.snapshot(time.perf_counter_ns())
        snapshot["warnings"] = warnings
        return snapshot

    def get_node(self, node_id: str) -> Any:
        """按 id 取节点。

        Raises:
            ApiError: 不存在。
        """
        node = self._nodes.get(node_id) if self._nodes else None
        if node is None:
            raise ApiError(404, f"节点不存在: {node_id}")
        return node

    def remove_node(self, node_id: str) -> None:
        """移除节点。

        Raises:
            ApiError: 不存在。
        """
        if self._nodes is None or not self._nodes.remove_node(node_id):
            raise ApiError(404, f"节点不存在: {node_id}")

    # ------------------------------------------------------------------ 录制文件
    def recording_path(self, name: str) -> Path:
        """把录制文件名解析成数据目录里的路径,拒绝任何路径穿越。

        Raises:
            ApiError: 文件名不合法。
        """
        if not _RECORDING_NAME.fullmatch(name) or name.startswith(".") or ".." in name:
            raise ApiError(400, f"录制文件名不合法: {name!r}")
        return self.settings.recordings_dir / name

    def list_recordings(self) -> list[dict[str, Any]]:
        """列出数据目录里的录制文件及其概况。"""
        items = []
        folder = self.settings.recordings_dir
        if not folder.is_dir():
            return items
        for path in sorted(folder.glob("*.artrec"), key=lambda p: p.stat().st_mtime, reverse=True):
            item: dict[str, Any] = {
                "name": path.name,
                "size": path.stat().st_size,
                "modified": path.stat().st_mtime,
            }
            try:
                info = self.recording_info(path.name)
            except ApiError as exc:
                item["error"] = exc.message
            else:
                item.update({k: info[k] for k in ("duration_s", "frames", "universes")})
            items.append(item)
        return items

    def recording_info(self, name: str) -> dict[str, Any]:
        """读取一个录制文件的概况。

        Raises:
            ApiError: 不存在或文件损坏。
        """
        path = self.recording_path(name)
        if not path.is_file():
            raise ApiError(404, f"录制文件不存在: {name}")
        try:
            reader = ArtRecReader.open(str(path))
        except (ArtRecError, OSError) as exc:
            raise ApiError(422, f"无法读取 {name}: {exc}") from exc
        h = reader.header
        return {
            "name": name,
            "size": path.stat().st_size,
            "duration_s": round(h.total_duration_us / 1e6, 3),
            "frames": len(reader.index),
            "universes": reader.universes,
            "compress": h.compress_algo.name,
            "level": h.compress_level,
            "allows_diff": h.allows_diff,
            "loop": h.loop_play,
            "version": f"{h.ver_major}.{h.ver_minor}",
        }

    def delete_recording(self, name: str) -> None:
        """删除录制文件。

        Raises:
            ApiError: 不存在,或文件正被录制/回放使用。
        """
        path = self.recording_path(name)
        if not path.is_file():
            raise ApiError(404, f"录制文件不存在: {name}")
        if self.recorder is not None and Path(self.recorder_target or "") == path:
            raise ApiError(409, "该文件正在录制")
        path.unlink()

    # ------------------------------------------------------------------ 录制
    def start_recording(self, data: dict[str, Any]) -> dict[str, Any]:
        """开始录制。

        Raises:
            ApiError: 抓包没有运行、已在录制、参数不合法。
        """
        with self._lock:
            if self.recorder is not None:
                raise ApiError(409, "已经在录制")
            service = self.capture
            if service is None or not service.running:
                raise ApiError(409, "请先启动抓包")
            protocols = frozenset(data.get("protocols") or ["artnet", "sacn"])
            if not protocols <= {"artnet", "sacn"}:
                raise ApiError(400, "protocols 只能是 artnet / sacn")
            name = data.get("name") or time.strftime("rec-%Y%m%d-%H%M%S.artrec")
            if not str(name).endswith(".artrec"):
                name = f"{name}.artrec"
            path = self.recording_path(str(name))
            if path.exists():
                raise ApiError(409, f"文件已存在: {name}")
            universes = data.get("universes")
            if not universes:
                universes = sorted(
                    {
                        s["universe"]
                        for s in self.hub.snapshot()["streams"]
                        if s["protocol"] in protocols and s["active"]
                    }
                )
            if not universes:
                raise ApiError(400, "没有检测到活跃的信号,请指定 universes")
            level = int(data.get("level", 3))
            if not 1 <= level <= 22:
                raise ApiError(400, "level 必须在 1~22")
            try:
                options = RecorderOptions(
                    universes=[int(u) for u in universes],
                    protocols=protocols,
                    src_ips=frozenset(data["src_ips"]) if data.get("src_ips") else None,
                    compress=Compress.NONE if data.get("no_compress") else Compress.ZSTD,
                    level=level,
                    use_diff=bool(data.get("diff", False)),
                    coalesce_ms=float(data.get("coalesce_ms", 5.0)),
                )
                recorder = ArtRecRecorder(self.hub, path, options)
                recorder.start()
            except (ArtRecError, ValueError, TypeError) as exc:
                raise ApiError(400, str(exc)) from exc
            except OSError as exc:
                raise ApiError(500, f"无法创建录制文件: {exc}") from exc
            self.recorder = recorder
            self.recorder_target = str(path)
            self.recording_started = time.time()
            self.recording_over_limit = [
                u for u in universes if u not in recorder.recordable_universes
            ]
        return self.recording_status()

    def stop_recording(self) -> dict[str, Any]:
        """停止录制。

        Raises:
            ApiError: 当前没有在录制。
        """
        with self._lock:
            recorder = self.recorder
            if recorder is None:
                raise ApiError(409, "当前没有在录制")
            report = recorder.stop()
            self.recorder = None
            self.recorder_target = None
            self.last_recording = report
        return self.recording_status()

    def recording_status(self) -> dict[str, Any]:
        """录制状态与最近一次的结果。"""
        recorder = self.recorder
        last = self.last_recording
        return {
            "recording": recorder is not None,
            "frames": recorder.frames if recorder else 0,
            "elapsed_s": round(time.time() - self.recording_started, 1) if recorder else 0.0,
            "file": Path(self.recorder_target).name if recorder and self.recorder_target else None,
            "universes": recorder.recordable_universes if recorder else [],
            "over_limit": list(self.recording_over_limit) if recorder else [],
            "error": recorder.error if recorder else None,
            "last": dataclasses.asdict(last) if last else None,
        }

    # ------------------------------------------------------------------ 场景
    def start_scenario(self, scenario: Scenario) -> dict[str, Any]:
        """后台运行场景。

        Raises:
            ApiError: 已有场景在运行、id 冲突或速率超限。
        """
        with self._lock:
            if self.scenario is not None and self.scenario.running:
                raise ApiError(409, "已有场景在运行,请先停止")
            clash = [s.config.id for s in scenario.sources if self.engine.get(s.config.id)]
            if self._nodes is not None:
                clash += [n.id for n in scenario.nodes if self._nodes.get(n.id)]
            if clash:
                raise ApiError(409, f"场景里的 id 与现有对象冲突: {', '.join(clash)}")
            for spec in scenario.sources:
                spec.config.allow_public = spec.config.allow_public and self.settings.allow_public
            peak = sum(
                s.config.rate * len(s.config.universes) for s in scenario.sources if s.autostart
            )
            self._check_pps(peak)
            session = ScenarioSession(self, scenario)
            try:
                session.start()
            except ApiError:
                raise
            except (ValueError, OSError) as exc:
                raise ApiError(400, str(exc)) from exc
            self.scenario = session
        return session.status()

    def stop_scenario(self) -> dict[str, Any]:
        """停止正在运行的场景。

        Raises:
            ApiError: 没有场景。
        """
        session = self.scenario
        if session is None:
            raise ApiError(409, "没有正在运行的场景")
        session.stop()
        return session.status()

    def scenario_status(self) -> dict[str, Any]:
        """场景状态;从未运行过时 ``name`` 为 ``None``。"""
        if self.scenario is None:
            return {"name": None, "running": False, "finished": False}
        return self.scenario.status()

    # ------------------------------------------------------------------ 汇总
    def state(self) -> dict[str, Any]:
        """整体状态快照(``/api/state`` 与 WebSocket 统计推送共用)。"""
        sched = self.engine.scheduler.stats()
        return {
            "version": __version__,
            "uptime_s": round(time.time() - self.started_at, 1),
            "settings": {
                "lan": self.settings.lan,
                "auth_required": self.settings.auth_required,
                "max_pps": self.settings.max_pps,
                "allow_public": self.settings.allow_public,
                "current_pps": round(self.current_pps(), 1),
            },
            "capture": self.capture_status(),
            "sources": [s.status() for s in self.engine.sources()],
            "nodes": self.nodes_snapshot(),
            "recording": self.recording_status(),
            "scenario": self.scenario_status(),
            "scheduler": {
                "fired": sched.fired,
                "skipped": sched.skipped,
                "late_p50_ms": round(sched.late_p50 * 1e3, 3),
                "late_p99_ms": round(sched.late_p99 * 1e3, 3),
                "late_max_ms": round(sched.late_max * 1e3, 3),
            },
        }

    def meta(self) -> dict[str, Any]:
        """静态元数据:网卡与生成器说明。"""
        chosen = default_interface()
        return {
            "interfaces": [
                {
                    "name": i.name,
                    "ip": i.ip,
                    "netmask": i.netmask,
                    "broadcast": i.broadcast,
                    "usable": i.usable,
                    "virtual": i.is_virtual,
                    "loopback": i.is_loopback,
                    "default": chosen is not None and i.ip == chosen.ip,
                }
                for i in list_interfaces()
            ],
            "generators": describe_generators(),
        }
