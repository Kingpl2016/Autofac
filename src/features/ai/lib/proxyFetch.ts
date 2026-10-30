import { Channel } from "@tauri-apps/api/core";

import { invoke } from "@/shared/tauri/invoke";
import type { ProxyEvent, ProxyRequest } from "./types";

/**
 * 经后端代理（`ai_fetch`）发请求的 `fetch` 实现，交给 AI SDK 的提供商使用。
 *
 * SDK 照常组装请求（含占位 Key），这里把它转成 {@link ProxyRequest}；后端丢弃认证头、注入真实 Key，
 * 再把响应按 `head` → `chunk`* → `end` 回传，这里拼成带 `ReadableStream` 的标准 `Response`，
 * 所以 SDK 的流式解析（SSE）照常工作。
 */

/** 代理返回的错误（后端 `{ code, message }`）。 */
export class AiProxyError extends Error {
  /** 稳定错误码（见 Rust `AiError::code`）。 */
  readonly code: string;

  /**
   * @param code 错误码。
   * @param message 描述。
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiProxyError";
    this.code = code;
  }
}

/** 代理的底层传输（测试时替换）。 */
export interface ProxyTransport {
  /** 发出请求；事件经 `onEvent` 回传，命令结束（成功或失败）时 Promise 结束。 */
  send: (request: ProxyRequest, onEvent: (e: ProxyEvent) => void) => Promise<void>;
  /** 取消请求。 */
  cancel: (requestId: string) => void;
}

/** 默认传输：Tauri 命令 + 通道。 */
const tauriTransport: ProxyTransport = {
  send: (request, onEvent) => {
    const channel = new Channel<ProxyEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("ai_fetch", { request, onEvent: channel });
  },
  cancel: (requestId) => {
    void invoke<boolean>("ai_fetch_cancel", { requestId }).catch(() => undefined);
  },
};

/** 命令已结束但还没收到响应头时，最多再等多久（通道消息与命令结果分开投递，可能晚到）。 */
const HEAD_GRACE_MS = 5000;

/** 不能带响应体的状态码。 */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** 生成请求 id。 */
function newRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 与浏览器 `fetch` 一致的中止错误。 */
function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
}

/** 把命令的失败值转成 {@link AiProxyError}。 */
function toProxyError(e: unknown): AiProxyError {
  if (typeof e === "object" && e !== null) {
    const o = e as Record<string, unknown>;
    if (typeof o.code === "string" && typeof o.message === "string") return new AiProxyError(o.code, o.message);
  }
  return new AiProxyError("network", e instanceof Error ? e.message : String(e));
}

/**
 * 创建经后端代理发往某个 AI 配置的 `fetch`。
 *
 * @param profileId AI 配置 id（后端据此校验目标地址并注入 Key）。
 * @param transport 底层传输；省略时用 Tauri 命令。
 * @returns 与 `fetch` 签名一致的函数。
 */
export function createProxyFetch(profileId: string, transport: ProxyTransport = tauriTransport): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    const headers: [string, string][] = [];
    req.headers.forEach((value, name) => headers.push([name, value]));
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    const requestId = newRequestId();

    return new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let headSeen = false;
      let closed = false;
      const encoder = new TextEncoder();
      const cancelRemote = () => transport.cancel(requestId);
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
        // 读取方放弃读取（例如 SDK 中止解析）：通知后端停止
        cancel: () => {
          closed = true;
          cancelRemote();
        },
      });
      const fail = (e: unknown) => {
        if (!headSeen) reject(e);
        else if (!closed) {
          closed = true;
          controller?.error(e);
        }
      };
      const onAbort = () => {
        cancelRemote();
        fail(abortError(signal as AbortSignal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const onEvent = (e: ProxyEvent) => {
        if (closed) return;
        switch (e.event) {
          case "head":
            headSeen = true;
            resolve(
              new Response(NULL_BODY_STATUS.has(e.status) ? null : stream, {
                status: e.status,
                headers: e.headers,
              }),
            );
            break;
          case "chunk":
            controller?.enqueue(encoder.encode(e.text));
            break;
          case "end":
            closed = true;
            controller?.close();
            break;
        }
      };

      transport
        .send({ requestId, profileId, url: req.url, method: req.method, headers, body }, onEvent)
        .then(
          () => {
            if (headSeen) return;
            // 命令成功但响应头还没到：给通道一点时间，仍然没有就当作响应不完整
            setTimeout(() => {
              if (!headSeen) reject(new AiProxyError("network", "响应不完整"));
            }, HEAD_GRACE_MS);
          },
          (e: unknown) => fail(signal?.aborted ? abortError(signal) : toProxyError(e)),
        )
        .finally(() => signal?.removeEventListener("abort", onAbort));
    });
  };
}
