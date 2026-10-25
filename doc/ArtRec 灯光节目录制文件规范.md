# ArtRec 灯光节目录制文件规范

ArtNet/DMX512 时间轴节目文件格式 v1\.0
文件后缀：**\.artrec**
适用范围：ArtNet / DMX512 流录制、时间轴节目存储、嵌入式网关回放、灯光模拟器

## 1 引言与范围

### 1\.1 文档目的与适用范围

本文档定义 ArtRec 灯光节目录制文件格式（文件后缀 \.artrec）的完整规范。该格式面向 ArtNet / DMX512 协议的灯光时间轴节目数据，适用于节目录制、节目文件存储、嵌入式网关回放以及灯光模拟器等场景，可作为上位机录制软件与嵌入式回放设备之间交换节目数据的标准载体。

本规范包含文件整体布局、各数据结构定义、录制与回放流程、压缩策略、校验与容错、C 语言类型定义、示例演算、移植建议以及版本迭代规则，供开发者依据本文件直接实现录制器与回放器。

### 1\.2 术语与约定

|术语/约定|说明|
|---|---|
|大端（网络字节序）|所有多字节整数在文件中的存储顺序为高字节在前（Big‑Endian），与 ArtNet、DMX、网络协议字节序保持一致|
|偏移量|指相对文件起始位置（文件偏移 0）的绝对字节偏移；除非特别说明为相对某区的局部偏移|
|长度单位|字节|
|时间单位|微秒（us），数据类型 uint64，表示相对节目录制起点的相对时间|
|CRC16|统一使用 CRC16‑CCITT，多项式 0x1021，初始值 0xFFFF，输出不反转|
|结构体对齐|C 结构体一律使用 `#pragma pack(1)` 紧凑对齐，禁止编译器填充|

### 1\.3 设计目标与核心取舍

ArtRec 格式的设计以灯光控制场景的特殊性为核心，在自描述性、编解码速度、压缩率与嵌入式可移植性之间取得平衡。格式采用二进制、固定头、索引表加分块存储的设计，所有分区的位置由文件头中的偏移字段指定，不依赖分区在文件中的物理先后顺序，从而实现完全自描述。

针对灯光流的特性——大部分 DMX 通道变化缓慢、相邻帧数据高度相似——本格式引入差分录制与 Zstd 压缩，可在静止场景下极大压缩文件体积，同时保持回放时的快速随机定位能力。

## 2 文件整体布局

### 2\.1 全局总览

ArtRec 文件由文件头起始，自上而下划分为四个逻辑分区，各分区的位置由全局文件头内的偏移字段指明。

- A区：全局文件头 ArtRecFileHeader，固定64字节

- B区：Universe 描述表 ArtRecUniDesc\[\]，条目数量 = header\.universe\_count，单条16字节

- C区：帧索引表 ArtRecFrameIndex\[\]，条目数量 = header\.frame\_count，单条16字节

- D区：Chunk 数据块池，连续多个独立 Chunk

### 2\.2 布局设计原则

A 区（全局文件头）是整份文件的"地图"。B、C、D 区位于何处、尺寸多大，全部由 A 区中的偏移字段与计数字段指明，解析器不得硬编码分区之间的物理先后关系。后续版本如需调整分区顺序或插入扩展区，只需更新偏移字段，老解析器无需修改代码即可继续解析，这正是自描述的核心价值。

各分区之间允许存在空隙（填充字节），例如可故意将分区对齐到 4 字节或 16 字节边界以方便内存映射；空隙内填充 0，解析器跳过即可，不视为错误。分区之间的默认排布是紧密相邻，但并非强制。

## 3 全局文件头 ArtRecFileHeader

全局文件头固定位于文件偏移 0，长度为固定 64 字节，是整份文件的根目录，承载全局元数据并指向其余所有分区。

