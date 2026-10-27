# 华为云 IoTDA 物模型设计与详细格式参考

> 文档定位：面向架构设计、设备接入、IoT
> 平台研发、后端开发和设备固件开发人员的华为云 IoTDA 物模型（Product
> Model / Device Profile）完整设计参考。
>
> 资料基线：以华为云 IoTDA 官方公开文档为准，重点覆盖当前 V5 产品模型
> API 与官方离线产品模型文件格式。由于华为文档中存在历史/离线格式与 V5
> API 格式并存的情况，本文明确区分二者，不将字段直接混用。
>
> 建议：正式项目落地时，以当前区域 IoTDA 控制台及对应 API Reference
> 的实际版本为最终约束。

------------------------------------------------------------------------

## 1. 物模型是什么

华为云 IoTDA 将产品模型（Product
Model），也称物模型，用于描述一类设备具备的能力和特性，使物联网平台能够理解设备支持的服务、属性、命令和相关数据结构。

一个产品代表一类具有相同能力或特征的设备；产品模型则定义这类设备的抽象能力。

核心层次可以理解为：

``` text
产品 Product
├── 产品基本信息
│   ├── product_id
│   ├── name
│   ├── device_type
│   ├── protocol_type
│   ├── data_format
│   ├── manufacturer_name
│   ├── industry
│   └── description
│
└── 服务能力 Service Capability
    ├── Service 1
    │   ├── Properties 属性
    │   ├── Commands 命令
    │   │   ├── Parameters
    │   │   └── Responses
    │   └── Events 事件
    │       └── Parameters
    │
    ├── Service 2
    └── ...
```

官方文档将服务定义为设备业务能力的拆分单元；一个服务可以包含属性、命令和事件等能力。

------------------------------------------------------------------------

# 2. 物模型的核心概念

## 2.1 Product

产品是同类设备的集合。

例如：

-   温湿度传感器
-   智能电表
-   路灯控制器
-   水表
-   空调
-   充电桩
-   PLC 网关

产品层主要解决：

> "这是什么设备，以及它属于哪一种产品模型？"

------------------------------------------------------------------------

## 2.2 Service

Service 是设备业务能力的逻辑分组。

例如智能空调可以设计为：

``` text
AirConditioner
├── Basic
├── Environment
├── AirConditioning
├── Power
├── Alarm
└── Connectivity
```

一个服务可以只包含属性，也可以只包含命令，也可以同时包含属性、命令。

设计时建议：

-   按业务能力拆分
-   避免一个 Service 包含几十上百个无关属性
-   不要为了字段少而把所有内容放到 Basic
-   Service ID 一旦投入生产，应尽量保持稳定
-   Service 应具有明确的语义边界

------------------------------------------------------------------------

## 2.3 Property

Property 表示设备的状态、测量值、配置值或可访问数据。

例如：

``` text
temperature
humidity
batteryLevel
power
switch
mode
targetTemperature
```

属性通常对应设备影子中的数据。

典型访问模式：

  Method   含义
  -------- ----------------------------------
  R        属性可读
  W        属性可写
  E        属性可订阅，即属性变化时上报事件
  RW       可读可写
  RE       可读可订阅
  WE       可写可订阅
  RWE      可读可写可订阅

注意：

`method` 是物模型的能力定义，不等同于某一次 MQTT/HTTP 消息。

------------------------------------------------------------------------

## 2.4 Command

Command 表示平台/应用可以主动调用的设备功能。

例如：

``` text
REBOOT
SET_TARGET_TEMPERATURE
SET_MODE
OPEN_VALVE
CLOSE_VALVE
START_CHARGE
STOP_CHARGE
```

Command 通常包含：

``` text
Command
├── command_name
├── paras
│   ├── para_name
│   ├── data_type
│   ├── required
│   ├── enum_list
│   ├── min
│   ├── max
│   ├── max_length
│   ├── step
│   ├── unit
│   └── description
│
└── responses
    ├── response_name
    └── paras
```

------------------------------------------------------------------------

## 2.5 Event

Event 表示设备运行过程中发生的事件。

例如：

``` text
OVER_TEMPERATURE
LOW_BATTERY
DOOR_OPEN
FAULT
OFFLINE
SMOKE_ALARM
CHARGING_STARTED
CHARGING_FINISHED
```

事件通常包含事件参数。

需要特别注意：华为云当前产品管理 API 的数据结构中保留了 `events`，但官方
API
文档同时明确指出，目前创建/修改产品时暂未支持自定义事件，因此创建/修改产品时无需定义该字段。不要把
API 中出现的 events 字段误认为当前所有 IoTDA
产品都可以直接使用自定义事件。

------------------------------------------------------------------------

# 3. 两种物模型 JSON 视角

这是设计华为 IoTDA 物模型时最容易踩坑的地方。

华为官方资料存在两类常见格式：

## 3.1 离线产品模型文件格式

官方离线开发文档使用：

``` text
deviceType
manufacturerId
manufacturerName
protocolType
serviceTypeCapabilities

serviceType
description
properties
propertyName
dataType
commands
commandName
paras
paraName
responses
responseName
```

典型文件包括：

``` text
devicetype-capability.json
servicetype-capability.json
```

并要求按照指定目录结构打包 ZIP。

------------------------------------------------------------------------

## 3.2 V5 产品模型 API 格式

当前 V5 产品管理 API 使用：

``` text
product_id
name
device_type
protocol_type
data_format
manufacturer_name
industry
description
service_capabilities

service_id
service_type
properties
property_name
data_type
commands
command_name
paras
para_name
responses
response_name
events
event_type
```

因此：

``` text
离线模型字段              V5 API 字段
------------------------------------------------
deviceType             -> device_type
manufacturerId         -> 产品模型/厂商标识相关信息
manufacturerName       -> manufacturer_name
protocolType           -> protocol_type
serviceType            -> service_type
propertyName           -> property_name
dataType               -> data_type
commandName            -> command_name
paraName               -> para_name
responseName           -> response_name
```

**不要直接把 V5 API JSON 保存成官方离线模型 ZIP 文件，也不要把离线模型
JSON 原样当作 V5 API Body。**

------------------------------------------------------------------------

# 4. V5 Product Model 完整结构

V5 创建产品的总体结构可以抽象为：

