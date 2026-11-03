# 独立引擎更换

FINDU 以独立进程调用 Windows 的 IPSPOS.exe / IPSClient.exe 或 Linux 的 IPSPOS / IPSClient，仅适配 GNSS Log=4 与 StatusLog=1。本仓库不提供 IPSPOS 解算源码及其构建工具。

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
| `product_convert` | 3 | `GNSS_PMode=0` + `GNSS_DecodeFormat=SP3`：由 SSR 流和广播星历生成 SP3 / CLK（版本 1）；`GNSS_DecodeFormat=BIA`：由 SSR / OSB 流生成 Bias-SINEX（版本 2）；`GNSS_ProductType=HAS|B2B`：Galileo HAS 和北斗 PPP-B2b 记录同样转成 SP3 / CLK / Bias-SINEX（版本 3） |

**模式 0 观测解码。** 普通 OPT：`GNSS_PMode=0`、`GNSS_RoveFile`、`GNSS_DecodeOutput`（默认 observation.json），不新增其他配置。RINEX 按头文件读取；原始流同时启用引擎已支持的全部观测协议（RTCM3、Unicore/SinoGNSS 二进制，跳过 UBX 帧）。不初始化定位应用、不打开产品或结果文件。输出 format（RINEX / RTCM3 / RECEIVER，按解算时的文件类型）、date_anchor、start、end、interval_s（最常见历元间隔）、station、antenna、systems、satellites、observables；无观测、时间倒退、多测站或读写失败时退出码非零。

原始流的周与解算一致：解码器从默认周 2086 开始，收到星历或接收机周后改用真实周；引擎先扫描到第一个真实周，再从文件头重新解码，此时 date_anchor 为 stream。整个文件都没有星历或接收机周时，date_anchor 为 default，时间仍在默认周内；FINDU 要求用户填写 GPST 日期，在周内秒不变的前提下自行换算到该周（`observations.py` 的 `redate`），不写入引擎配置。这类文件解算时引擎同样按默认周处理。

**SSR 转 SP3 / CLK。** 模式 0 加 `GNSS_DecodeFormat = SP3`：`GNSS_ProductFile`（RTCM SSR 或 IGS-SSR 流）、`GNSS_NaviFile`（RINEX 导航或带星历的 RTCM3 流，缺省取 `GNSS_RoveFile`）、`GNSS_DecodeOutput`（输出路径，不含扩展名）、可选 `GNSS_StartTime`（UTC，星历为流且周不全时作时间参考）。引擎按 PPP 同样的规则选 SSR 指定 IODE 的广播星历并应用轨道、钟差改正，输出 `<路径>.sp3`（300 s）和 `<路径>.clk`（30 s，钟差不含周期相对论项，与 IGS 产品一致）。不写 `GNSS_DecodeFormat` 或写 `SUMMARY` 即为原有观测摘要。没有可用卫星、文件无法读取时退出码非零且不留输出。能力清单只在源码树含 `StreamConvert.c` 时由 `pack` 声明 `product_convert`。

**SSR 偏差转 Bias-SINEX。** 模式 0 加 `GNSS_DecodeFormat = BIA`：`GNSS_ProductFile`（含码 / 相位偏差的 SSR 流）、`GNSS_BIASFile`（单独的 OSB 流，同一信号以后者为准）二者至少给一个；`GNSS_NaviFile`（RINEX 导航时取其周）或 `GNSS_StartTime`（UTC）二者至少给一个，用来确定 GPS 周；`GNSS_DecodeOutput` 同上，输出 `<路径>.bia`。按 5 分钟网格写 OSB（ns），符号取引擎内部偏差的相反数，使其与最终产品的 OSB 一致；超过 `max(3×UDI, 120 s)` 未更新的偏差不输出。FINDU 的偏差对比页据此直接比较实时偏差与最终产品。

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

工具核验协议、平台（Windows PE / Linux ELF x64）文件头、文件哈希与运行占用；替换前备份，失败时恢复。备份位于目标程序 runtime/engine-backups；关闭程序后，将备份内 engine 作为候选安装即可回退。

开发工程可用 resources/product-runtime/python.exe 调用 scripts/engine-bundle.py check resources/engine。开发资源与不同便携目录互相独立；更新运行目录后应验证后处理已知案例、实时启动和正常停止。历史结果保留原引擎标识。协议或配置语义变化时，需先更新 FINDU 适配层。

## 两个平台的引擎

Windows 开发资源仍在 `resources/engine`，Linux 在 `resources/engine/linux-x64`。两份均有独立 manifest，必须来自同一干净提交；不要把 .exe 改名冒充 ELF。编译最新引擎后分别生成候选目录：

```powershell
resources\product-runtime\python.exe -B scripts\engine-bundle.py pack D:\05_Code\02_posrtk\IPSPOS D:\candidate\windows-engine --platform windows-x64
resources\product-runtime\python.exe -B scripts\engine-bundle.py pack D:\05_Code\02_posrtk\IPSPOS D:\candidate\linux-engine --platform linux-x64
```

`pack --platform linux-x64` 读取引擎仓库 `out/IPSPOS/Release/IPSPOS` 和 `out/IPSClient/Release/IPSClient`。按平台将三个文件完整放入对应开发资源目录，再生成两个 FINDU 包。Linux 便携包内同样使用通用的 `engine` 目录；更换工具为：

```bash
./product-runtime/bin/python3 -I -B engine-tools/engine-bundle.py check /path/to/candidate
./product-runtime/bin/python3 -I -B engine-tools/engine-bundle.py install /path/to/candidate --app .
```

安装工具拒绝跨平台替换；保留原来的备份和回退行为。0.8.4 所附两个引擎均取自提交 5e2fa3b；源码版本宏实际仍为 BetaV0.611，清单如实记录，不根据提交标题猜测版本。

**HAS 与 B2b 转换。** 在 SP3 或 BIA 转换的 OPT 里加 `GNSS_ProductType = HAS` 或 `B2B`，其余与 SSR 相同：`GNSS_ProductFile` 是记录文件，轨道转换还要 `GNSS_NaviFile`（RINEX 导航、带星历的 RTCM3 流，或接收机的 Unicore 二进制日志，按内容识别），偏差转换只要记录文件。HAS 记录可以是带时间戳的 64 字节页记录、NovAtel / Unicore OEM 日志或 Septentrio SBF（混合 UBX 流暂不支持）；B2b 记录是 Unicore / SinoGNSS 私有帧日志。两者的页和帧自带接收机时间，所以不需要 `GNSS_StartTime`，也不使用 `GNSS_BIASFile`。输出的轨道是广播星历加改正：Galileo HAS 和北斗 B2b 的改正参考卫星天线相位中心，与最终产品（质心）相差一个径向常数，FINDU 的产品对比页有“轨道为天线相位中心”选项来去掉它。HAS 和 B2b 只有码偏差；符号与 SSR 相同（OSB 取广播值的负值），已用最终产品的 OSB 核对。