```c
typedef struct {
    uint8_t     magic[4];            // 魔数：'A','R','T','R' → 0x41 0x52 0x54 0x52
    uint16_t    endian_tag;          // 固定值 0xAA55，自描述字节序标记
    uint16_t    ver_major;           // 主版本，破坏性变更时 +1
    uint16_t    ver_minor;           // 次版本，兼容扩展时 +1
    uint32_t    flags;               // 全局标志位
    uint64_t    rec_start_us;        // 录制开始 Unix 时间戳(us)，仅用于日志
    uint64_t    total_duration_us;   // 节目总时长（相对起始，us），回放用
    uint32_t    universe_count;      // Universe 描述条目数量
    uint32_t    frame_count;         // 索引帧总条数
    uint32_t    universe_desc_offset;// B区 Universe 描述表起始偏移
    uint32_t    frame_index_offset;  // C区 Frame 索引表起始偏移
    uint32_t    chunk_pool_offset;   // D区 Chunk 块池起始偏移
    uint8_t     compress_algo;       // 压缩算法枚举（0=无压缩，1=ZSTD）
    uint8_t     compress_level;      // Zstd 压缩等级 1~22；无压缩模式忽略
    uint16_t    reserved0;
    uint8_t     reserved[34];        // 预留填充至 64 字节，未来扩展
} ArtRecFileHeader;
```

字节序标记判定规则：读取 endian\_tag 字段，若读到 0xAA55，表示文件内字节序为大端，与解析器读取一致，无需翻转；若读到 0x55AA，表示文件存储为小端，所有多字节字段均需字节反转后再解析。本规范默认写入为大端，该字段用于跨平台解析安全。

录制流程上的一个关键细节：录制开始时先写入 64 字节的文件头（此时计数、偏移、时长均为临时值 0）；待 B、C、D 区全部写完后，再回到文件偏移 0 回填偏移字段、数量与总时长。

## 4 Universe 描述表 ArtRecUniDesc

Universe 描述表位于 `header.universe_desc_offset`，由 `universe_count` 条、每条固定 16 字节的记录紧密排列而成，用于声明本节目文件包含哪些 ArtNet Universe。

```c
typedef struct {
    uint16_t    net;            // ArtNet Net（0~127）
    uint16_t    subuni;         // ArtNet SubUni（0~15）
    uint16_t    universe;       // 完整 Universe 编号 = net*16 + subuni
    uint16_t    dmx_len;        // DMX 通道长度，标准 512，支持短帧
    uint32_t    reserved;
} ArtRecUniDesc;
```

一条强绑定规则：数组的顺序即 D 区 Payload 内 DMX 数据的拼接顺序。UniDesc\[0\] 对应的 DMX 数据位于 Payload 最前端，UniDesc\[1\] 紧随其后，以此类推；回放拆分 Payload 时须严格按此顺序切分缓冲区。

## 5 帧索引表 ArtRecFrameIndex

帧索引表位于 `header.frame_index_offset`，由 `frame_count` 条、每条固定 16 字节的记录紧密排列而成，是回放随机定位的关键，无需顺序遍历整个文件即可定位到任意播放时间点对应的数据块。

```c
typedef struct {
    uint64_t    time_us;         // 相对节目起点的时间戳（微秒）
    uint32_t    chunk_pos;       // Chunk 在 D 区块池内的相对偏移（相对 chunk_pool_offset）
    uint16_t    chunk_cmp_len;   // 该 Chunk 总字节大小（ChunkHdr + 压缩 Payload）
    uint16_t    reserved;
} ArtRecFrameIndex;
```

索引表必须严格按 `time_us` 从小到大的升序排列，二分查找依赖有序性。

易混淆的偏移区分：`chunk_pos` 是相对 `chunk_pool_offset` 的局部偏移；读取该 Chunk 在文件内的绝对偏移应为 `header.chunk_pool_offset + index_item.chunk_pos`。

## 6 数据块 Chunk 结构 ArtRecChunkHdr

Chunk 数据块池位于 `header.chunk_pool_offset`，包含一串连续、独立、首尾紧贴的 Chunk，无全局分隔符。每个 Chunk 是独立单元，由 8 字节块头与压缩 Payload 组成，结构如下：