``` json
{
  "product_id": "product-id",
  "name": "Thermometer",
  "device_type": "Thermometer",
  "protocol_type": "MQTT",
  "data_format": "json",
  "manufacturer_name": "ExampleVendor",
  "industry": "smartCity",
  "description": "Temperature sensor",
  "service_capabilities": [
    {
      "service_id": "Environment",
      "service_type": "Environment",
      "properties": [],
      "commands": [],
      "events": [],
      "description": "Environment measurements",
      "option": "Mandatory"
    }
  ]
}
```

------------------------------------------------------------------------

# 5. Product 顶层字段

  ------------------------------------------------------------------------------------------------------
  字段                   类型                              必选 说明
  ---------------------- ---------------- --------------------- ----------------------------------------
  product_id             String                              否 产品
                                                                ID；资源空间内唯一；不携带时由平台分配

  name                   String                              是 产品名称

  device_type            String                              是 设备类型

  protocol_type          String                              是 设备协议

  data_format            String                              是 数据格式：json / binary

  manufacturer_name      String                              否 厂商名称

  industry               String                              否 所属行业

  description            String                              否 产品描述

  service_capabilities   Array                               否 服务能力列表
  ------------------------------------------------------------------------------------------------------

官方 V5 API 中，`protocol_type` 支持：

``` text
MQTT
CoAP
HTTP
HTTPS
Modbus
ONVIF
OPC-UA
OPC-DA
TCP
UDP
Other
```

`data_format` 支持：

``` text
json
binary
```

------------------------------------------------------------------------

# 6. ServiceCapability 完整结构

``` json
{
  "service_id": "Environment",
  "service_type": "Environment",
  "properties": [],
  "commands": [],
  "events": [],
  "description": "Environment data",
  "option": "Mandatory"
}
```

字段：

  -----------------------------------------------------------------------------------------------------------
  字段             类型                              必选 说明
  ---------------- ---------------- --------------------- ---------------------------------------------------
  service_id       String                              是 服务 ID，同一产品内不能重复

  service_type     String                              是 服务类型

  properties       Array                               否 服务属性列表

  commands         Array                               否 服务命令列表

  events           Array                               否 服务事件列表；当前创建/修改产品暂不支持自定义事件

  description      String                              否 服务描述

  option           String                              否 服务选项
  -----------------------------------------------------------------------------------------------------------

`option`：

``` text
Master
Mandatory
Optional
```

官方说明中该字段目前主要起标识作用，默认值为 `Optional`。

------------------------------------------------------------------------

# 7. ServiceProperty 完整结构

V5 API 的属性可以抽象为：

``` json
{
  "property_name": "temperature",
  "data_type": "decimal",
  "required": true,
  "enum_list": null,
  "min": "-40",
  "max": "85",
  "max_length": 16,
  "step": 0.1,
  "unit": "C",
  "method": "R",
  "description": "Ambient temperature",
  "default_value": null
}
```

完整字段：

  字段            类型        必选 说明
  --------------- --------- ------ --------------------------
  property_name   String        是 属性名称
  data_type       String        是 数据类型
  required        Boolean       否 属性是否必选，默认 false
  enum_list       Array         否 枚举值列表
  min             String        否 最小值
  max             String        否 最大值
  max_length      Integer       否 最大长度
  step            Double        否 步长
  unit            String        否 单位
  method          String        是 属性访问模式
  description     String        否 属性描述
  default_value   Object        否 默认值

------------------------------------------------------------------------

# 8. 属性 data_type

V5 API 支持：

``` text
int
long
decimal
string
DateTime
jsonObject
enum
boolean
string list
```

含义：

  类型          含义         推荐场景
  ------------- ------------ ------------------------------
  int           整数         次数、状态码、计数
  long          长整型       累计量、计数器、时间戳类数值
  decimal       小数         温度、电压、电流、比例
  string        字符串       序列号、名称、文本
  DateTime      日期时间     时间数据
  jsonObject    JSON 对象    复杂扩展结构
  enum          枚举         模式、状态
  boolean       布尔         开关、使能
  string list   字符串数组   标签、列表

------------------------------------------------------------------------

# 9. 属性范围设计

## 9.1 min / max

用于约束数值型属性。

例如：

``` json
{
  "property_name": "temperature",
  "data_type": "decimal",
  "min": "-40",
  "max": "85"
}
```

推荐：

``` text
min <= 实际值 <= max
```

------------------------------------------------------------------------

## 9.2 step

官方 API 中支持 `step`。

但离线产品模型开发文档指出，在离线模型的相关字段中 step 暂不使用，可填
0。

因此项目设计建议：

-   如果使用 V5 API，按 API 定义填写真实步长；
-   如果使用旧/离线模型文件，遵循该格式对应文档的要求；
-   不要把两个格式的约束规则混用。

------------------------------------------------------------------------

## 9.3 max_length

用于字符串、字符串列表、DateTime 等类型的长度约束。

不要用 `max_length` 表示数值最大值。

错误：

``` json
{
  "data_type": "decimal",
  "max_length": 100
}
```

正确思路：

``` json
{
  "data_type": "decimal",
  "min": "-40",
  "max": "85"
}
```

------------------------------------------------------------------------

# 10. enum_list

枚举属性推荐使用：

``` json
{
  "property_name": "mode",
  "data_type": "enum",
  "enum_list": [
    "AUTO",
    "COOL",
    "HEAT",
    "DRY",
    "FAN"
  ]
}
```

注意：

-   `enum_list` 应与 `data_type=enum` 配套使用；
-   枚举值必须稳定；
-   不建议用中文作为设备协议枚举值；
-   枚举值不要随意改变语义；
-   新增枚举值通常比修改已有枚举值更安全。

------------------------------------------------------------------------

# 11. default_value

V5 API 支持属性默认值。

例如：

``` json
{
  "property_name": "targetTemperature",
  "data_type": "decimal",
  "default_value": 24
}
```

官方说明：如果设置默认值，使用该产品创建设备时，会将属性默认值写入设备影子预期数据，设备上线后可以将该属性默认值下发给设备。

因此：

``` text
产品默认值
    ↓
设备创建
    ↓
设备影子预期数据
    ↓
设备上线
    ↓
平台下发
    ↓
设备执行
```

建议只给真正安全的默认配置设置 default_value。

例如：

``` text
targetTemperature = 24     可以考虑
reportInterval = 60        可以考虑
motorSpeed = 100           需要谨慎
valveOpen = true           通常不建议
```

