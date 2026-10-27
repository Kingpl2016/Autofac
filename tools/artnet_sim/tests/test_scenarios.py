import threading
import time

import pytest

from artnet_sim.cli import main
from artnet_sim.commands.scenario import builtin_scenarios, load_by_name_or_path
from artnet_sim.net.clock import FakeClock
from artnet_sim.net.scheduler import Scheduler
from artnet_sim.protocol import artnet, sacn
from artnet_sim.scenarios import ScenarioError, load_scenario_text
from artnet_sim.scenarios.runner import ScenarioRunner, describe_event
from artnet_sim.sender.engine import SendEngine

BASIC = """
name: 测试场景
duration: 10
sources:
  - id: a
    protocol: sacn
    universes: 1-3
    generator: rainbow
    params: {speed: 0.5}
    priority: 90
    target: 127.0.0.1
  - id: b
    universes: [0, 5]
    autostart: false
    target: 127.0.0.1
nodes:
  - id: n
    ip: auto
    ports: [{direction: output, address: 4}]
timeline:
  - {at: 2, action: set, target: a, values: {priority: 150}}
  - {at: 1, action: start, target: b}
  - {at: 3, action: offline, target: n}
  - {at: 3, action: stop, target: a, terminate: false}
  - {at: 4, action: log, message: 备注}
"""


def test_all_builtin_scenarios_are_valid():
    scenarios = builtin_scenarios()
    assert set(scenarios) >= {
        "multi_source_conflict",
        "artnet_merge_node",
        "priority_switch",
        "network_impairments",
        "source_dropout",
        "node_flapping",
        "strobe_burst",
        "seq_wraparound",
    }
    for name in scenarios:
        scenario = load_by_name_or_path(name)
        assert scenario.name and (scenario.sources or scenario.nodes)
        assert scenario.timeline == sorted(scenario.timeline, key=lambda e: e.at)
        assert load_by_name_or_path(f"{name}.yaml").name == scenario.name


def test_parse_basic_scenario():
    sc = load_scenario_text(BASIC)
    assert sc.name == "测试场景" and sc.duration == 10
    a, b = (s.config for s in sc.sources)
    assert (a.protocol, a.universes, a.priority, a.generator_params) == (
        "sacn",
        [1, 2, 3],
        90,
        {"speed": 0.5},
    )
    assert (b.protocol, b.universes, sc.sources[1].autostart) == ("artnet", [0, 5], False)
    assert sc.auto_ip_nodes == {"n"} and sc.nodes[0].ip == "127.0.0.2"
    # 事件按时间稳定排序(同一时刻保持书写顺序)
    assert [(e.at, e.action) for e in sc.timeline] == [
        (1.0, "start"),
        (2.0, "set"),
        (3.0, "offline"),
        (3.0, "stop"),
        (4.0, "log"),
    ]
    assert sc.timeline[3].terminate is False
    assert "2 个信号源" in sc.summary()


def test_sacn_cid_is_stable_per_scenario_and_source():
    first = load_scenario_text(BASIC).sources[0].config.cid
    again = load_scenario_text(BASIC).sources[0].config.cid
    other = load_scenario_text(BASIC.replace("测试场景", "另一个场景")).sources[0].config.cid
    assert first == again and first != other and len(bytes.fromhex(first)) == 16


