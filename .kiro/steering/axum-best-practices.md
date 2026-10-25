---
inclusion: manual
---

# Axum 实战指导（`itgw-api`，Axum 0.8）

面向本项目管理层 `itgw-api` 的 Axum 实战最佳实践。基于 Axum 0.8（2026 当前主线）与社区资料整理，并落到本项目约定（`AppState` 持 Registry + 仓储端口、`GatewayError` 领域错误、插件调用弹性在 host 侧 `DylibDriverProxy` 调用路径、信封 + 不透明 `params`、先落库再热应用、当前批次无鉴权）。与 `tech.md`（依赖/编码约定）、`structure.md`（`itgw-api` 布局）、`architecture.md`（分层）互补。

> 内容依授权合规改写，关键结论附来源链接（见文末"参考来源"）。版本相关结论落地前以 `cargo outdated` + Axum 官方 changelog 复核。

---

## 一、版本要点（0.8 必读）

- **路径参数语法改为花括号**：Axum 0.8 起捕获用 `{param}`、通配用 `{*rest}`，不再是旧的 `:param`/`*rest`。本项目端点一律写 `"/api/nodes/{node}/groups/{group}/tags/{tag}/write"`、`"/api/nodes/{node}/browse"`。
- **更友好的编译诊断**：0.8 改进了 handler 不满足 trait bound 时的报错；配合 `#[axum::debug_handler]` 定位"为什么这个函数不是合法 handler"。
- Axum **无自研中间件体系**，直接复用 `tower`/`tower-http` 生态（§七）。

---

## 二、crate 内结构（对齐 `structure.md`）

`itgw-api/src/` 按职责分模块：`build_router(state) -> Router` 装配入口、`AppState`（`Arc` 持 Registry + `NodeStore`/`NorthAppStore` 等端口）、`endpoints/`（按资源分文件：nodes / groups / tags / plugins / north_apps / subscriptions / monitoring / write / browse / discover / processing / thing_model）、`contracts/`（请求/响应 DTO，手写 ↔ 领域映射，camelCase）、`ApiError`（`GatewayError → IntoResponse` 统一错误响应体）、`processing/`（eKuiper REST 客户端 + `provision_default_stream`，reqwest）。

原则：**handler 只做"提取 → 调用领域/registry → 映射 DTO"**，不放业务逻辑（业务在 `itgw-app::collection`/领域层）。每个资源一个模块，导出 `fn routes() -> Router<AppState>`，在根组合。

---

## 三、状态管理 `AppState`

- `AppState` **实现 `Clone`，内部字段皆 `Arc`**：Axum 每请求会 clone 一次 state，clone 必须廉价。
- **不要用一把全局 `Arc<Mutex<AppState>>` 包裹整个状态**——会把所有请求串行化。按字段选并发原语：订阅表 `arc-swap`（读多写少）、连接状态 `watch`、并发 map `dashmap`；仓储端口本身是 `Arc<dyn ...>` 无需锁。
- **子状态用 `FromRef`**：handler 只依赖它需要的那部分，便于测试注入替身。

```rust
#[derive(Clone)]
pub struct AppState {
    pub nodes: Arc<dyn NodeStore>,
    pub north_apps: Arc<dyn NorthAppStore>,
    pub registry: Arc<NodeRuntimes>,       // 兼 DeviceControl
    pub subscriptions: Arc<SubscriptionTable>,
}
impl FromRef<AppState> for Arc<dyn NodeStore> {
    fn from_ref(s: &AppState) -> Self { s.nodes.clone() }
}
// handler 里：State(repo): State<Arc<dyn NodeStore>>
```

State 是路由全局、跨请求共享：连接池、配置、缓存、registry 都放这里。

---

## 四、路由与组合

```rust
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .nest("/api", api_routes())
        .layer(observability_layers())   // §七：最外层放 trace（先注册路由，后 layer）
        .with_state(state)
}
fn api_routes() -> Router<AppState> {
    Router::new()
        .merge(endpoints::nodes::routes())
        .merge(endpoints::browse::routes())
        // ...其余资源
}
// endpoints/browse.rs
pub fn routes() -> Router<AppState> {
    Router::new().route("/nodes/{node}/browse", get(browse))
}
```

- **`layer` 只作用于它之前已注册的路由**：先加路由/fallback，再 `.layer(...)`；之后再加的路由不带该中间件。
- 资源模块返回 `Router<AppState>`，根部 `with_state` 后收敛为 `Router`。
- 副作用端点（写入/反控/纳管确认）用 `post`/`put`；浏览/监控用 `get`。

---

## 五、提取器（Extractors）