------------------------------------------------------------------------

# 12. Command 完整结构

``` json
{
  "command_name": "SET_TARGET_TEMPERATURE",
  "paras": [
    {
      "para_name": "temperature",
      "required": true,
      "data_type": "decimal",
      "enum_list": null,
      "min": "16",
      "max": "30",
      "max_length": 0,
      "step": 0.5,
      "unit": "C",
      "description": "Target temperature"
    }
  ],
  "responses": [
    {
      "response_name": "SET_TARGET_TEMPERATURE_RSP",
      "paras": [
        {
          "para_name": "result",
          "required": true,
          "data_type": "boolean",
          "description": "Command result"
        }
      ]
    }
  ]
}
```

------------------------------------------------------------------------

# 13. Command 字段

  字段           类型       必选 说明
  -------------- -------- ------ ------------------------------
  command_name   String       是 命令名称，同一服务内不能重复
  paras          Array        否 命令参数
  responses      Array        否 命令响应

------------------------------------------------------------------------

# 14. Command Parameter

命令参数结构：

``` json
{
  "para_name": "temperature",
  "required": true,
  "data_type": "decimal",
  "enum_list": null,
  "min": "16",
  "max": "30",
  "max_length": 0,
  "step": 0.5,
  "unit": "C",
  "description": "Target temperature"
}
```

字段：

  字段          类型        必选 说明
  ------------- --------- ------ --------------
  para_name     String        是 参数名称
  required      Boolean       否 是否必选
  data_type     String        是 参数数据类型
  enum_list     Array         否 枚举值
  min           String        否 最小值
  max           String        否 最大值
  max_length    Integer       否 最大长度
  step          Double        否 步长
  unit          String        否 单位
  description   String        否 参数描述

命令参数的数据类型与属性参数基本一致：

``` text
int
long
decimal
string
DateTime
jsonObject
enum
boolean
string list
```

------------------------------------------------------------------------

# 15. Command Response

响应结构：

``` json
{
  "response_name": "ACK",
  "paras": [
    {
      "para_name": "result",
      "required": true,
      "data_type": "boolean",
      "description": "Execution result"
    }
  ]
}
```

字段：

  字段            类型       必选 说明
  --------------- -------- ------ ----------
  response_name   String       是 响应名称
  paras           Array        否 响应参数

建议：

``` text
命令名：
SET_TARGET_TEMPERATURE

响应：
SET_TARGET_TEMPERATURE_RSP
```

或者：

``` text
ACK
```

不要同时存在大量语义重复的响应。

------------------------------------------------------------------------

# 16. Event

V5 API 中事件结构为：

``` json
{
  "event_type": "OVER_TEMPERATURE",
  "paras": [
    {
      "para_name": "temperature",
      "required": true,
      "data_type": "decimal",
      "min": "85",
      "unit": "C",
      "description": "Current temperature"
    }
  ]
}
```

字段：

  字段         类型       必选 说明
  ------------ -------- ------ ------------------------------
  event_type   String       是 事件类型，同一服务内不能重复
  paras        Array        否 事件参数

但当前官方 CreateProduct / UpdateProduct API 文档说明：

> 自定义事件目前暂未支持，创建/修改产品时无需定义 events。

因此：

**架构上可以预留 Event 层，但不要假设当前 IoTDA API
一定允许自定义事件落地。**

------------------------------------------------------------------------

# 17. 官方离线模型格式

离线模型主要包含：

``` text
deviceType-capability
serviceType-capability
```

官方要求：

``` text
设备类型文件：
devicetype-capability.json

服务能力文件：
servicetype-capability.json
```

产品模型完成后需要按官方目录层级组织并 ZIP 压缩。

------------------------------------------------------------------------

# 18. devicetype-capability.json

官方示例结构核心为：

``` json
{
  "devices": [
    {
      "manufacturerId": "TestUtf8ManuId",
      "manufacturerName": "HZYB",
      "protocolType": "CoAP",
      "deviceType": "WaterMeter",
      "serviceTypeCapabilities": [
        {
          "serviceType": "WaterMeterBasic"
        },
        {
          "serviceType": "WaterMeterAlarm"
        },
        {
          "serviceType": "Battery"
        }
      ]
    }
  ]
}
```

其中：

``` text
manufacturerId
manufacturerName
protocolType
deviceType
serviceTypeCapabilities
```

用于描述设备类型与服务类型的关系。

------------------------------------------------------------------------

# 19. servicetype-capability.json

官方离线服务模型核心结构：

``` json
{
  "services": [
    {
      "serviceType": "WaterMeterBasic",
      "description": "WaterMeterBasic",
      "properties": [
        {
          "propertyName": "flow",
          "dataType": "decimal",
          "required": false,
          "min": "0",
          "max": "100000",
          "step": 0,
          "method": "R",
          "unit": "L",
          "maxLength": 16,
          "enumList": null
        }
      ],
      "commands": [
        {
          "commandName": "SET_PRESSURE_READ_PERIOD",
          "paras": [
            {
              "paraName": "value",
              "dataType": "int",
              "required": true,
              "min": 1,
              "max": 24,
              "step": 1,
              "maxLength": 10,
              "unit": "hour",
              "enumList": null
            }
          ],
          "responses": [
            {
              "responseName": "SET_PRESSURE_READ_PERIOD_RSP",
              "paras": []
            }
          ]
        }
      ]
    }
  ]
}
```

------------------------------------------------------------------------

# 20. 离线模型属性字段

官方离线模型常见属性字段：

  字段           含义
  -------------- ----------
  propertyName   属性名称
  dataType       数据类型
  required       是否必选
  min            最小值
  max            最大值
  step           步长
  method         访问模式
  unit           单位
  maxLength      最大长度
  enumList       枚举值

其中 `method`：

``` text
R
W
E
RW
RE
WE
RWE
```

------------------------------------------------------------------------

# 21. 离线模型命令字段

``` text
commands
└── commandName
    ├── paras
    │   ├── paraName
    │   ├── dataType
    │   ├── required
    │   ├── min
    │   ├── max
    │   ├── step
    │   ├── maxLength
    │   ├── unit
    │   └── enumList
    │
    └── responses
        └── responseName
            └── paras
```

------------------------------------------------------------------------

# 22. 离线模型数据类型

