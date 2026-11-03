# FINDU 0.8.4 验证记录

验证日期：2026-11-03。本版从用户当前 0.8.3 工作区继续，未覆盖已有源表、列宽、NTRIP 与分析拖入修改。原有 ntrip.rs、SourceTable.tsx、native-styles.css、source-table-ui.mjs、AGENTS.md 与开始时的 SHA-256 完全相同。版本及构建配置在原文件上增量调整。

## 环境与交付

Windows x64（MSVC）；WSL2 的 FINDU-Build / Ubuntu 22.04 x86_64 / glibc 2.35，WebKitGTK 4.1（2.50.4）。Node 24.19.0、pnpm 11.25.0、Rust 1.99.1。Linux 使用原生 GTK/WebKit 与 ELF 引擎，无 Wine、Docker。Linux 桌面测试以普通用户、Xvfb + dbus + 软件图形渲染执行，未在产品里关闭 WebKit 沙箱。

- Windows：FINDU-0.8.4-windows-x64.zip，完整解压后 FINDU.exe。
- Linux：FINDU-0.8.4-linux-x64.tar.gz，在 Linux 文件系统解压后 ./FINDU；运行目录可写。最低目标 Ubuntu 22.04 / x86_64 / glibc 2.35，系统安装 GTK 3、WebKitGTK 4.1、xdg-utils、curl、gzip。
- Linux Python 是固定下载地址及 SHA-256 的 CPython 3.12.16 / python-build-standalone 20261026；验证 ssl、socket、lzma、bz2、sqlite3、ctypes。Windows 保留原有嵌入式 Python。
- Windows ZIP 使用随包 Python 标准库生成 UTF-8 中文文件名，生成后核验 CRC 和全部资源入口，避免系统 tar 的中文文件名编码问题；两个压缩包均逐项核验白名单、程序/引擎哈希及随包说明内容。
- 包内 build-info.json 记录程序哈希、目标平台及引擎来源；engine/manifest.json 记录两个引擎的哈希。归档只包含程序资源白名单，排除 runtime、历史、用户观测、结果及连接凭据。
- 两份引擎均从同一干净源码提交 5e2fa3b5f5b726d3321923fd94bccb2dc0fe0fc3 重建，source_modified=false，build_id=5e2fa3b5f5b7-source-4756ead4822d4dd5。源码版本宏实际仍为 BetaV0.611，未按提交标题改写。

## 自动回归

| 检查 | Windows | Linux |
|---|---|---|
| 前端类型、ESLint、Prettier、Vitest | 18 文件、83 项通过 | 18 文件、83 项通过 |
| Rust 主程序单元测试 | 62 通过、1 ignored、0 失败 | 63 通过、1 ignored、0 失败 |
| 引擎 PE/ELF、哈希损坏、替换备份、平台拒绝、归档路径检查 | 3 项通过 | 3 项通过 |
| 可选 DCB 离线回归 | 4 项通过 | 4 项通过 |
| 格式 | cargo fmt --check 通过 | 共用相同源码 |

Linux 多的一项测试验证丢弃 Job 后，独立进程组内的 shell 与 sleep 子孙进程均结束。ignored 的真实扫描大数据样例是既有测试，本次未将 ignored 算作通过。新增打包测试还验证输出目录边界、平台文件名，以及两个平台引擎不同源时拒绝一键生成。

## 真实 PPP / RTK 后处理与数值对照

测试通过 FINDU 的生产 options、NativeRuntime 队列、进程启动、Log=4 解析、历史索引运行，使用外部 IPSPOS/Data/TEST 输入，未修改观测及产品。Linux 输出目录含中文和空格。

| 案例 | 原生 Log=4 记录数（每平台） | FINDU 有效定位历元（每平台） | ECEF 坐标 / 解状态不一致 |
|---|---:|---:|---:|
| T01_PPPAR_FIN-WUM_STA | 2880 | 2880 | 0 |
| T02_PPPAR_FIN-WUM_KIN | 2880 | 2880 | 0 |
| T10_RTK_BASE-KT1VRS_KIN | 3319 | 3305 | 0 |

共 9079 条原生记录，逐行比较 Week/Tow/UTC、X/Y/Z、Q 均一致；坐标最大差 0.000 m（日志输出精度 0.001 m）。RTK 的 14 条启动阶段无效解由既有解析器排除，两平台规则一致。不能把此结论扩大为内部浮点逐位一致，少量 formal/Ratio/RMS 等诊断末位可能不同。

此前 PPP 的明显跨平台差异已定位于 Windows 文本模式 CLK 的 LF/CRLF 定位行为：会漏读 G01 首条 CLK，使用 SP3 钟值。引擎已统一用 rb 打开 CLK；本次发行使用已提交的修复，不增加 FINDU 数值补偿，也不调整算法参数。

另在两平台各以同一 RTK 实际数据启动 **32 路生产后处理并行任务**；全部 succeeded、exitCode=0，各产生 3305 个有效定位历元。不是用假进程模拟队列容量。

## 实时、录制与生命周期

使用本机 NTRIP 回放服务器，将 ALLOY1018 的真实 RTCM 观测、星历、SSR 轨钟和 OSB 按 1 Hz 回放，无外部账号。