> \[ ArtRecChunkHdr（8字节） \] \+ \[ Compressed Payload \]
> 
> 

单个 Chunk 总长度 = 8 \+ payload\_cmp\_sz（等于索引中的 chunk\_cmp\_len）

```c
typedef struct {
    uint16_t    chunk_type;      // 0=标准全量帧；1=差分增量帧（扩展）
    uint16_t    payload_raw_sz;  // 解压之后原始 Payload 总字节数
    uint16_t    payload_cmp_sz;   // Payload 压缩后字节（不含 8 字节 ChunkHdr）
    uint16_t    crc16;            // CRC16‑CCITT，仅校验 Payload 区域
} ArtRecChunkHdr;
```

### 6\.1 全量帧 Payload（chunk\_type=0）

全量帧是基础帧类型，回放器必须支持。其 Payload 原始（解压后）布局为按 UniDesc 数组顺序连续拼接的各路 DMX 数据：

`DMX0[dmx_len0] + DMX1[dmx_len1] + DMX2[dmx_len2] + ...`

### 6\.2 差分增量帧 Payload（chunk\_type=1）

差分增量帧为可选扩展，仅当 flags 的 bit2（ALLOW\_DIFF\_FRAME）置位时允许存在。Payload 只存储通道变更列表，回放时在上一帧 DMX 缓冲区基础上原地修改指定通道，其余通道保持不变，可进一步压缩体积极小、变化极少的节目。其布局如下：

```
[ uint16 changed_cnt ]
{
    uint16 uni_idx;     // 对应 UniDesc 数组下标
    uint16 ch_addr;     // DMX 通道地址 0~511
    uint8  ch_val;       // 新通道值
} × changed_cnt
```

## 7 枚举与标志位定义

### 7\.1 压缩算法 compress\_algo

|取值|名称|说明|
|---|---|---|
|0|NO\_COMPRESS|无压缩，Payload 直接为原始二进制数据|
|1|ZSTD|使用 Zstd 算法压缩|

同一文件内统一使用一种压缩算法，不允许混合多种压缩方式。

### 7\.2 全局标志位 flags（uint32）

|位|名称|含义|
|---|---|---|
|bit0|LOOP\_PLAY|1=推荐循环播放（仅为标记，循环逻辑由上层实现）|
|bit1|HAS\_SMPTE|1=文件附带 SMPTE 时间码扩展块（预留扩展）|
|bit2|ALLOW\_DIFF\_FRAME|1=允许文件内出现差分帧 chunk\_type=1|
|bit3\~31|—|保留位，当前应置 0|

## 8 录制流程规范

录制策略采用定时采样与变更触发两种模式之一。不建议每收到一个 ArtNet UDP 包就保存一帧，因为 ArtNet 本身是异步 UDP 流，会产生大量冗余帧。

### 8\.1 定时采样模式

以固定采样周期触发快照，例如 40Hz（每 25 毫秒一帧，舞台常规刷新率）。具体步骤：维护一组 DMX 缓冲区，每个订阅的 Universe 使用独立 512 字节缓冲区，持续接收 ArtNet 包更新缓冲区；每间隔固定周期触发一次快照，将所有 Universe 缓冲区拼接为原始 Payload；按压缩算法压缩后在 ChunkPool 写入 ChunkHdr 与压缩 Payload；追加一条 FrameIndex 记录时间戳、块偏移与块长度；录制结束后回填文件头。

### 8\.2 变更触发模式（推荐）

变更触发模式针对灯光流特性设计，压缩率极高。录制侧维护上一帧 DMX 影子缓冲区，每次收到 ArtNet 更新后与新数据对比，只要任一 Universe 任一通道发生变化即触发快照并记录当前时刻；若数据完全一致则跳过，不新增帧。回放时，两条索引之间的时间段持续输出上一帧数据，从而实现画面静止时不产生新数据，极大缩小文件体积。

### 8\.3 录制收尾硬性规则