官方离线开发文档明确涉及：

``` text
string
int
string list
decimal
DateTime
jsonObject
enum
boolean
```

复杂类型：

### string list

``` json
[
  "str1",
  "str2",
  "str3"
]
```

### DateTime

离线模型文档中的示例格式：

``` text
yyyyMMdd'T'HHmmss'Z'
```

例如：

``` text
20151212T121212Z
```

### jsonObject

自定义 JSON 结构。

平台不解析内部业务结构，仅进行透传。

------------------------------------------------------------------------

# 23. 命名规范

华为官方离线模型文档建议：

## deviceType

首字母大写：

``` text
WaterMeter
SmartLight
AirConditioner
```

## serviceType

首字母大写：

``` text
WaterMeterBasic
Battery
Connectivity
Environment
```

## serviceId

首字母大写：

``` text
WaterMeter
Battery
Environment
```

## property

第一个单词小写，其余单词首字母大写：

``` text
batteryLevel
internalTemperature
targetTemperature
currentPower
```

即 camelCase。

## command

大写 + 下划线：

``` text
DISCOVERY
CHANGE_COLOR
SET_TARGET_TEMPERATURE
START_CHARGE
```

------------------------------------------------------------------------

# 24. 物模型整体结构图

``` mermaid
flowchart TD
    Product[Product 产品]
    Product --> Info[产品基本信息]
    Product --> Services[Service Capabilities]

    Info --> DeviceType[device_type]
    Info --> Protocol[protocol_type]
    Info --> Format[data_format]
    Info --> Manufacturer[manufacturer_name]
    Info --> Industry[industry]

    Services --> Service[Service]
    Service --> Properties[Properties]
    Service --> Commands[Commands]
    Service --> Events[Events]

    Properties --> Property[Property]
    Property --> DataType[data_type]
    Property --> Constraint[约束]
    Property --> Method[method]
    Property --> Default[default_value]

    Commands --> Command[Command]
    Command --> Params[Parameters]
    Command --> Responses[Responses]

    Params --> Param[Parameter]
    Responses --> Response[Response]
    Response --> ResponseParams[Response Parameters]

    Events --> Event[Event]
    Event --> EventParams[Event Parameters]
```

------------------------------------------------------------------------

# 25. IoTDA 物模型与设备通信关系

``` mermaid
sequenceDiagram
    participant Device as 设备
    participant IoT as IoTDA
    participant App as 应用

    Device->>IoT: 属性上报
    IoT->>IoT: 根据 Product Model 校验/解析
    IoT->>App: 数据流转/订阅/查询

    App->>IoT: 属性设置
    IoT->>Device: properties/set
    Device-->>IoT: 执行结果

    App->>IoT: Command
    IoT->>Device: command
    Device-->>IoT: command response

    Device->>IoT: Event / 设备事件
    IoT->>App: 事件通知
```

------------------------------------------------------------------------

# 26. 属性上报消息

典型 MQTT/HTTPS 数据结构：

``` json
{
  "services": [
    {
      "service_id": "Environment",
      "properties": {
        "temperature": 26.5,
        "humidity": 65.2
      },
      "event_time": "2026-10-06T02:00:00.000Z"
    }
  ]
}
```

核心：

``` text
services[]
├── service_id
├── properties
└── event_time
```

官方 HTTPS 设备属性上报接口也采用这一结构。

------------------------------------------------------------------------

# 27. 属性上报设计建议

推荐：

``` json
{
  "services": [
    {
      "service_id": "Environment",
      "properties": {
        "temperature": 26.5,
        "humidity": 65.2
      },
      "event_time": "2026-10-06T02:00:00.000Z"
    }
  ]
}
```

而不是：

``` json
{
  "temperature": 26.5,
  "humidity": 65.2
}
```

原因：

-   service_id 是物模型命名空间
-   不同 Service 可以出现相同语义字段
-   有利于模型演进
-   有利于设备影子组织
-   有利于应用侧按服务消费

------------------------------------------------------------------------

# 28. 属性下发

典型：

``` json
{
  "services": [
    {
      "service_id": "Temperature",
      "properties": {
        "value": 57
      }
    },
    {
      "service_id": "Battery",
      "properties": {
        "level": 80
      }
    }
  ]
}
```

MQTT Topic 典型形式：

``` text
$oc/devices/{device_id}/sys/properties/set/request_id={request_id}
```

设备响应：

``` json
{
  "result_code": 0,
  "result_desc": "success"
}
```

------------------------------------------------------------------------

# 29. 设备影子与物模型

建议理解为：

``` text
物模型
  │
  │ 定义结构
  ▼
设备影子
  │
  ├── 实际数据
  └── 预期数据
```

物模型解决：

> 数据是什么？

设备影子解决：

> 当前设备状态是什么？

例如：

``` text
物模型：
targetTemperature = decimal / RW / C

设备影子：
targetTemperature = 24
```

两者不能混淆。

------------------------------------------------------------------------

# 30. 推荐的企业级物模型分层

对于中大型 IoT 项目，推荐：

``` text
Service
├── Basic
├── Connectivity
├── Environment
├── Measurement
├── Control
├── Configuration
├── Alarm
├── Energy
└── Diagnostics
```

但不是所有产品都必须拥有这些服务。

------------------------------------------------------------------------

# 31. Basic Service

推荐存放：

``` text
deviceStatus
deviceModel
hardwareVersion
softwareVersion
firmwareVersion
serialNumber
```

注意：

不要把大量业务数据都放进 Basic。

------------------------------------------------------------------------

# 32. Connectivity Service

推荐：

``` text
networkType
signalStrength
ipAddress
linkStatus
lastConnectedTime
```

如果涉及敏感网络信息，应考虑是否真的需要建模并上报。

------------------------------------------------------------------------

# 33. Environment Service

环境类设备：

``` text
temperature
humidity
pressure
co2
pm25
voc
noise
illuminance
```

例如：

``` json
{
  "service_id": "Environment",
  "properties": [
    {
      "property_name": "temperature",
      "data_type": "decimal",
      "unit": "C",
      "method": "R"
    },
    {
      "property_name": "humidity",
      "data_type": "decimal",
      "unit": "%",
      "method": "R"
    }
  ]
}
```

------------------------------------------------------------------------

# 34. Control Service

控制能力建议独立。

例如：

``` text
switch
mode
targetTemperature
fanSpeed
brightness
```