- 两平台各同时启动 16 路：8 RTK（同源零基线）+ 8 PPP，均产生定位、状态与诊断记录。测试为约 25 秒的功能回归，不替代长时间精度评价。
- 单独停止一路时其他 15 路仍在运行；随后整体停止。未见解析错误，结束后历史可重新载入，17 份历史（含重启）身份及引擎标识独立。
- 通过生产启动器取得卫星快照，实际 OPT 含能力开关。状态流无队列丢帧。
- 重用同一 UI session key 重启产生新 run id，旧 summary 未改写，新结果正常入库。
- 两平台各运行 2 路仅录制：原始文件在运行中持续增长、单路停止互不影响、重启创建新运行；不生成定位历元或分析结果。

可复核入口：`tests/platform-native.py --inputs <IPSPOS/Data/TEST> --engine <平台引擎目录> --bins <Rust release目录> --output <新的测试目录>`。请求与结果仅放在指定测试输出目录。

## 桌面与便携运行

- Windows 正式 WebView2 程序：四个页面正常，脚本错误 0；最终包的真实 start_product IPC 使用随包 Python 离线准备 BAUT 产品，生成 ready OPT。源表 UI 回归通过（搜索、筛选、距离排序、列宽/显隐、探测、回填），保留用户近期修改。
- Linux 正式 GTK/WebKit 程序：从 tar.gz 解压到 `/tmp/FINDU 便携 测试`，以普通 Linux 用户实际运行；四页正常、无横向溢出，engine_info 和 runtime_paths 指向搬迁目录，未依赖开发工程的 Windows 引擎或 Python。
- Linux 桌面经真实 start_product IPC 调用随包 Python，离线使用 BAUT 实际 RINEX 与本地产品生成 ready OPT。产品任务使用生产 Products 调度与启动逻辑。
- 两平台另通过生产 Transfer 实际调用系统 curl，从本机 HTTP 下载真实 CLK.gz，解压后内容 SHA-256 与原 CLK 完全相同并通过钟差元数据校验；还实际调用 gzip 解压命令（gzip 测试封装，不将其描述为真 LZW 历史 .Z 文件回归）。
- 两平台各使用随包 Python 检查 RTCM 错误扩展名、缺日期提示、GPST 用户日期重定、gzip、RINEX 及输入只读性。Linux 观测文件名也含中文和空格。
- Linux WebKit 实际载入两份约 47 小时结果，切换位置、质控、模糊度、大气、产品及总览。首轮载入约 8.9 s，最终包复验约 11.77 s，无脚本错误。软件渲染 / WSL 下数据不作为 Linux 实机性能承诺。

## 大数据与 Windows 性能

沿用 AGENTS.md 指定脚本和 ALLOY-WHU01 的两份 47 小时、1 Hz Log=4。每份 169492 行诊断、168811 有效定位历元。Windows/Linux load-check 导出的 epochs 与 diagnostics JSON 逐值完全一致，共 337622 个有效定位历元、338984 条诊断。

| 后端步骤 | Windows | Linux（输入位于 /mnt/d） |
|---|---:|---:|
| 两文件解析 | 0.62 s | 1.71 s |
| 二进制编码 | 0.31 s | 0.20 s |
| 二进制响应 | 76.9 MiB | 76.9 MiB |

Windows 正式 WebView2、tests/perf-desktop.mjs 单次测量（当时有其他编译/测试负载）：

| 场景 | 主线程占用 | 最长长任务 | 刷新 |
|---|---:|---:|---|
| 实时详情 1 × 3600 | 2.5% | 0 ms | 20 次，平均 1 s，最大 1.09 s |
| 实时对比总览 6 × 3600 | 6.5% | 64 ms | 20 次，平均 1 s，最大 1.02 s |
| 实时对比位置 6 × 3600 | 15.5% | 208 ms | 20 次，平均 1 s，最大 1.05 s |
| 两份 47 h 载入 | 5.58 s 总耗时 | 688 ms | 分析页签、缩放正常 |

既有 0.8.1 同机记录分别为 2.3% / 5.8% / 13.9%，载入约 5.1 s。本次未作严格空载的统计性能对照；刷新保持 1 Hz、所有页签可用，未改变增量协议、缓存容量、绘图抽稀或二进制格式。当前载入仍存在可感知长任务，未将单次测试描述为“完全无卡顿”。

## 以后怎样生成

`pnpm desktop:package` 默认先 Windows，再在 WSL2 FINDU-Build 中原生生成 Linux；可用 FINDU_LINUX_DISTRO 指定已有合适发行版。Linux 在独立文件系统缓存依赖，归档后只把 tar.gz 复制回 Windows，保留 Python 大小写文件与符号链接。单平台命令为 `pnpm desktop:package:native`。两份引擎来源必须一致，包核验失败时返回非零。

`.github/workflows/desktop.yml` 配置 Windows / Ubuntu 22.04 两个原生作业，检查并上传压缩包，支持手动或 v* 标签触发。本次验证为本机 Windows + WSL 的完整生成；未推送、触发远程 CI 或发布 Release。

本地原始证据：runtime/linux-build-0.8.4（不提交用户数据），含单元日志、post-platform-comparison.json、32 路结果、真实回放 check.json、桌面截图及性能记录；脚本入口均在 tests/ 与 scripts/。

## 验证边界

未覆盖其他 Linux 发行版/桌面组合、ARM64、musl、原生 Linux 真机 GPU/显示服务器、系统文件选择与文件夹打开的人工交互、系统级文件拖放、带真实账号的公网长期 NTRIP、真实 HAS/B2b/CLAS 长期联调。本版对它们不作“全部已测”的承诺。Linux C 文件 API 使用 UTF-8；Windows 仍保持原 ANSI/短路径限制，无法转换的中文路径会提示改用英文目录。本次未为 Windows 增加另一套路径转换逻辑。