- 常用：`State<_>`、`Path<T>`（多段路径用元组或结构体）、`Query<T>`、`Json<T>`（请求体）。
- **提取器有顺序**：消费请求体的 `Json`/`Bytes`（实现 `FromRequest`）必须是**参数列表最后一个**；`State`/`Path`/`Query`（实现 `FromRequestParts`）在前。
- **DTO 与领域模型分离**：入参在 `contracts/` 定义 `Deserialize` DTO，手写映射到领域类型；出参把领域类型映射成 `Serialize` DTO（camelCase）。**不要**直接把 `itgw-core` 领域类型当 API 契约暴露，避免序列化格式与领域演进耦合。
- **信封边界**：`node.params` 等不透明字段在 DTO 里保留为 `serde_json::Value` 原样透传，API 层不解析（对齐 Host 职责边界）。
- 校验：结构层用 `serde` + `garde`；业务校验（`interval_ms >= 100`、driver 已注册）在领域/registry，失败经 `GatewayError` 回流为 `ApiError`。

```rust
async fn browse(
    State(state): State<AppState>,
    Path(node): Path<String>,
    Query(q): Query<BrowseQuery>,     // path/continuation/max
) -> Result<Json<BrowseResponseDto>, ApiError> {
    let res = state.registry.browse(&node, q.path.as_deref(), q.continuation.as_deref()).await?;
    Ok(Json(BrowseResponseDto::from_domain(&node, res)))
}
```

---

## 六、错误处理（核心）

**统一模式：定义 `ApiError`，实现 `IntoResponse` + `From<GatewayError>`，handler 返回 `Result<_, ApiError>` 用 `?` 传播。**

关键规则：
- **绝不把 `anyhow::Error` 或内部错误细节直接返回客户端**——会泄露实现/私有信息。库边界一律用领域 `GatewayError`（`tech.md`），API 层翻译成"面向客户端的安全表示"。
- **在 `IntoResponse` 里记日志再产响应**：错误类型自己 `tracing::error!/warn!` 记录内部细节，响应体只给稳定的 `code` + 安全 `message`。
- **领域错误 → HTTP 状态码映射集中一处**（`error.rs`），保证全 API 一致。

```rust
pub struct ApiError(pub GatewayError);

impl From<GatewayError> for ApiError { fn from(e: GatewayError) -> Self { Self(e) } }

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        use GatewayError::*;
        let (status, code) = match &self.0 {
            InvalidTag(_) | InvalidArgument(_) | InvalidDriverConfig(_)
                                     => (StatusCode::BAD_REQUEST, "INVALID_ARGUMENT"),
            NotConnected(_)          => (StatusCode::CONFLICT, "NOT_CONNECTED"),
            CapabilityUnavailable(_) => (StatusCode::NOT_IMPLEMENTED, "CAPABILITY_UNAVAILABLE"),
            DriverConnection(_)      => (StatusCode::BAD_GATEWAY, "DRIVER_CONNECTION"),
            PluginLoad(_)            => (StatusCode::INTERNAL_SERVER_ERROR, "PLUGIN_LOAD"),
        };
        // 内部细节只进日志，不进响应体
        tracing::warn!(error = %self.0, code, "api error");
        let body = Json(json!({ "error": { "code": code, "message": client_safe_msg(&self.0) } }));
        (status, body).into_response()
    }
}
```

- **提取器拒绝也要统一**：`Json`/`Path`/`Query` 反序列化失败默认返回纯文本 400。生产可用 `WithRejection` 或自定义 `Json` 提取器把它们也纳入 `ApiError` 统一 JSON 错误体。
- 业务性失败（tag 不可写、地址非法、ProductKey 未命中、结构冲突 `COL-xxxx`）走 `GatewayError` 变体 → 稳定 `code`，前端可判定。

---

## 七、中间件（tower 洋葱）

- **顺序 = 洋葱**：`.layer(A).layer(B)` 时 A 在最外层（最先见到请求、最后见到响应）。本项目建议自外向内：`TraceLayer`（tower-http）→ `CorsLayer` → 超时 → 具体业务层。
- **两类中间件不要混淆归属**：
  - **HTTP 横切**（trace/cors/超时/请求体限长/压缩）在 `itgw-api` 用 `tower-http`。
  - **插件调用的熔断/超时/重试** 在 host 侧 `DylibDriverProxy` 调用路径（`itgw-plugin` 的 tower stack，`failsafe` + `timeout`），**不在 API 层**——API 只是薄入口。
- 认证：**当前批次无鉴权**（`implementation-plan.md` Task 12），仅限内网/开发；后续 security-auth 批次用 tower 中间件补 JWT，端点授权用 per-route layer。**新增网络暴露端点时必须显式标注鉴权缺失**。
- 自定义中间件优先 `axum::middleware::from_fn`（简单）或实现 tower `Layer`/`Service`（可复用、可组合）。

```rust
fn observability_layers() -> tower::layer::util::Stack</* ... */> {
    ServiceBuilder::new()
        .layer(TraceLayer::new_for_http())   // 最外层
        .layer(CorsLayer::permissive())      // 内网/开发；生产收敛来源
        .layer(TimeoutLayer::new(Duration::from_secs(30)))
}
```

---

## 八、测试