命令：

``` text
REBOOT
CALIBRATE
START
STOP
RESET
```

原则：

-   状态优先用 Property
-   动作优先用 Command
-   变化通知优先考虑 Event/事件机制
-   不要用 Command 代替长期状态

------------------------------------------------------------------------

# 35. Property 与 Command 的边界

推荐：

``` text
“当前开关状态是什么？”
    → Property

“把开关状态设置为 ON”
    → Property W/RW

“重启设备”
    → Command

“恢复出厂设置”
    → Command

“发生过温报警”
    → Event / 事件
```

这是非常重要的建模原则。

------------------------------------------------------------------------

# 36. Property 与 Event 的边界

例如：

``` text
temperature = 90
```

表示状态/测量值。

而：

``` text
OVER_TEMPERATURE
```

表示一个业务事件。

推荐：

``` text
Environment
├── temperature
└── humidity

Alarm
├── alarmStatus
└── alarmCode
```

如果平台能力允许事件机制，再将：

``` text
OVER_TEMPERATURE
```

作为事件。

------------------------------------------------------------------------

# 37. 推荐的设备物模型示例

以下以智能空调为例。

``` json
{
  "product_id": "SmartAirConditioner",
  "name": "Smart Air Conditioner",
  "device_type": "AirConditioner",
  "protocol_type": "MQTT",
  "data_format": "json",
  "manufacturer_name": "ExampleVendor",
  "industry": "HomeAppliance",
  "description": "Smart air conditioner product model",
  "service_capabilities": [
    {
      "service_id": "Basic",
      "service_type": "Basic",
      "properties": [
        {
          "property_name": "power",
          "data_type": "boolean",
          "required": true,
          "method": "RW",
          "description": "Power state"
        },
        {
          "property_name": "mode",
          "data_type": "enum",
          "required": true,
          "enum_list": [
            "AUTO",
            "COOL",
            "HEAT",
            "DRY",
            "FAN"
          ],
          "method": "RW",
          "description": "Operating mode"
        }
      ],
      "commands": [
        {
          "command_name": "REBOOT",
          "paras": [],
          "responses": [
            {
              "response_name": "REBOOT_RSP",
              "paras": [
                {
                  "para_name": "result",
                  "required": true,
                  "data_type": "boolean",
                  "description": "Execution result"
                }
              ]
            }
          ]
        }
      ],
      "description": "Basic device functions",
      "option": "Mandatory"
    },
    {
      "service_id": "Environment",
      "service_type": "Environment",
      "properties": [
        {
          "property_name": "indoorTemperature",
          "data_type": "decimal",
          "required": true,
          "min": "-20",
          "max": "60",
          "step": 0.1,
          "unit": "C",
          "method": "R",
          "description": "Indoor temperature"
        },
        {
          "property_name": "indoorHumidity",
          "data_type": "decimal",
          "required": false,
          "min": "0",
          "max": "100",
          "step": 0.1,
          "unit": "%",
          "method": "R",
          "description": "Indoor humidity"
        }
      ],
      "commands": [],
      "description": "Indoor environment",
      "option": "Mandatory"
    },
    {
      "service_id": "Control",
      "service_type": "Control",
      "properties": [
        {
          "property_name": "targetTemperature",
          "data_type": "decimal",
          "required": false,
          "min": "16",
          "max": "30",
          "step": 0.5,
          "unit": "C",
          "method": "RW",
          "description": "Target temperature",
          "default_value": 24
        },
        {
          "property_name": "fanSpeed",
          "data_type": "enum",
          "required": false,
          "enum_list": [
            "AUTO",
            "LOW",
            "MEDIUM",
            "HIGH"
          ],
          "method": "RW",
          "description": "Fan speed"
        }
      ],
      "commands": [
        {
          "command_name": "SET_TEMPERATURE",
          "paras": [
            {
              "para_name": "temperature",
              "required": true,
              "data_type": "decimal",
              "min": "16",
              "max": "30",
              "step": 0.5,
              "unit": "C",
              "description": "Target temperature"
            }
          ],
          "responses": [
            {
              "response_name": "SET_TEMPERATURE_RSP",
              "paras": [
                {
                  "para_name": "result",
                  "required": true,
                  "data_type": "boolean",
                  "description": "Execution result"
                }
              ]
            }
          ]
        }
      ],
      "description": "Air conditioner control",
      "option": "Mandatory"
    },
    {
      "service_id": "Diagnostics",
      "service_type": "Diagnostics",
      "properties": [
        {
          "property_name": "faultCode",
          "data_type": "string",
          "max_length": 64,
          "method": "R",
          "description": "Current fault code"
        },
        {
          "property_name": "firmwareVersion",
          "data_type": "string",
          "max_length": 64,
          "method": "R",
          "description": "Firmware version"
        }
      ],
      "commands": [
        {
          "command_name": "CLEAR_FAULT",
          "paras": [],
          "responses": [
            {
              "response_name": "CLEAR_FAULT_RSP",
              "paras": [
                {
                  "para_name": "result",
                  "required": true,
                  "data_type": "boolean",
                  "description": "Execution result"
                }
              ]
            }
          ]
        }
      ],
      "description": "Device diagnostics",
      "option": "Optional"
    }
  ]
}
```

------------------------------------------------------------------------

# 38. 推荐的企业级目录结构

建议不要让业务代码直接散落物模型 JSON。

推荐：

``` text
iot-model/
├── README.md
├── schema/
│   ├── product-model-v1.schema.json
│   └── naming-rules.md
│
├── products/
│   ├── air-conditioner/
│   │   ├── product.json
│   │   ├── services/
│   │   │   ├── basic.json
│   │   │   ├── environment.json
│   │   │   ├── control.json
│   │   │   └── diagnostics.json
│   │   └── versions/
│   │       ├── v1.0.0.json
│   │       └── v1.1.0.json
│   │
│   └── smart-meter/
│       ├── product.json
│       └── services/
│
├── examples/
│   ├── telemetry.json
│   ├── property-set.json
│   └── command.json
│
└── tools/
    ├── validator/
    └── converter/
```

------------------------------------------------------------------------

# 39. 推荐的物模型版本策略

建议采用：

``` text
Product
  │
  ├── Model Version
  │       │
  │       ├── v1.0.0
  │       ├── v1.1.0
  │       └── v2.0.0
  │
  └── Device Firmware Version
          │
          ├── FW 1.x
          └── FW 2.x
```

