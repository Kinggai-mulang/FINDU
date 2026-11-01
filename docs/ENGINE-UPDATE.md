# 独立引擎更换

FINDU 以独立进程调用 IPSPOS.exe / IPSClient.exe，仅适配 GNSS Log=4 与 StatusLog=1。本仓库不提供 IPSPOS 解算源码及其构建工具。

## 引擎与 FINDU 的边界

IPSPOS 不依赖 FINDU，FINDU 只读取引擎的通用输出。约定：

- IPSDLL 只因算法改动；FINDU 需要的输出只加在 IPSPOS/IPSClient 的 App 层，由 OPT 开关控制、默认关闭，名称中不出现 FINDU。
- 新需求先看能否从 Log=4、StatusLog=1 推出，或由 FINDU 直接读原始文件；只有必须来自解算内部、且对引擎自身调试也有用的数据才扩展引擎，并提高能力版本。
- 交付的引擎应来自一次 IPSPOS 提交（`source_modified=false`）。

清单 `capabilities` 声明 FINDU 读取的可选输出，版本号或 Log=4 不能代替能力声明。旧引擎仍可解算；能力不符时观测检查／卫星详情明确报不支持。

| 能力 | 版本 | 引擎输出 |
|---|---|---|
| `observation_decode` | 2 | `GNSS_PMode=0` 只读解码摘要，schemaVersion 2 |
| `satellite_snapshot` | 3 | `IPSClient_SatelliteFile` 卫星状态文件，schemaVersion 2 |

**模式 0 观测解码。** 普通 OPT：`GNSS_PMode=0`、`GNSS_RoveFile`、`GNSS_DecodeOutput`（默认 observation.json），不新增其他配置。RINEX 按头文件读取；原始流同时启用引擎已支持的全部观测协议（RTCM3、Unicore/SinoGNSS 二进制，跳过 UBX 帧）。不初始化定位应用、不打开产品或结果文件。输出 format（RINEX / RTCM3 / RECEIVER，按解算时的文件类型）、date_anchor、start、end、interval_s（最常见历元间隔）、station、antenna、systems、satellites、observables；无观测、时间倒退、多测站或读写失败时退出码非零。

原始流的周与解算一致：解码器从默认周 2086 开始，收到星历或接收机周后改用真实周；引擎先扫描到第一个真实周，再从文件头重新解码，此时 date_anchor 为 stream。整个文件都没有星历或接收机周时，date_anchor 为 default，时间仍在默认周内；FINDU 要求用户填写 GPST 日期，在周内秒不变的前提下自行换算到该周（`observations.py` 的 `redate`），不写入引擎配置。这类文件解算时引擎同样按默认周处理。

**实时卫星详情。** FINDU 在实时 OPT 中写 `IPSClient_SatelliteFile = <会话目录>/satellites.json;`。IPSClient 在每次解算后、每秒最多一次，先写 `.tmp` 再整体替换该文件：`{schemaVersion:2, sequence, week, tow, publishedAt, satellites:[{prn, system, used, azimuth, elevation, signals:[{slot, band, signal, used, cn0}]}]}`。本历元未解算成功时 used、方位与高度角为 null，不沿用上一历元。写入失败只关闭该文件，不影响解算。

## 更换引擎

候选 engine 目录包含 IPSPOS.exe、IPSClient.exe、manifest.json；清单记录 commit、source_modified、build_id、ipspos_version、source_sha256、solver_sha256、client_sha256、protocols 和 capabilities。不能只替换单个 EXE 或手改哈希。在 IPSPOS 仓库编译 Release 后，由开发工程生成候选目录（输出目录须为空）：

```powershell
resources\product-runtime\python.exe -B scripts\engine-bundle.py pack D:\05_Code\02_posrtk\IPSPOS D:\candidate\engine
```

关闭目标 FINDU，使用便携包自带工具核验并安装：

```powershell
.\product-runtime\python.exe -B engine-tools\engine-bundle.py check D:\candidate\engine
.\product-runtime\python.exe -B engine-tools\engine-bundle.py install D:\candidate\engine --app .
```

工具核验协议、Windows x64 文件头、文件哈希与运行占用；替换前备份，失败时恢复。备份位于目标程序 runtime/engine-backups；关闭程序后，将备份内 engine 作为候选安装即可回退。

开发工程可用 resources/product-runtime/python.exe 调用 scripts/engine-bundle.py check resources/engine。开发资源与不同便携目录互相独立；更新运行目录后应验证后处理已知案例、实时启动和正常停止。历史结果保留原引擎标识。协议或配置语义变化时，需先更新 FINDU 适配层。