录制收尾须满足：最后一帧索引的 `time_us` 等于 `total_duration_us`；所有偏移量建议按 4 字节对齐以利于内存映射（非强制）；魔数、endian\_tag、版本、flags、压缩参数在录制开始时写入，而帧数、总时长、各偏移字段在关闭文件前回填。

## 9 回放流程规范

### 9\.1 文件合法性校验

回放器第一步读取前 64 字节文件头并校验：校验 magic 不是 "ARTR" 则拒绝打开；根据 endian\_tag 判断是否需要对整个头部结构体做字节翻转；检查 ver\_major 是否高于解析器支持的主版本，高于则拒绝打开；读取 flags 与压缩算法，确认回放器支持该压缩算法。

### 9\.2 读取描述表与索引表

定位到 `universe_desc_offset`，读取 `universe_count × 16` 字节得到所有 Universe 信息，动态创建输出缓冲区，并记录各 Universe 对应的 net、subuni 用于后续封装 ArtNet 包；再定位到 `frame_index_offset`，读取 `frame_count × 16` 字节索引数组并全部加载到内存，同时校验索引是否按 `time_us` 升序，无序则判定文件损坏。

### 9\.3 时间驱动回放主循环

回放主循环以当前播放相对时间 `now_us` 为输入：在索引数组中二分查找最大的满足 `index[i].time_us <= now_us` 的记录；据此得到 `chunk_pos` 与 `chunk_cmp_len`，定位到 `chunk_pool_offset + chunk_pos`；读取 8 字节 ChunkHdr 与 `payload_cmp_sz` 字节压缩 Payload；按压缩算法解压并校验 CRC16；按 UniDesc 顺序拆分 Payload，分发到各 Universe 的 DMX 缓冲区；封装 ArtNet 数据包向外发送。当 `now_us` 达到 `total_duration_us` 时，根据 LOOP\_PLAY 标记选择停止或重置时间为 0 循环播放。

二分查找是回放的核心优势，支持任意拖拽时间点随机定位节目，无需顺序扫描整个文件。

## 10 差分帧扩展规范（可选）

差分帧（chunk\_type=1）仅在 flags 的 bit2 ALLOW\_DIFF\_FRAME 置位时启用；老解析器识别到该标志位为 1 且自身不支持差分帧时，应直接拒绝打开，避免错误解析。差分帧适用于通道变化极少的节目，录制侧维护回放影子缓冲区，差分帧只存储变更点，进一步缩小文件体积。其具体 Payload 布局见 6\.2 节。

## 11 校验、容错与错误处理策略

|场景|处理策略|
|---|---|
|文件头不合法|直接返回文件格式错误|
|Chunk CRC 校验失败|上报日志；可选严格模式（停止回放）或演出容错模式（推荐，丢弃本块、继续使用上一帧数据、跳到下一个索引）|
|索引时间戳无序|判定文件损坏|
|解压失败（Zstd 解码错误）|同 CRC 失败处理策略|
|文件级校验|不做文件全局 CRC，采用分层校验：头部校验（可选）\+ 每 Chunk 独立 CRC16|

## 12 C 头文件定义（artrec\.h）

