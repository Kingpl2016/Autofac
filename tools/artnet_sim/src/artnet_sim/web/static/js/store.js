// 实时数据:WebSocket 连接、状态缓存、统计历史。

import { get } from "./api.js";
import { decodeFrame, watchMessage } from "./frames.js";

const HISTORY_LENGTH = 120;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5000;

export class Live {
  constructor() {
    /** 最近一次统计:{ state, capture }。 */
    this.stats = null;
    this.connected = false;
    /** 每条数据流最近 HISTORY_LENGTH 秒的 pps / 抖动 / 丢包,键为 streamKey。 */
    this.history = new Map();
    this._listeners = new Set();
    this._frameHandlers = new Set();
    this._watchItems = [];
    this._ws = null;
    this._backoff = BACKOFF_MIN_MS;
    this._timer = null;
    this._closed = false;
  }

  /** 订阅状态变化(连接状态或新统计)。返回取消订阅函数。 */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** 订阅二进制数据帧。返回取消订阅函数。 */
  onFrame(fn) {
    this._frameHandlers.add(fn);
    return () => this._frameHandlers.delete(fn);
  }

  /** 设置监看项(整体替换)。连接断开重连后会自动重发。 */
  watch(items) {
    this._watchItems = items;
    this._sendWatch();
  }

  async start() {
    try {
      const [state, capture] = await Promise.all([get("/api/state"), get("/api/capture")]);
      this._applyStats(state, capture);
    } catch {
      // 认证失败等情况:连接状态栏会显示未连接
    }
    this._connect();
  }

  /** 主动拉取一次最新状态(执行操作后调用,不必等下一次推送)。 */
  async refresh() {
    const [state, capture] = await Promise.all([get("/api/state"), get("/api/capture")]);
    this._applyStats(state, capture);
  }

  stop() {
    this._closed = true;
    clearTimeout(this._timer);
    if (this._ws) this._ws.close();
  }

  _notify() {
    for (const fn of this._listeners) fn(this);
  }

  _applyStats(state, capture) {
    this.stats = { state, capture };
    const alive = new Set();
    for (const s of capture.streams || []) {
      const key = streamKey(s);
      alive.add(key);
      let ring = this.history.get(key);
      if (!ring) {
        ring = [];
        this.history.set(key, ring);
      }
      ring.push({ pps: s.pps, jitter: s.interval_stddev_ms, lost: s.lost });
      if (ring.length > HISTORY_LENGTH) ring.shift();
    }
    for (const key of [...this.history.keys()]) if (!alive.has(key)) this.history.delete(key);
    this._notify();
  }

  _sendWatch() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(watchMessage(this._watchItems));
    }
  }

  _connect() {
    if (this._closed) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/ws/live`);
    ws.binaryType = "arraybuffer";
    this._ws = ws;
    ws.addEventListener("open", () => {
      this.connected = true;
      this._backoff = BACKOFF_MIN_MS;
      this._sendWatch();
      this._notify();
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "stats") this._applyStats(message.state, message.capture);
        return;
      }
      const frame = decodeFrame(event.data);
      if (frame) for (const fn of this._frameHandlers) fn(frame);
    });
    ws.addEventListener("close", () => {
      this.connected = false;
      this._notify();
      if (this._closed) return;
      this._timer = setTimeout(() => this._connect(), this._backoff);
      this._backoff = Math.min(BACKOFF_MAX_MS, this._backoff * 2);
    });
  }
}

/** 数据流的稳定键。 */
export function streamKey(stream) {
  return `${stream.protocol}:${stream.universe}:${stream.source_id}`;
}

let metaPromise = null;

/** 静态元数据(网卡、生成器说明),只请求一次。 */
export function loadMeta(force = false) {
  if (!metaPromise || force) metaPromise = get("/api/meta");
  return metaPromise;
}