两种策略并用（对齐 `structure.md` 测试组织）：
1. **handler 单元测试**：直接 `await` 调 handler 函数，注入构造好的 `AppState`（用 `FromRef` 塞测试替身仓储/registry），隔离业务映射，最快。
2. **集成测试**：走完整请求/响应。两条路：
   - `tower::ServiceExt::oneshot(router, request)`——零网络、最轻，验证路由/提取/状态码/错误体。
   - **`axum-test` 的 `TestServer`**（`tech.md` 已列）——mocked 网络或随机端口真网络，多服务器可并行；适合端到端（discover → preview → confirm）。

```rust
#[tokio::test]
async fn browse_requires_connected_node() {
    let app = build_router(test_state_with(/* 未连接的 mock 驱动 */));
    let server = TestServer::new(app).unwrap();
    let resp = server.get("/api/nodes/OpcSrv1/browse").await;
    resp.assert_status(StatusCode::CONFLICT);          // NotConnected → 409
    resp.assert_json_contains(&json!({"error":{"code":"NOT_CONNECTED"}}));
}
```

- 错误分支要覆盖：能力缺失（501）、未连接（409）、ProductKey 未命中、结构冲突、校验失败（400）。
- JSON 契约（browse/thing-model payload/schema）用 `insta` 快照断言（`tech.md`），改契约时 `cargo insta review`。
- 时间相关（超时中间件）用 `tokio::time::pause`。

---

## 九、并发与热应用

- **先落库再热应用**（`architecture.md`）：写端点在 handler 里先经仓储端口事务落 SQLite，再发 `CtrlCommand::Reconfigure/ReloadTags` 通知运行时热重建，**不阻塞 HTTP 响应等待采集生效**（除非语义上要求同步确认）。
- **反控写入**经 `DeviceControl`（tag 级）/ `ThingModelControl`（物模型级），API 只转交、拿 `oneshot` 结果映射成响应；不在 handler 里直接碰驱动。
- 长只读操作（`browse`）对已连接 Node 生效，建议在 API 层加基础频率限制（tower 限流层，横切）。

---

## 十、可观测性

- `TraceLayer` 生成每请求 span；handler 内用 `#[tracing::instrument(skip(state))]` 附 `node`/`group` 等字段，与 `DylibDriverProxy` 调用路径的 `DiagnosticsLayer` 同源 OTel（`tech.md` 日志规范）。
- **禁止在响应体/日志字段输出口令、Token、展开后的密钥**（配合 `secrecy` 包裹 secret 字段）。
- 错误响应体只暴露稳定 `code` + 安全 `message`；堆栈/内部错误链只进 `tracing`。

---

## 十一、常见坑清单

- 用了 0.7 的 `:param` 路径语法 → 0.8 会 panic/不匹配，改 `{param}`。
- `.layer()` 加在路由之前 → 中间件不生效；必须先路由后 layer。
- handler 编译报晦涩 trait bound 错 → 加 `#[axum::debug_handler]`，多半是提取器顺序错（`Json` 没放最后）或返回类型没实现 `IntoResponse`。
- 把 `anyhow::Error` 直接 `?` 到响应 → 泄露内部信息；必须过 `ApiError`。
- 整个 `AppState` 包 `Mutex` → 请求串行化；按字段选并发原语。
- 直接暴露领域类型作 API 契约 → 领域演进破坏 API 兼容；用 `contracts/` DTO 隔离。
- 新增网络端点忘记标注鉴权缺失 → 安全隐患，必须在文档/代码显式声明。

---

## 参考来源

以下为整理本指导时参考的公开资料（内容已依授权合规改写，非逐字复制）：

- Axum 官方文档：中间件 <https://github.com/tokio-rs/axum/blob/main/axum/src/docs/middleware.md>、layer 顺序 <https://github.com/tokio-rs/axum/blob/main/axum/src/docs/routing/layer.md>、State 概念 <https://tokio-rs-axum.mintlify.app/concepts/state>、错误处理 <https://tokio-rs-axum.mintlify.app/concepts/error-handling>
- 错误处理实践：<https://github.com/tokio-rs/axum/discussions/1941>（anyhow 泄露内部细节的讨论）、<https://lpalmieri.com/posts/rust-web-frameworks-have-subpar-error-reporting/>、<https://rup12.net/posts/learning-rust-custom-errors/>、<https://leapcell.io/blog/elegant-error-handling-in-axum-actix-web-with-intoresponse>
- 测试：`axum-test`（`JosephLenton/axum-test`）、Axum 官方 testing 示例 <https://github.com/tokio-rs/axum/blob/main/examples/testing/src/main.rs>
- 中间件与生产实践：<https://oneuptime.com/blog/post/2026-01-25-tower-middleware-auth-logging-axum-rust/view>、Axum 0.8 概览 <https://www.rustfinity.com/blog/axum-rust-tutorial>

> 说明：内容为面向本项目的再组织与改写，用于内部工程指导；具体 API 与版本行为以 Axum 官方文档/changelog 为准。