def test_every_expands_repeating_events():
    text = """
name: x
duration: 20
sources: [{id: s, target: 127.0.0.1}]
timeline:
  - {at: 2, action: pause, target: s, every: 5, until: 15}
  - {at: 4, action: resume, target: s, every: 5}
"""
    sc = load_scenario_text(text)
    pauses = [e.at for e in sc.timeline if e.action == "pause"]
    resumes = [e.at for e in sc.timeline if e.action == "resume"]
    assert pauses == [2, 7, 12]
    assert resumes == [4, 9, 14, 19]  # 没写 until 时用场景 duration


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("- 1", "顶层必须是键值对象"),
        ("name: x\nbogus: 1\nsources: [{id: s}]", "未知字段"),
        ("sources: [{id: s}]", "name"),
        ("name: x", "至少要有一个信号源或节点"),
        ("name: x\nduration: 0\nsources: [{id: s}]", "duration"),
        ("name: x\nsources: [{id: s, rate: 0}]", "sources[0](s)"),
        ("name: x\nsources: [{id: s, generator: nope}]", "未知生成器"),
        ("name: x\nsources: [{id: s, params: {bogus: 1}}]", "不支持参数"),
        ("name: x\nsources: [{id: s, universes: '1-'}]", "universes"),
        ("name: x\nsources: [{id: s, protocol: sacn, universes: 0}]", "超出允许范围"),
        ("name: x\nsources: [{id: s, impairments: {loss: 5}}]", "loss"),
        ("name: x\nsources: [{id: s, rate: fast}]", "必须是数字"),
        ("name: x\nsources: [{id: s}, {id: s}]", "重复"),
        ("name: x\nsources: [{}]", "缺少 id"),
        ("name: x\nsources: [{id: s, autostart: maybe}]", "autostart"),
        ("name: x\nsources: [{id: s, target: node:ghost}]", "节点 'ghost' 不存在"),
        ("name: x\nnodes: [{id: n, ip: 1.2.3.999}]", "ip"),
        ("name: x\nnodes: [{id: n}, {id: n}]", "重复"),
        ("name: x\nsources: [{id: s}]\ntimeline: [{at: 1}]", "必须包含 at 和 action"),
        (
            "name: x\nsources: [{id: s}]\ntimeline: [{at: -1, action: log, message: m}]",
            "timeline[0].at",
        ),
        ("name: x\nsources: [{id: s}]\ntimeline: [{at: 1, action: dance, target: s}]", "未知动作"),
        (
            "name: x\nsources: [{id: s}]\ntimeline: [{at: 1, action: stop, target: z}]",
            "信号源 'z' 不存在",
        ),
        (
            "name: x\nsources: [{id: s}]\ntimeline: [{at: 1, action: offline, target: s}]",
            "节点 's' 不存在",
        ),
        (
            "name: x\nsources: [{id: s}]\ntimeline: [{at: 1, action: set, target: s}]",
            "必须提供要修改的字段",
        ),
        (
            "name: x\nsources: [{id: s}]\ntimeline: [{at: 1, action: set, target: s, values: {universes: [2]}}]",
            "不支持运行中修改",
        ),
        (
            "name: x\nsources: [{id: s}]\ntimeline: [{at: 1, action: set, target: s, values: {rate: 0}}]",
            "rate",
        ),
        ("name: x\nsources: [{id: s}]\ntimeline: [{at: 1, action: log}]", "message"),
        (
            "name: x\nsources: [{id: s}]\ntimeline: [{at: 1, action: log, message: m, every: 1}]",
            "until",
        ),
        (
            "name: x\nsources: [{id: s}]\ntimeline: [{at: 1, action: log, message: m, until: 5}]",
            "every",
        ),
        (
            "name: x\nduration: 5\nsources: [{id: s}]\ntimeline: [{at: 6, action: log, message: m}]",
            "超过了 duration",
        ),
        (
            "name: x\nsources: [{id: s}]\ntimeline: [{at: 0, action: log, message: m, every: 0.0001, until: 100}]",
            "过多",
        ),
        ("name: [unclosed", "YAML 语法错误"),
    ],
)
def test_validation_errors_are_specific(text, message):
    with pytest.raises(ScenarioError) as info:
        load_scenario_text(text, origin="t.yaml")
    assert message in str(info.value)
    assert str(info.value).startswith("t.yaml")


def test_describe_event():
    sc = load_scenario_text(BASIC)
    texts = [describe_event(e) for e in sc.timeline]
    assert texts[0] == "启动信号源 b"
    assert "priority=150" in texts[1]
    assert texts[2] == "节点离线 n"
    assert "不发送 Stream_Terminated" in texts[3]
    assert texts[4] == "备注: 备注"


# ---------------------------------------------------------------------------
# 运行器(假时钟 + 假引擎,完全确定性)
# ---------------------------------------------------------------------------