```c
#ifndef ARTREC_H
#define ARTREC_H

#include <stdint.h>

#define ARTREC_MAGIC0   'A'
#define ARTREC_MAGIC1   'R'
#define ARTREC_MAGIC2   'T'
#define ARTREC_MAGIC3   'R'
#define ARTREC_ENDIAN_TAG 0xAA55

#define ARTREC_COMPRESS_NONE    0
#define ARTREC_COMPRESS_ZSTD    1

#define ARTREC_FLAG_LOOP        (1U << 0)
#define ARTREC_FLAG_SMPTE       (1U << 1)
#define ARTREC_FLAG_DIFF_FRAME  (1U << 2)

#define ARTREC_CHUNK_FULL       0
#define ARTREC_CHUNK_DIFF       1

#pragma pack(push, 1)
typedef struct {
    uint8_t     magic[4];
    uint16_t    endian_tag;
    uint16_t    ver_major;
    uint16_t    ver_minor;
    uint32_t    flags;
    uint64_t    rec_start_us;
    uint64_t    total_duration_us;
    uint32_t    universe_count;
    uint32_t    frame_count;
    uint32_t    universe_desc_offset;
    uint32_t    frame_index_offset;
    uint32_t    chunk_pool_offset;
    uint8_t     compress_algo;
    uint8_t     compress_level;
    uint16_t    reserved0;
    uint8_t     reserved[34];
} ArtRecFileHeader;

typedef struct {
    uint16_t    net;
    uint16_t    subuni;
    uint16_t    universe;
    uint16_t    dmx_len;
    uint32_t    reserved;
} ArtRecUniDesc;

typedef struct {
    uint64_t    time_us;
    uint32_t    chunk_pos;
    uint16_t    chunk_cmp_len;
    uint16_t    reserved;
} ArtRecFrameIndex;

typedef struct {
    uint16_t    chunk_type;
    uint16_t    payload_raw_sz;
    uint16_t    payload_cmp_sz;
    uint16_t    crc16;
} ArtRecChunkHdr;
#pragma pack(pop)

#endif
```

## 13 示例推演

以录制 2 路 Universe（Uni0、Uni1，各 512 通道）、共 3 帧、Zstd 压缩、不循环播放为例，演算各分区偏移。默认排布下各分区起始偏移为：

- universe\_desc\_offset = 64

- frame\_index\_offset   = 64 \+ 2 × 16 = 96

- chunk\_pool\_offset    = 96 \+ 3 × 16 = 144

|分区|起始偏移|结束偏移|占用字节|
|---|---|---|---|
|A区 文件头|0|63|64|
|B区 Universe 表（2×16）|64|95|32|
|C区 帧索引表（3×16）|96|143|48|
|D区 ChunkPool|144|—|—|

假设 D 区三个 Chunk 压缩后总长度分别为 120、115、125 字节，则它们相对于块池的偏移分别为 0、120、235。

|索引|time\_us|chunk\_pos|chunk\_cmp\_len|
|---|---|---|---|
|索引0|0|0|120|
|索引1|25000|120|115|
|索引2|50000|235|125|

读取 Chunk1 的文件内绝对偏移为 `chunk_pool_offset(144) + chunk_pos(120) = 264`。

## 14 移植与性能建议

### 14\.1 录制端（PC）

录制端使用官方 libzstd 库，压缩等级建议 L2\~L4；索引表可整体加载到内存，二分查找开销可忽略；可附带预览工具，将时间线导出为 CSV 便于人工检查。

### 14\.2 回放端（嵌入式）

回放端可使用 zstd‑small / zstd‑minimal 精简版本，关闭字典等高级功能；压缩等级建议 L1 以保证极快解压速度。索引表帧数即使上万条占用也很小（1 万帧仅 160KB），RAM 压力低。文件介质可采用 SD 卡 / SPI Flash / FATFS 文件系统，FATFS 的 lseek 开销低，适合随机访问。

### 14\.3 编码取舍提醒

不要使用 Protobuf、TLV 替代本方案：TLV 解析开销高，不适合高速灯光流。本方案属于静态自描述二进制容器，速度优先，元数据集中、易于调试。抓包文件（pcap）只适合调试，不适合节目存储；ArtRec 剥离 IP/UDP 冗余，只保留 DMX 有效载荷与时间轴。

## 15 版本迭代规则

|升级类型|触发场景|旧解析器行为|
|---|---|---|
|ver\_major\+1（破坏性升级）|结构体字段删除、顺序改动；存储字节序规则变更；索引/Chunk 布局大改|直接拒绝打开高 major 文件|
|ver\_minor\+1（兼容扩展）|新增 flags 位；启用 reserved 预留字段；新增可选扩展块（如 SMPTE）|忽略不认识的 flag，正常播放基础 DMX 帧|

通过主版本与次版本的分级管理，本格式可在长期迭代中保持向后兼容。

> （注：部分内容由豆包工作 AI 生成）
