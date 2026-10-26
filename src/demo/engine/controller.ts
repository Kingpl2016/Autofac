import type {
  ControllerConfig,
  ControllerStatus,
  FileEntry,
} from "@/features/controller/lib/api";
import type { Library } from "./library";
import {
  fail,
  num,
  sleep,
  str,
  type CommandArgs,
  type DemoModule,
  type World,
} from "./world";

/** 模拟 TCP 指令往返与文件传输的耗时。 */
const COMMAND_DELAY_MS = 120;
const TRANSFER_DELAY_MS = 450;
/** 下载文件时实际返回的字节数上限（演示用，不真的生成几十 MB）。 */
const DOWNLOAD_SAMPLE_BYTES = 2048;

const NOT_CONNECTED = "核心板未连接";

/**
 * 创建核心板控制模块：连接 / 断开、工作模式、整板与节目指令、通道读写，
 * 以及 SD 卡文件的列出、上传、下载、重命名和删除。
 *
 * 只有 `controller.json` 的 `reachableHosts` 里的地址能连上，其它地址会在短暂等待后报连接超时，
 * 方便看到失败路径。文件改动在内存里生效，刷新页面后还原。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 * * `library` - 节目库，“上传节目到核心板”要取它的文件名与体积。
 *
 * # Returns
 *
 * 核心板控制模块。
 */
export function createControllerModule(world: World, library: Library): DemoModule {
  const seed = world.data.controller;
  let config: ControllerConfig = { ...seed.config };
  let workMode = seed.workMode;
  let files: FileEntry[] = seed.files.map((f) => ({ ...f }));
  /** 通道值存储：通道号（1 起）→ 值。 */
  const channels = new Map<number, number>(
    Object.entries(seed.channelMemory).map(([k, v]) => [Number(k), v]),
  );

  const requireConnected = () => {
    if (!config.connected) fail(NOT_CONNECTED);
  };

  const requireFile = (name: string): FileEntry => {
    const f = files.find((x) => x.name === name);
    if (!f) fail(`文件不存在: ${name}`);
    return f;
  };

  const status = (): ControllerStatus => ({ config, workMode: config.connected ? workMode : null });

  /** 为下载生成示例内容：文本文件用数据文件里的正文，其它文件给一段带文件名的二进制。 */
  const sampleBytes = (name: string): ArrayBuffer => {
    const text = seed.textFiles[name];
    if (text !== undefined) return new TextEncoder().encode(text).buffer as ArrayBuffer;
    const bytes = new Uint8Array(DOWNLOAD_SAMPLE_BYTES);
    const header = new TextEncoder().encode(`ARTREC-DEMO:${name}\n`);
    bytes.set(header.subarray(0, Math.min(header.length, bytes.length)));
    for (let i = header.length; i < bytes.length; i += 1) bytes[i] = (i * 31 + name.length) & 0xff;
    return bytes.buffer;
  };

  return {
    commands: {
      controller_get_status: () => config,

      controller_connect: async (args: CommandArgs) => {
        const host = str(args, "host").trim();
        await sleep(seed.connectDelayMs);
        if (!seed.reachableHosts.includes(host)) {
          fail(`连接 ${host}:${num(args, "tcpPort")} 超时 (os error 10060)`);
        }
        config = {
          host,
          tcpPort: num(args, "tcpPort") || 1227,
          httpPort: num(args, "httpPort") || 80,
          connected: true,
        };
        world.log("info", `核心板已连接 ${host}:${config.tcpPort},工作模式=${workMode}`);
        return status();
      },

      controller_disconnect: () => {
        if (config.connected) world.log("info", `核心板已断开: ${config.host}`);
        config = { ...config, connected: false };
      },

      controller_board_op: async (args: CommandArgs) => {
        requireConnected();
        await sleep(COMMAND_DELAY_MS);
        const labels = ["复位", "恢复出厂设置", "自检"];
        world.log("info", `核心板操作: ${labels[num(args, "op")] ?? "未知"}`);
      },

      controller_set_work_mode: async (args: CommandArgs) => {
        requireConnected();
        await sleep(COMMAND_DELAY_MS);
        workMode = Math.max(0, Math.min(5, Math.round(num(args, "mode"))));
      },

      controller_get_work_mode: () => {
        requireConnected();
        return workMode;
      },

      controller_program_op: async (args: CommandArgs) => {
        requireConnected();
        await sleep(COMMAND_DELAY_MS);
        const programNo = num(args, "programNo");
        if (programNo < 0 || programNo > 255) fail("节目编号超出范围 (0-255)");
      },

      controller_write_channels: async (args: CommandArgs) => {
        requireConnected();
        await sleep(COMMAND_DELAY_MS);
        const start = num(args, "start");
        const values = Array.isArray(args.values) ? (args.values as number[]) : [];
        values.forEach((v, i) => channels.set(start + i, Math.max(0, Math.min(255, Math.round(v)))));
      },

      controller_read_channels: async (args: CommandArgs) => {
        requireConnected();
        await sleep(COMMAND_DELAY_MS);
        const start = num(args, "start");
        const count = Math.max(1, num(args, "unitCount")) * Math.max(1, num(args, "unitRun"));
        return Array.from({ length: Math.min(count, 64) }, (_, i) => channels.get(start + i) ?? 0);
      },

      controller_list_files: async () => {
        requireConnected();
        await sleep(COMMAND_DELAY_MS);
        return files;
      },

      controller_download_file: async (args: CommandArgs) => {
        requireConnected();
        const name = str(args, "name");
        requireFile(name);
        await sleep(TRANSFER_DELAY_MS);
        return sampleBytes(name);
      },

      controller_upload_file: async (args: CommandArgs) => {
        requireConnected();
        const name = str(args, "name");
        const data = args.data;
        const size = data instanceof ArrayBuffer ? data.byteLength : 0;
        await sleep(TRANSFER_DELAY_MS);
        files = [...files.filter((f) => f.name !== name), { name, size, isDir: false }];
        world.log("info", `核心板上传文件: ${name} (${size} 字节)`);
      },

      controller_delete_file: async (args: CommandArgs) => {
        requireConnected();
        const name = str(args, "name");
        requireFile(name);
        await sleep(COMMAND_DELAY_MS);
        files = files.filter((f) => f.name !== name);
      },

      controller_rename_file: async (args: CommandArgs) => {
        requireConnected();
        const from = str(args, "from");
        const to = str(args, "to").trim();
        const file = requireFile(from);
        if (!to) fail("新文件名不能为空");
        if (files.some((f) => f.name === to)) fail(`文件已存在: ${to}`);
        await sleep(COMMAND_DELAY_MS);
        files = files.map((f) => (f === file ? { ...f, name: to } : f));
      },

      controller_upload_recording: async (args: CommandArgs) => {
        requireConnected();
        const rec = library.find(str(args, "path"));
        if (!rec) fail("bad_path");
        await sleep(TRANSFER_DELAY_MS * 2);
        const name = rec.entry.fileName;
        files = [...files.filter((f) => f.name !== name), { name, size: rec.entry.bytes, isDir: false }];
        world.log("info", `节目已上传到核心板: ${name}`);
        return name;
      },
    },
  };
}
