"""FastAPI 应用:REST 接口、登录、静态页面。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, FastAPI, File, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from artnet_sim import __version__
from artnet_sim.capture.packet_log import PacketFilter
from artnet_sim.commands.scenario import builtin_scenarios
from artnet_sim.protocol.artrec import ArtRecError, ArtRecReader
from artnet_sim.protocol.decode import decode, summarize
from artnet_sim.scenarios.runner import describe_event
from artnet_sim.scenarios.schema import Scenario, ScenarioError, load_scenario_text
from artnet_sim.web import ws
from artnet_sim.web.models import (
    ActionIn,
    CaptureStartIn,
    LogPauseIn,
    OnlineIn,
    RecordStartIn,
    ScenarioRunIn,
    ScenarioValidateIn,
    SourceIn,
    SourcePatch,
    UniversesIn,
)
from artnet_sim.web.security import (
    COOKIE_NAME,
    FailureLimiter,
    SecurityMiddleware,
    token_matches,
)
from artnet_sim.web.settings import WebSettings
from artnet_sim.web.state import ApiError, AppCore

STATIC_DIR = Path(__file__).parent / "static"

#: 上传时每次读取的块大小。
_UPLOAD_CHUNK = 1024 * 1024


def _core(request: Request) -> AppCore:
    """取出应用核心。"""
    core: AppCore = request.app.state.core
    return core


def _source_dict(core: AppCore, source_id: str) -> dict[str, Any]:
    """信号源的完整描述:状态 + 配置。"""
    source = core.get_source(source_id)
    cfg = source.config
    return {
        **source.status(),
        "config": {
            "protocol": cfg.protocol,
            "universes": cfg.universes,
            "generator": cfg.generator,
            "params": cfg.generator_params,
            "rate": cfg.rate,
            "priority": cfg.priority,
            "channels": cfg.channels,
            "target": cfg.target,
            "port": cfg.port,
            "interface": cfg.interface,
            "source_name": cfg.source_name,
            "physical": cfg.physical,
            "impairments": cfg.impairments.to_dict(),
        },
    }


# ---------------------------------------------------------------------- 路由
def build_router() -> APIRouter:
    """构造全部 ``/api`` 路由。所有处理函数是同步的,由 FastAPI 放到线程池里执行。"""
    router = APIRouter(prefix="/api")

    @router.get("/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @router.get("/state")
    def state(request: Request) -> dict[str, Any]:
        return _core(request).state()

    @router.get("/meta")
    def meta(request: Request) -> dict[str, Any]:
        return _core(request).meta()

    # ---- 信号源
    @router.get("/sources")
    def list_sources(request: Request) -> list[dict[str, Any]]:
        core = _core(request)
        return [_source_dict(core, s.config.id) for s in core.engine.sources()]

    @router.post("/sources", status_code=201)
    def create_source(body: SourceIn, request: Request) -> dict[str, Any]:
        core = _core(request)
        data = body.model_dump(exclude_none=True)
        source = core.add_source(data)
        return _source_dict(core, source.config.id)

    @router.get("/sources/{source_id}")
    def get_source(source_id: str, request: Request) -> dict[str, Any]:
        return _source_dict(_core(request), source_id)

    @router.patch("/sources/{source_id}")
    def patch_source(source_id: str, body: SourcePatch, request: Request) -> dict[str, Any]:
        core = _core(request)
        changes = body.changes()
        if not changes:
            raise ApiError(400, "没有要修改的字段")
        core.update_source(source_id, changes)
        return _source_dict(core, source_id)

    @router.post("/sources/{source_id}/action")
    def source_action(source_id: str, body: ActionIn, request: Request) -> dict[str, Any]:
        return _core(request).source_action(source_id, body.action, body.terminate)

    @router.delete("/sources/{source_id}", status_code=204)
    def delete_source(source_id: str, request: Request, terminate: bool = True) -> Response:
        core = _core(request)
        core.get_source(source_id)
        core.engine.remove_source(source_id, terminate=terminate)
        return Response(status_code=204)

    # ---- 虚拟节点
    @router.get("/nodes")
    def list_nodes(request: Request) -> dict[str, Any]:
        return _core(request).nodes_snapshot()

    @router.post("/nodes", status_code=201)
    def create_node(body: dict[str, Any], request: Request) -> dict[str, Any]:
        return _core(request).add_node(body)

    @router.delete("/nodes/{node_id}", status_code=204)
    def delete_node(node_id: str, request: Request) -> Response:
        _core(request).remove_node(node_id)
        return Response(status_code=204)

    @router.post("/nodes/{node_id}/online")
    def node_online(node_id: str, body: OnlineIn, request: Request) -> dict[str, Any]:
        node = _core(request).get_node(node_id)
        node.set_online(body.online)
        return {"id": node_id, "online": node.online}

    @router.get("/nodes/{node_id}/ports/{index}/data")
    def node_port_data(node_id: str, index: int, request: Request) -> dict[str, Any]:
        node = _core(request).get_node(node_id)
        if not any(p.index == index for p in node.ports):
            raise ApiError(404, f"端口不存在: {index}")
        return {"id": node_id, "index": index, "data": list(node.port_output(index))}

    # ---- 抓包
    @router.get("/capture")
    def capture(request: Request) -> dict[str, Any]:
        core = _core(request)
        return {"status": core.capture_status(), **core.hub.snapshot()}

    @router.post("/capture/start")
    def capture_start(body: CaptureStartIn, request: Request) -> dict[str, Any]:
        return _core(request).start_capture(
            artnet=body.artnet, sacn=body.sacn, interface=body.interface, universes=body.universes
        )

    @router.post("/capture/stop")
    def capture_stop(request: Request) -> dict[str, Any]:
        core = _core(request)
        core.stop_capture()
        return core.capture_status()

    @router.post("/capture/sacn-universes")
    def capture_universes(body: UniversesIn, request: Request) -> dict[str, Any]:
        return _core(request).set_sacn_universes(body.universes)

    @router.post("/capture/clear")
    def capture_clear(request: Request) -> dict[str, bool]:
        _core(request).hub.clear()
        return {"ok": True}

    @router.get("/capture/log")
    def capture_log(
        request: Request,
        after: int = Query(0, ge=0),
        limit: int = Query(200, ge=1, le=1000),
        protocol: str | None = None,
        universe: int | None = None,
        src_ip: str | None = None,
    ) -> dict[str, Any]:
        hub = _core(request).hub
        packets = hub.log.query(
            PacketFilter(src_ip=src_ip, universe=universe, protocol=protocol),
            limit=limit,
            after=after,
        )
        return {
            "paused": hub.log.paused,
            "total": hub.log.total,
            "packets": [
                {
                    "number": p.number,
                    "t": round((p.t_ns - hub.started_ns) / 1e9, 4),
                    "src": f"{p.src_ip}:{p.src_port}",
                    "protocol": p.protocol,
                    "universe": p.universe,
                    "length": len(p.data),
                    "summary": summarize(p.data),
                }
                for p in packets
            ],
        }

    @router.get("/capture/log/{number}")
    def capture_packet(number: int, request: Request) -> dict[str, Any]:
        packet = _core(request).hub.log.get(number)
        if packet is None:
            raise ApiError(404, "该包已不在日志缓冲里")
        decoded = decode(packet.data)
        return {
            "number": packet.number,
            "src": f"{packet.src_ip}:{packet.src_port}",
            "protocol": decoded.protocol,
            "kind": decoded.kind,
            "fields": [{"name": n, "value": v} for n, v in decoded.fields],
            "hex": packet.data[:700].hex(" "),
        }

    @router.post("/capture/log/pause")
    def capture_log_pause(body: LogPauseIn, request: Request) -> dict[str, bool]:
        _core(request).hub.log.paused = body.paused
        return {"paused": body.paused}

    # ---- 录制文件与录制
    @router.get("/recordings")
    def recordings(request: Request) -> list[dict[str, Any]]:
        return _core(request).list_recordings()

    @router.get("/recordings/status")
    def recording_status(request: Request) -> dict[str, Any]:
        return _core(request).recording_status()

    @router.post("/recordings/start")
    def recording_start(body: RecordStartIn, request: Request) -> dict[str, Any]:
        return _core(request).start_recording(body.model_dump(exclude_none=True))

    @router.post("/recordings/stop")
    def recording_stop(request: Request) -> dict[str, Any]:
        return _core(request).stop_recording()

    @router.post("/recordings/upload", status_code=201)
    async def recording_upload(
        request: Request, file: Annotated[UploadFile, File()]
    ) -> dict[str, Any]:
        core = _core(request)
        name = Path(file.filename or "").name
        path = core.recording_path(name)  # 先校验文件名,再读内容
        if path.exists():
            raise ApiError(409, f"文件已存在: {name}")
        limit = core.settings.max_upload_mb * 1024 * 1024
        tmp = path.with_name(path.name + ".upload")
        size = 0
        try:
            with open(tmp, "wb") as out:
                while chunk := await file.read(_UPLOAD_CHUNK):
                    size += len(chunk)
                    if size > limit:
                        raise ApiError(413, f"文件超过上限 {core.settings.max_upload_mb} MiB")
                    out.write(chunk)
            try:
                ArtRecReader.open(str(tmp))  # 必须是合法的 .artrec
            except ArtRecError as exc:
                raise ApiError(422, f"不是合法的 .artrec 文件: {exc}") from exc
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)
        return core.recording_info(name)

    @router.get("/recordings/{name}")
    def recording_info(name: str, request: Request) -> dict[str, Any]:
        return _core(request).recording_info(name)

    @router.get("/recordings/{name}/download")
    def recording_download(name: str, request: Request) -> FileResponse:
        core = _core(request)
        path = core.recording_path(name)
        if not path.is_file():
            raise ApiError(404, f"录制文件不存在: {name}")
        return FileResponse(path, media_type="application/octet-stream", filename=name)

    @router.delete("/recordings/{name}", status_code=204)
    def recording_delete(name: str, request: Request) -> Response:
        _core(request).delete_recording(name)
        return Response(status_code=204)

    # ---- 场景
    @router.get("/scenarios")
    def scenarios() -> list[dict[str, Any]]:
        result = []
        for name, text in builtin_scenarios().items():
            try:
                sc = load_scenario_text(text, origin=name)
            except ScenarioError as exc:
                result.append({"name": name, "error": str(exc)})
            else:
                result.append(_scenario_dict(name, sc, text))
        return result

    @router.get("/scenarios/status")
    def scenario_status(request: Request) -> dict[str, Any]:
        return _core(request).scenario_status()

    @router.post("/scenarios/validate")
    def scenario_validate(body: ScenarioValidateIn, request: Request) -> dict[str, Any]:
        core = _core(request)
        try:
            sc = load_scenario_text(body.yaml, origin="场景", resolve_path=_sandbox(core))
        except ScenarioError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, **_scenario_dict(sc.name, sc, body.yaml)}

    @router.post("/scenarios/run")
    def scenario_run(body: ScenarioRunIn, request: Request) -> dict[str, Any]:
        core = _core(request)
        if (body.name is None) == (body.yaml is None):
            raise ApiError(400, "name 与 yaml 必须二选一")
        text = body.yaml
        if body.name is not None:
            builtin = builtin_scenarios()
            if body.name not in builtin:
                raise ApiError(404, f"没有这个内置场景: {body.name}")
            text = builtin[body.name]
        assert text is not None
        try:
            sc = load_scenario_text(text, origin="场景", resolve_path=_sandbox(core))
        except ScenarioError as exc:
            raise ApiError(400, str(exc)) from exc
        return core.start_scenario(sc)

    @router.post("/scenarios/stop")
    def scenario_stop(request: Request) -> dict[str, Any]:
        return _core(request).stop_scenario()

    return router


def _sandbox(core: AppCore) -> Any:
    """场景里的 ``path`` 只能是录制目录里的文件名。"""

    def resolve(raw: str) -> str:
        path = core.recording_path(raw)
        if not path.is_file():
            raise ValueError(f"录制文件不存在: {raw}")
        return str(path)

    def guarded(raw: str) -> str:
        try:
            return resolve(raw)
        except ApiError as exc:
            raise ValueError(exc.message) from exc

    return guarded


def _scenario_dict(name: str, sc: Scenario, text: str) -> dict[str, Any]:
    """场景的界面描述。"""
    return {
        "name": name,
        "title": sc.name,
        "description": sc.description,
        "summary": sc.summary(),
        "duration": sc.end_time,
        "sources": [s.config.id for s in sc.sources],
        "nodes": [n.id for n in sc.nodes],
        "timeline": [{"at": e.at, "text": describe_event(e)} for e in sc.timeline],
        "yaml": text,
    }


# ------------------------------------------------------------------- 应用工厂
def create_app(settings: WebSettings) -> FastAPI:
    """创建应用。

    Args:
        settings: 已校验的 Web 设置。

    Returns:
        FastAPI 应用;启动/关闭时自动初始化/清理 :class:`AppCore`。
    """
    settings.validate()
    core = AppCore(settings)
    limiter = FailureLimiter()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        core.start()
        try:
            yield
        finally:
            core.stop()

    app = FastAPI(
        title="Art-Net / sACN 模拟工具",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )
    app.state.core = core
    app.state.limiter = limiter

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse({"detail": exc.message}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        parts = []
        for err in exc.errors():
            where = ".".join(str(x) for x in err["loc"] if x != "body")
            parts.append(f"{where}: {err['msg']}" if where else str(err["msg"]))
        return JSONResponse({"detail": ";".join(parts)}, status_code=422)

    app.include_router(build_router())
    app.include_router(ws.router)

    @app.get("/login", include_in_schema=False)
    def login(request: Request, token: str = "") -> Response:
        client = request.client.host if request.client else "?"
        if limiter.blocked(client):
            return JSONResponse({"detail": "认证失败次数过多,请稍后再试"}, status_code=429)
        if settings.auth_required and not token_matches(token, settings.token):
            limiter.record(client)
            return HTMLResponse("<meta charset=utf-8><h1>令牌不正确</h1>", status_code=401)
        response = RedirectResponse("/", status_code=303)
        if settings.auth_required and settings.token:
            response.set_cookie(
                COOKIE_NAME,
                settings.token,
                httponly=True,
                samesite="strict",
                max_age=7 * 24 * 3600,
                path="/",
            )
        return response

    @app.get("/", include_in_schema=False)
    def index() -> Response:
        page = STATIC_DIR / "index.html"
        if not page.is_file():
            return HTMLResponse("<meta charset=utf-8><h1>前端资源缺失</h1>", status_code=500)
        return FileResponse(page, headers={"Cache-Control": "no-cache"})

    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.middleware("http")
    async def no_store_for_api(request: Request, call_next: Any) -> Response:
        response: Response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path == "/" or request.url.path.startswith("/static/"):
            response.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; connect-src 'self'; img-src 'self' data:; "
                "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            )
        return response

    app.add_middleware(SecurityMiddleware, settings=settings, limiter=limiter)
    return app