不要把：

``` text
产品模型版本
```

与：

``` text
固件版本
```

混为一谈。

------------------------------------------------------------------------

# 40. 物模型兼容性原则

建议将变化分成：

## 非破坏性变化

例如：

``` text
新增 Optional Service
新增 Optional Property
新增 Optional Command Parameter
新增枚举值
```

通常兼容性较好。

## 潜在破坏性变化

例如：

``` text
删除 Property
修改 property data_type
修改已有 enum 含义
修改单位
修改 service_id
修改 property_name
修改 command_name
删除 Command
```

这些变化可能直接影响：

-   设备固件
-   应用程序
-   数据平台
-   规则引擎
-   报表
-   数据库
-   设备影子
-   OTA

因此建议进行版本化。

------------------------------------------------------------------------

# 41. 不建议的物模型设计

## 41.1 一个 Service 放所有东西

错误：

``` text
Device
└── Basic
    ├── temperature
    ├── humidity
    ├── battery
    ├── power
    ├── mode
    ├── alarm
    ├── firmware
    ├── network
    ├── ...
```

问题：

-   业务边界不清晰
-   维护困难
-   权限难做
-   应用侧难理解

------------------------------------------------------------------------

# 42. 不建议把所有东西做成 Command

错误：

``` text
GET_TEMPERATURE
GET_HUMIDITY
GET_POWER
GET_STATUS
```

如果这些本质上是设备状态，应优先使用 Property。

------------------------------------------------------------------------

# 43. 不建议把状态做成 Event

错误：

``` text
TEMPERATURE_CHANGED
HUMIDITY_CHANGED
POWER_CHANGED
```

然后完全不保留：

``` text
temperature
humidity
power
```

Event 描述"发生了什么"，Property 描述"现在是什么"。

------------------------------------------------------------------------

# 44. 不建议滥用 jsonObject

虽然：

``` json
{
  "data_type": "jsonObject"
}
```

可以快速解决复杂结构，但过度使用会导致：

``` text
平台无法理解内部字段
↓
无法统一约束
↓
无法形成标准数据资产
↓
应用侧重复解析
↓
模型治理困难
```

建议：

**能用标准 Property 描述，就不要使用 jsonObject。**

只有真正需要扩展、嵌套或厂商私有结构时才使用。

------------------------------------------------------------------------

# 45. 单位设计建议

单位必须稳定。

推荐：

``` text
temperature -> C
humidity -> %
pressure -> Pa
voltage -> V
current -> A
power -> W
energy -> kWh
speed -> m/s
```

不要：

``` text
temperature -> "摄氏度"
```

如果设备协议需要中文展示，应由应用层做国际化。

------------------------------------------------------------------------

# 46. 枚举设计建议

推荐：

``` text
AUTO
COOL
HEAT
DRY
FAN
```

不要：

``` text
0
1
2
3
4
```

除非底层设备协议确实只能使用数字。

如果必须使用数字，建议在模型文档中明确映射：

``` text
0 = AUTO
1 = COOL
2 = HEAT
3 = DRY
4 = FAN
```

------------------------------------------------------------------------

# 47. 时间设计建议

IoT 系统中时间至少需要区分：

``` text
设备采集时间
平台接收时间
事件发生时间
数据库入库时间
```

属性上报中可携带：

``` json
{
  "event_time": "2026-10-06T02:00:00.000Z"
}
```

不要把设备本地时间和 UTC 时间混在一起。

------------------------------------------------------------------------

# 48. 数据流设计

推荐：

``` mermaid
flowchart LR
    Device[设备]
    Protocol[MQTT/CoAP/HTTP]
    IoTDA[IoTDA]
    Model[Product Model]
    Shadow[Device Shadow]
    Stream[Data Flow]
    App[Application]
    DataLake[Data Lake]
    Rule[Rule Engine]

    Device --> Protocol
    Protocol --> IoTDA
    IoTDA --> Model
    Model --> Shadow
    IoTDA --> Stream
    Stream --> App
    Stream --> DataLake
    Stream --> Rule
```

------------------------------------------------------------------------

# 49. 物模型与数据平台建议

物模型不是数据库表结构。

建议：

``` text
IoTDA Model
    ↓
设备数据标准化
    ↓
Data Stream
    ↓
数据湖 / 时序数据库
    ↓
BI / AI / 报表
```

例如：

``` text
IoTDA:
Environment.temperature

数据平台:
device_id
timestamp
temperature
unit
quality
```

不要直接把 IoTDA JSON 当作长期数据仓库 Schema。

------------------------------------------------------------------------

# 50. 物模型与微服务建议

推荐按领域拆：

``` text
iot-device-service
        │
        ├── Product
        ├── Device
        └── Shadow

iot-model-service
        │
        ├── Model
        ├── Service
        ├── Property
        ├── Command
        └── Version

iot-data-service
        │
        ├── Telemetry
        ├── Event
        └── History

iot-command-service
        │
        ├── Command
        ├── Retry
        └── Result
```

这样可以避免 IoTDA API 结构直接侵入所有业务系统。

------------------------------------------------------------------------

# 51. 建议建立 Canonical Model

如果企业未来不希望被单一 IoT 平台锁定，建议增加企业自己的 Canonical
Model。

结构：

``` text
设备
  │
  ▼
企业 Canonical Model
  │
  ├───────────────┐
  ▼               ▼
Huawei IoTDA     Other IoT Platform
  │
  ▼
MQTT/HTTP/...
```

企业内部统一：

``` text
canonical service
canonical property
canonical datatype
canonical unit
canonical command
canonical event
```

然后通过 Adapter 转换到华为 IoTDA。

------------------------------------------------------------------------

# 52. 推荐 Canonical Model

例如：

``` json
{
  "modelVersion": "1.0.0",
  "product": {
    "id": "air-conditioner",
    "name": "Smart Air Conditioner"
  },
  "services": [
    {
      "id": "environment",
      "properties": [
        {
          "id": "temperature",
          "type": "decimal",
          "unit": "C",
          "access": "R"
        }
      ]
    }
  ]
}
```

然后生成：

``` text
Canonical Model
      │
      ├── Huawei IoTDA Adapter
      │       └── V5 API JSON
      │
      ├── MQTT Adapter
      │
      └── Other Platform Adapter
```