class FakeNodes:
    def __init__(self):
        self.added = []
        self.removed = []
        self.online = {}
        self.artnet_port = 6454

    def add_node(self, config):
        self.added.append(config)
        self.online[config.id] = True
        return None, []

    def remove_node(self, node_id):
        self.removed.append(node_id)

    def get(self, node_id):
        outer = self

        class Handle:
            def set_online(self, value):
                outer.online[node_id] = value

        return Handle() if node_id in self.online else None


def make_runner(text, clock=None, nodes=None):
    clock = clock or FakeClock()
    engine = SendEngine(Scheduler(clock, boost_priority=False), resolver=lambda spec: None)
    # 引擎的发送 socket 指向回环,不会真的发出去:目标是 127.0.0.1:6454
    logs: list[str] = []
    runner = ScenarioRunner(
        load_scenario_text(text),
        engine,
        nodes,
        clock=clock,
        log=logs.append,
        interface_ip_resolver=lambda: "127.0.0.9",
    )
    return runner, engine, clock, logs


def test_runner_applies_events_in_order_with_fake_clock():
    nodes = FakeNodes()
    runner, engine, clock, logs = make_runner(BASIC, nodes=nodes)
    try:
        runner.prepare()
        assert [c.ip for c in nodes.added] == ["127.0.0.9"]  # auto → 解析器给的 IP
        assert engine.get("a") is not None and engine.get("b") is None
        clock.advance(1.0)
        assert runner.advance() == 1 and engine.get("b") is not None
        clock.advance(1.0)
        runner.advance()
        assert engine.get("a").config.priority == 150
        clock.advance(1.0)
        runner.advance()
        assert nodes.online["n"] is False
        assert engine.get("a") is None  # stop 已执行
        clock.advance(1.0)
        runner.advance()
        assert runner.report.errors == []
        assert [e.description for e in runner.report.applied][-1] == "备注: 备注"
        assert any("启动信号源 b" in line for line in logs)
    finally:
        runner.teardown()
        engine.stop()
    assert nodes.removed == ["n"]
    assert engine.sources() == []


def test_runner_run_finishes_at_duration_using_fake_clock():
    runner, engine, clock, _ = make_runner(BASIC, nodes=FakeNodes())
    try:
        report = runner.run()
    finally:
        engine.stop()
    assert clock.now() >= 10.0  # 假时钟被 sleep 推到了结束时刻
    assert len(report.applied) == 5 and not report.stopped_early
    assert report.elapsed >= 10.0


def test_runner_stop_event_ends_early_and_cleans_up():
    clock = FakeClock()
    runner, engine, _, _ = make_runner(BASIC, clock=clock, nodes=FakeNodes())
    stop = threading.Event()
    stop.set()
    try:
        report = runner.run(stop)
    finally:
        engine.stop()
    assert report.stopped_early and engine.sources() == []


def test_runner_records_event_errors_without_aborting():
    text = """
name: e
duration: 5
sources: [{id: s, target: 127.0.0.1}]
timeline:
  - {at: 1, action: start, target: s}
  - {at: 2, action: stop, target: s}
  - {at: 3, action: stop, target: s}
  - {at: 3.5, action: pause, target: s}
  - {at: 4, action: log, message: still-running}
"""
    runner, engine, clock, logs = make_runner(text)
    try:
        report = runner.run()
    finally:
        engine.stop()
    errors = {round(e.at, 1): e.error for e in report.errors}
    assert set(errors) == {1.0, 3.0, 3.5}
    assert "已在运行" in errors[1.0] and "没有在运行" in errors[3.0]
    assert report.applied[-1].description == "备注: still-running"
    assert any("✗" in line for line in logs)


def test_runner_requires_node_manager_when_scenario_has_nodes():
    with pytest.raises(ValueError, match="NodeManager"):
        ScenarioRunner(load_scenario_text(BASIC), SendEngine(), None)


