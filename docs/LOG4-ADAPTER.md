# FINDYOU 最新 IPSPOS 接入

2026-10-21，开发构建，应用版本号保持 0.7.3；没有 Git 提交。本轮只修改 FINDYOU。相邻 IPSPOS 的现有修改原样保留，没有再次改写、回退或提交。

本轮完成输入、启动、增量读取、结果持久化及重新打开。新增 PPP／RTK 分析模块和绘图设计留到下一阶段；现有分析页仍有 PPP 的统计口径，不作为完整 RTK 分析验收。

## 运行入口

测试构建位于 `deliverables/log4-adapter/FINDU.exe`，保留同目录配套文件夹。此前 `deliverables/FINDU-0.7.3.exe` 和旧压缩包没有被覆盖。

默认数据、配置、结果、缓存与 WebView2 用户数据均位于程序目录下的 `runtime/`。本轮验收证据在工程根目录的 `runtime/log4-integration-20261021/`。原始 OPT、观测、导航和产品只读。

## 接入边界

```text
FINDYOU 配置副本 / 任务进程 / 外部日志适配
    → 独立 IPSPOS.exe 或 IPSClient.exe
    → IPSPOS 自己的解算与日志实现
```

- 后处理：PPP 动态／静态 `GNSS_PMode=2/3`，RTK 动态／静态／移动基线 `6/7/8`。RTK 必须有 `GNSS_BaseFile`，不要求 PPP 精密产品。
- 实时：PPP 使用观测与改正流；RTK 使用 ROVE 与 BASE，忽略未使用的 PPP 产品配置。支持原 OPT 的基站坐标、采样间隔及未知算法参数。
- 源 OPT 保留。后处理使用 `run.opt`；实时使用 `live.opt`。运行副本的输出、共享星历缓存、停止文件按会话隔离，上传关闭。
- 实时副本固定开启 `GNSS_bOutputLOG=ON` 和 `IPSClient_bStatusLog=ON`，不依赖普通 ULOG 等级。源配置保持不变。
- 正常停止仅使用 `IPSClient_StopFile`。等待超过 8 秒时保留原有进程终止兜底；这不是任意网络状态下的一秒退出承诺。
- 原生进程退出后先刷完尾部、保存会话摘要并完成历史索引，再发布终态，防止立即重启同一方案时覆盖上一运行的收尾信息。
- 不再读取 `monitor.jsonl`，不再向引擎注入 FINDYOU 专用监控／停止环境变量。

## GNSS Log=4

实时和完整结果共用 `src-tauri/src/gnss_log.rs` 的文件头及字段规则，只接受当前 `Log=4`。列按名称解析，不能用固定下标把 PPP 与 RTK 强行套在一起。`Mode` 精确匹配，避免被 `Model` 描述覆盖。

| 分组 | 接入内容 |
|---|---|
| 共用 | UTC、GPS 周／周内秒、XYZ、Q、VQ、卫星数、DOP、后验残差、重置、周跳、Ratio、ADOP、固定与 AR 诊断等原生列 |
| PPP 新增 | ZHD、ZWD、TrpSRMS、IonDRMS、ZWDUCor、IAC50、IAC95 |
| RTK | Com、UDS、SDS、DDS、BaseX／Y／Z、BRAge，以及 RTK 的共用列 |

当前原生 PPP 71 列、RTK 66 列。返回的诊断对象转换 UTC 为 `time`，补充 `solution`；实时对象另带 `solutionMode/logVersion`，因此对象键数不等于原生列数。

- 使用最新列名 `FloIn/FloUse`，移除界面对旧 `FloatIn/FloatUse` 的依赖。
- 区分普通非负统计、坐标、速度、ZWD 和 ZWDUCor 的原生缺测／溢出标志。合法负坐标、负 ZWD、负相关系数保留，`ZWDUCor=-1` 是合法值。
- 未知附加列保留数值或文本，不影响已知字段。缺测返回 null，不补 0。
- Q 原值、无效定位历元诊断与总行数保留。NONE、PRE、缺少 XYZ 等历元不伪造 ENU；FIX 与 HOLD 的原始状态仍分别保留。
- 实时读取等待完整换行，处理文件截断／替换；定位与诊断缓存各有 3600 历元上限。