这是长期维护最推荐的架构。

------------------------------------------------------------------------

# 53. 推荐模型治理流程

``` mermaid
flowchart TD
    A[业务需求]
    B[能力建模]
    C[Service 划分]
    D[Property/Command/Event 定义]
    E[类型/单位/范围校验]
    F[兼容性检查]
    G[Schema 校验]
    H[代码评审]
    I[测试设备验证]
    J[发布 Model]
    K[生产 IoTDA]

    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    F --> G
    G --> H
    H --> I
    I --> J
    J --> K
```

------------------------------------------------------------------------

# 54. 建议增加自动校验

不要只依赖人工看 JSON。

至少做：

``` text
JSON Syntax
    ↓
Schema Validation
    ↓
Naming Validation
    ↓
Duplicate Validation
    ↓
Type Validation
    ↓
Unit Validation
    ↓
Enum Validation
    ↓
Range Validation
    ↓
Compatibility Validation
```

例如检查：

``` text
同一 Service 中 property_name 是否重复
同一 Service 中 command_name 是否重复
同一 Service 中 event_type 是否重复
enum 是否为空
min <= max
decimal 是否定义合理精度
method 是否合法
data_type 与 enum_list 是否匹配
unit 是否与类型匹配
```

------------------------------------------------------------------------

# 55. 推荐 CI/CD

``` mermaid
flowchart LR
    Dev[开发]
    Git[Git]
    CI[CI]
    Validate[Model Validator]
    Diff[Compatibility Diff]
    Package[Package]
    Test[Integration Test]
    Deploy[IoTDA]
    Prod[Production]

    Dev --> Git
    Git --> CI
    CI --> Validate
    Validate --> Diff
    Diff --> Package
    Package --> Test
    Test --> Deploy
    Deploy --> Prod
```

建议将物模型作为代码管理：

``` text
Model as Code
```

而不是只存在于 IoTDA 控制台。

------------------------------------------------------------------------

# 56. 物模型版本 Diff

建议每次提交输出：

``` text
Model v1.2.0
+
Service Environment
  + property airQuality

Service Control
  + command CALIBRATE
```

以及：

``` text
BREAKING CHANGE

Service Control
  - property targetMode

Reason:
...
Migration:
...
```

------------------------------------------------------------------------

# 57. 设备固件与模型兼容矩阵

建议维护：

  Product Model   Firmware   Compatibility
  --------------- ---------- ---------------
  1.0.0           1.x        Full
  1.1.0           1.x        Compatible
  2.0.0           1.x        Incompatible
  2.0.0           2.x        Full

这是生产环境非常重要的一层。

------------------------------------------------------------------------

# 58. 命令设计建议

Command 应满足：

``` text
有明确动作
有明确输入
有明确执行结果
```

推荐：

``` text
REBOOT
RESET
START
STOP
CALIBRATE
SET_TARGET_TEMPERATURE
```

不推荐：

``` text
DO
ACTION
CONTROL
COMMAND
SET
```

因为语义过于模糊。

------------------------------------------------------------------------

# 59. Command 幂等性

对于：

``` text
SET_TARGET_TEMPERATURE
SET_MODE
SET_SWITCH
```

尽量设计为幂等：

``` text
SET_TARGET_TEMPERATURE(24)
SET_TARGET_TEMPERATURE(24)
```

第二次执行不会产生额外副作用。

而：

``` text
TOGGLE
INCREMENT
DECREMENT
```

天然不幂等，使用时需要更严格的消息重试设计。

------------------------------------------------------------------------

# 60. 命令响应设计

推荐至少有：

``` text
result
errorCode
errorMessage
```

例如：

``` json
{
  "response_name": "SET_TEMPERATURE_RSP",
  "paras": [
    {
      "para_name": "result",
      "data_type": "boolean",
      "required": true
    },
    {
      "para_name": "errorCode",
      "data_type": "string",
      "required": false
    }
  ]
}
```

这样应用层能够区分：

``` text
请求成功
设备执行失败
参数非法
设备忙
设备离线
设备不支持
```

------------------------------------------------------------------------

# 61. 数据类型选择建议

推荐：

``` text
状态开关        -> boolean
工作模式        -> enum
设备状态码      -> enum / int
温度            -> decimal
计数器          -> long
序列号          -> string
版本号          -> string
时间            -> DateTime
复杂扩展        -> jsonObject
```

------------------------------------------------------------------------

# 62. 不要过度建模

例如：

``` text
temperatureCelsius
temperatureFahrenheit
```

通常不建议同时建模。

更好的做法：

``` text
temperature
unit = C
```

然后应用层根据展示需求换算。

------------------------------------------------------------------------

# 63. 单位转换

推荐：

``` text
设备层
    ↓
统一标准单位
    ↓
IoTDA
    ↓
数据平台
    ↓
应用展示层换算
```

例如：

``` text
设备：°F
      ↓
Adapter
      ↓
°C
      ↓
IoTDA
```

这样可以保持平台模型统一。

------------------------------------------------------------------------

# 64. Gateway / 子设备

如果设备是网关：

``` text
Gateway
├── SubDevice A
├── SubDevice B
└── SubDevice C
```

建议：

``` text
Gateway Model
    └── Gateway capabilities

SubDevice Model
    └── Real business capabilities
```

不要把所有子设备能力都塞进网关自己的物模型。

------------------------------------------------------------------------

# 65. 多型号设备

如果：

``` text
AirConditioner-A
AirConditioner-B
AirConditioner-C
```

能力高度相同，建议：

``` text
Base Model
    │
    ├── A
    ├── B
    └── C
```

如果平台侧不能直接继承模型，则通过企业 Canonical Model
实现继承关系，再生成具体 IoTDA Product Model。

------------------------------------------------------------------------

# 66. 设计检查清单

## 产品层

-   [ ] product_id 唯一
-   [ ] name 明确
-   [ ] device_type 明确
-   [ ] protocol_type 正确
-   [ ] data_format 正确
-   [ ] manufacturer_name 明确
-   [ ] industry 明确
-   [ ] description 完整

## Service

-   [ ] service_id 唯一
-   [ ] service_type 稳定
-   [ ] Service 边界明确
-   [ ] option 合理
-   [ ] description 完整

## Property

