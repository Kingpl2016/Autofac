import { filter, map, Subject, type Observable } from "rxjs";

/**
 * 应用级事件表。插件通过模块扩充（`declare module`）新增自己的事件，
 * 这样总线本身不需要知道任何业务。
 */
export interface AppEventMap {
  /** 一个插件完成了 `setup`。 */
  "plugin:ready": { name: string };
}

/** 事件信封：携带事件类型与对应载荷。 */
interface EventEnvelope<M, K extends keyof M = keyof M> {
  /** 事件类型。 */
  type: K;
  /** 事件载荷。 */
  payload: M[K];
}

/**
 * 类型安全的事件总线。
 *
 * @typeParam M 事件表，键为事件名，值为载荷类型。
 */
export interface EventBus<M> {
  /** 发布事件。 */
  emit: <K extends keyof M>(type: K, payload: M[K]) => void;
  /** 订阅指定事件，返回 Observable，可使用全部 RxJS 操作符。 */
  on: <K extends keyof M>(type: K) => Observable<M[K]>;
  /** 全部事件流（日志、调试）。 */
  readonly all$: Observable<EventEnvelope<M>>;
}

/**
 * 创建基于 RxJS `Subject` 的事件总线，用于插件之间的解耦通信：
 * 插件只依赖事件名，不直接互相 import。
 *
 * @returns 事件总线。
 */
export function createEventBus<M extends object>(): EventBus<M> {
  const subject = new Subject<EventEnvelope<M>>();
  return {
    emit: (type, payload) => subject.next({ type, payload } as EventEnvelope<M>),
    on: <K extends keyof M>(type: K) =>
      subject.pipe(
        filter((event): event is EventEnvelope<M, K> => event.type === type),
        map((event) => event.payload),
      ),
    all$: subject.asObservable(),
  };
}