def test_node_target_is_replaced_with_node_ip_and_port():
    text = """
name: t
duration: 1
nodes: [{id: n1, ip: 127.0.0.2, ports: [{direction: output, address: 0}]}]
sources: [{id: s, universes: 0, target: 'node:n1'}]
"""
    nodes = FakeNodes()
    nodes.artnet_port = 7777
    runner, engine, _, _ = make_runner(text, nodes=nodes)
    try:
        runner.prepare()
        source = engine.get("s")
        assert source._dest[0] == ("127.0.0.2", 7777)
    finally:
        runner.teardown()
        engine.stop()


def test_runner_real_time_with_sacn_termination():
    """用真实时钟和回环 socket 跑一个很短的场景,检查 stop 会发出 Stream_Terminated。"""
    import socket

    from artnet_sim.net.sockets import create_recv_socket

    rx = create_recv_socket(0, "127.0.0.1", timeout=0.1)
    port = rx.getsockname()[1]
    received: list[bytes] = []
    done = threading.Event()

    def pump():
        while not done.is_set():
            try:
                received.append(rx.recvfrom(2048)[0])
            except (TimeoutError, ConnectionResetError, OSError):
                continue

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()
    text = f"""
name: live
duration: 0.8
sources:
  - id: s
    protocol: sacn
    universes: 7
    rate: 50
    channels: 8
    target: 127.0.0.1
    port: {port}
timeline:
  - {{at: 0.4, action: set, target: s, values: {{priority: 160}}}}
"""
    engine = SendEngine(Scheduler(boost_priority=False), resolver=lambda spec: None)
    engine.start()
    runner = ScenarioRunner(load_scenario_text(text), engine, log=lambda _s: None)
    try:
        started = time.perf_counter()
        report = runner.run()
        assert time.perf_counter() - started >= 0.75
    finally:
        engine.stop()
        time.sleep(0.2)
        done.set()
        thread.join(1)
        rx.close()
        socket.setdefaulttimeout(None)
    parsed = [sacn.parse_data(p) for p in received]
    assert {p.priority for p in parsed} == {100, 160}
    assert sum(p.terminated for p in parsed) == 3
    assert not report.errors


def test_cli_scenario_list_validate_and_dry_run(capsys):
    assert main(["scenario", "list"]) == 0
    out = capsys.readouterr().out
    assert "multi_source_conflict" in out and "(无效)" not in out
    assert main(["scenario", "validate", "priority_switch", "node_flapping"]) == 0
    assert capsys.readouterr().out.count("✓") == 2
    assert main(["scenario", "validate", "no_such_scenario"]) == 2
    assert "找不到场景" in capsys.readouterr().err
    assert main(["scenario", "run", "priority_switch", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "启动信号源 overlay" in out and "10.00s" in out


def test_cli_scenario_run_rejects_bad_arguments(capsys):
    assert main(["scenario", "run", "priority_switch", "--duration", "0", "--dry-run"]) == 2
    assert main(["scenario", "run", "priority_switch", "--interface", "nonexistent-nic"]) == 2


def test_cli_scenario_run_real_short(capsys, tmp_path):
    path = tmp_path / "s.yaml"
    path.write_text(
        "name: 短场景\nduration: 0.6\nsources:\n  - {id: s, universes: 1, rate: 50, target: 127.0.0.1, "
        "port: 46888}\ntimeline:\n  - {at: 0.3, action: log, message: 中间点}\n",
        encoding="utf-8",
    )
    assert main(["scenario", "run", str(path)]) == 0
    out = capsys.readouterr().out
    assert "备注: 中间点" in out and "场景结束" in out


def test_artnet_source_sends_through_runner_with_physical_field():
    text = """
name: p
duration: 0.5
sources: [{id: s, universes: 3, physical: 7, rate: 50, target: 127.0.0.1, port: 46777}]
"""
    runner, engine, clock, _ = make_runner(text)
    try:
        runner.prepare()
        source = engine.get("s")
        source.fire(0.0)
        packet = source._template(3)
        assert artnet.parse_dmx(bytes(packet)).physical == 7
    finally:
        runner.teardown()
        engine.stop()