-   [ ] property_name 唯一
-   [ ] data_type 正确
-   [ ] unit 正确
-   [ ] min/max 合理
-   [ ] step 合理
-   [ ] enum_list 合理
-   [ ] method 正确
-   [ ] required 合理
-   [ ] default_value 安全

## Command

-   [ ] command_name 唯一
-   [ ] 参数完整
-   [ ] 参数类型正确
-   [ ] required 正确
-   [ ] min/max 正确
-   [ ] response 明确
-   [ ] 错误场景可表达
-   [ ] 是否幂等

## 兼容性

-   [ ] 是否删除旧属性
-   [ ] 是否修改 data_type
-   [ ] 是否修改 unit
-   [ ] 是否修改枚举含义
-   [ ] 是否修改 Service ID
-   [ ] 是否修改 Property ID
-   [ ] 是否修改 Command ID

------------------------------------------------------------------------

# 67. 推荐最终架构

综合考虑 IoTDA、设备固件、数据平台和未来多云，我推荐：

``` mermaid
flowchart TB
    Domain[业务能力模型]
    Canonical[企业 Canonical IoT Model]

    Domain --> Canonical

    Canonical --> Huawei[Huawei IoTDA Adapter]
    Canonical --> Other[Other IoT Platform Adapter]
    Canonical --> Data[Data Platform Mapping]

    Huawei --> HuaweiModel[IoTDA Product Model]
    HuaweiModel --> Device[Device]
    Device --> MQTT[MQTT/HTTP/CoAP]

    Data --> TSDB[Time Series DB]
    Data --> Lake[Data Lake]
    Data --> BI[BI/AI]

    Device --> Shadow[Device Shadow]
    Device --> Command[Command]
    Device --> Telemetry[Telemetry]
```

------------------------------------------------------------------------

# 68. 最终推荐的设计原则

## 原则 1：物模型是"能力契约"

不是简单 JSON。

它是：

``` text
设备
+
平台
+
应用
+
数据
```

之间的契约。

------------------------------------------------------------------------

## 原则 2：Property 表示状态

``` text
What is it now?
```

------------------------------------------------------------------------

## 原则 3：Command 表示动作

``` text
What should it do?
```

------------------------------------------------------------------------

## 原则 4：Event 表示发生的事情

``` text
What happened?
```

但当前 IoTDA 自定义事件能力需要以当前区域/API 实际支持情况为准。

------------------------------------------------------------------------

## 原则 5：Service 表示业务边界

不要为了凑结构而创建 Service。

------------------------------------------------------------------------

## 原则 6：单位必须统一

不要让每个设备厂商自由发挥。

------------------------------------------------------------------------

## 原则 7：枚举必须稳定

不要轻易修改已有枚举的业务语义。

------------------------------------------------------------------------

## 原则 8：JSON 是实现，不是模型本身

真正的模型是：

``` text
语义
+
类型
+
约束
+
访问方式
+
生命周期
+
兼容性
```

------------------------------------------------------------------------

## 原则 9：Model as Code

建议：

``` text
Git
+
JSON
+
Schema
+
CI
+
Compatibility Check
+
IoTDA Deployment
```

------------------------------------------------------------------------

## 原则 10：企业内部保留 Canonical Model

如果项目生命周期预计超过 3\~5 年，或者未来存在多云/多 IoT
平台接入需求，强烈建议不要把 IoTDA API JSON 直接作为企业内部唯一模型。

推荐：

``` text
Enterprise Canonical Model
          │
          ├── Huawei IoTDA
          ├── Other IoT Platform
          ├── Data Platform
          └── Device Protocol
```

------------------------------------------------------------------------

# 69. 官方资料参照

以下资料建议作为实际开发时的最终依据：

1.  华为云 IoTDA：什么是产品模型
2.  华为云 IoTDA：在线开发产品模型
3.  华为云 IoTDA：离线开发产品模型
4.  华为云 IoTDA：CreateProduct
5.  华为云 IoTDA：UpdateProduct
6.  华为云 IoTDA：属性下发
7.  华为云 IoTDA：HTTPS 协议接入
8.  华为云 IoTDA：MQTT/MQTTS API

建议重点核对当前区域的 API
Reference，因为华为云不同版本文档存在字段逐步扩展的情况。

------------------------------------------------------------------------

# 70. 关键官方字段总结

## Product

``` text
product_id
name
device_type
protocol_type
data_format
manufacturer_name
industry
description
service_capabilities
```

## Service

``` text
service_id
service_type
properties
commands
events
description
option
```

## Property

``` text
property_name
data_type
required
enum_list
min
max
max_length
step
unit
method
description
default_value
```

## Command

``` text
command_name
paras
responses
```

## Parameter

``` text
para_name
required
data_type
enum_list
min
max
max_length
step
unit
description
```

## Response

``` text
response_name
paras
```

## Event

``` text
event_type
paras
```

------------------------------------------------------------------------

# 71. 最重要的落地结论

如果现在从零设计一个生产级华为 IoTDA 项目，推荐采用：

``` text
                    ┌───────────────────┐
                    │ Enterprise Model  │
                    │ Canonical Model   │
                    └─────────┬─────────┘
                              │
                ┌─────────────┼─────────────┐
                │             │             │
                ▼             ▼             ▼
           Huawei IoTDA   Data Platform   Device
                │
                ▼
        Product Model
                │
        ┌───────┼────────┐
        ▼       ▼        ▼
     Service Property Command
        │                  │
        │                  ├── Parameters
        │                  └── Responses
        │
        └── Device Shadow

Property = 状态
Command  = 动作
Event    = 事件
Service  = 能力边界
Product  = 设备类别
```

最值得坚持的三个原则：

``` text
1. 用 Service 划分能力边界
2. 用 Property / Command / Event 区分状态、动作、事件
3. 企业内部维护 Canonical Model，IoTDA 作为平台适配层
```

------------------------------------------------------------------------

# 72. 参考来源（官方）

-   华为云 IoTDA《什么是产品模型》
-   华为云 IoTDA《在线开发产品模型》
-   华为云 IoTDA《离线开发产品模型》
-   华为云 IoTDA《创建产品 - CreateProduct》
-   华为云 IoTDA《修改产品 - UpdateProduct》
-   华为云 IoTDA《属性下发》
-   华为云 IoTDA《HTTPS 协议接入》
-   华为云 IoTDA《MQTT/MQTTS 接口参考》