## Ntrip / 产品 StatusLog=1

文件与 SOL 同在原生 SESSION 目录，使用引擎已有名称规则：`NTRIP_*.log`、`PRODUCT_*.log`。完整原生接口说明见 [IPSClient 接口](IPSPOS-CLIENT-INTERFACE.md)。

| 日志 | 接入字段与语义 |
|---|---|
| NTRIP | Role、State、Error、HTTP、Attempts、Bytes、Frames、HAS、LastArrival、Queued、Committed、Dropped；区分 ROVE／BASE／PRODUCT／BIAS／ATMO |
| PRODUCT | 组件、星座、Decoded、Fresh、Signals、产品 GPST、评估 GPST、有符号 Age |

- `reconnects=max(Attempts-1,0)`；LastArrival=0 表示没有收到数据。空握手和界面轮询不会刷新数据到达时间。
- Ntrip 的 Unix 是本机写出 UTC；产品有独立评估时间。二者分别存为 `streamUnix/productUnix`，不从观测历元推算接收时间。
- Fresh 完全采用 IPSPOS 计算结果，FINDYOU 不复制时效规则，也不把 Fresh 当作当前历元实际使用量或产品源归因。
- 原生状态保留有符号 Age。现有汇总历史按组件合计 Fresh，取绝对值最小的已知 Age 并保留符号；完整星座明细仍在原始日志中。
- RTK 没有 PPP 产品时允许 PRODUCT 仅有文件头，不生成虚假的零覆盖记录。
- 同一秒末次状态替换对应角色／组件，正常退出后再读取已刷新的尾部，避免丢失末次记录。
- 状态解析错误通过 `statusError` 单独报告，不混为定位日志错误。

结果新增 `solutionMode`、`logVersion`、`engineBuildId`、`ntripLogPath`、`productLogPath`、`clientStatus`。历史目录重新打开时读取原生状态日志，保留最终接收状态和产品历史。只有独立 GNSS 日志时，状态字段可为空。

## 替换引擎

只接受当前协议组合 `gnss_log=4 / client_status=1`，不做旧 Log=2 的兼容转换。已有旧历史文件和目录不删除，打开不支持的日志会明确报错。

在 FINDYOU 根目录执行：

```powershell
.\resources\product-runtime\python.exe scripts\prepare-engine.py ..\IPSPOS
pnpm desktop:build
```

`prepare-engine.py` 只读当前引擎工作区，以源码内容建立独立快照和构建缓存；包含用户已确认但尚未提交的接口修改。不会执行 Git 提交、修改源工程或写入相邻仓库的 build。

清单区分基础 Git 提交、`source_modified`、完整源码 SHA-256、构建标识及两个 EXE 的 SHA-256。当前构建标识为 `33075c2a5ac5-source-4486c2394977b328`，版本宏为 `BetaV0.602`，不能把基础提交号当作完整源码身份。启动前检查协议与实际 EXE 哈希；打包同步保留这些标识。

更换应用旁的 engine 时须使用同一套 IPSPOS.exe、IPSClient.exe、manifest.json。仅替换 EXE 而不更新清单会被拒绝；正在运行的进程不会自动更换引擎。

## 验证与下一阶段

见工程本地 `runtime/log4-integration-20261021/ACCEPTANCE.md`，包含真实后处理、真实录制数据经本机 Ntrip 服务运行、多会话停止／重连、历史重开和桌面检查。录制流验证不代表公网通道当前健康，也不是 RTK 精度验收。

下一阶段可在统一数据层之上增加 PPP 大气／AR 和 RTK 共视、UD／SD／DD、基站与龄期分析，分别定义统计分母、单位和适用模式。本轮只保存原生字段与来源，没有新增这些分析页面。
