# FINDU 0.8.5 验证记录

验证日期：2026-11-04。本版在 0.8.4 的双平台基础上加入产品对比页、偏差对比和产品转换；引擎更换为 IPSPOS 提交 3bef934。

## 环境与交付

Windows 11 x64（MSVC）；WSL2 的 FINDU-Build / Ubuntu 22.04 x86_64，WebKitGTK 4.1。Node 24.19.0、pnpm 11.25.0、Rust 1.99.1。

- Windows：FINDU-0.8.5-windows-x64.zip，完整解压后 FINDU.exe。
- Linux：FINDU-0.8.5-linux-x64.tar.gz，在 Linux 文件系统解压后 ./FINDU。
- 两个引擎均从 IPSPOS 提交 3bef9343ac3b94cdb1f46fd6313ad04c3e1d0026 在干净工作区构建，source_modified=false，build_id=3bef9343ac3b-source-410c12c27906f775，能力 observation_decode 2、satellite_snapshot 3、product_convert 3。源码版本宏仍为 BetaV0.611。
- 打包流程对两个压缩包逐项核验白名单、程序/引擎哈希和随包说明，两个平台均为 passed。包内 build-info.json 记录程序哈希、目标平台与引擎来源。

## 自动回归

| 检查 | 结果 |
|---|---|
| 前端类型、ESLint、Prettier、Vitest | 22 文件、127 项通过 |
| Rust 主程序单元测试（Windows） | 111 通过、4 ignored、0 失败；cargo fmt --check 通过 |
| 引擎包检查（PE / ELF、哈希、替换备份、平台拒绝） | 3 项通过 |
| 可选 DCB 离线回归 | 4 项通过 |
| 浏览器界面测试（轨道钟差、偏差、混合文件） | 3 个脚本通过 |

Linux 上的 Rust 单元测试本次没有在本机运行，由 CI 的 Ubuntu 任务执行；本机只确认 Linux 版程序可编译、打包并运行。ignored 的用例是既有的大数据扫描，不算作通过。

## 引擎对照

使用外部 IPSPOS/Data/TEST 输入的副本（输入文件不改动），在同一台机器上运行：

- 新 Windows 引擎与 0.8.4 所附引擎（提交 5e2fa3b）：T01 PPP-AR 静态的 NMEA 输出逐行一致，T10 RTK 的 NMEA 输出一致；日志只有记录输入路径的行不同。
- 新 Linux 引擎（从解压后的 tar.gz 运行）与新 Windows 引擎：两个案例去掉行尾 CR 后 NMEA 输出完全一致（2881 行、3315 行）。Windows 版 NMEA 的行尾为 CR CR LF，是引擎既有的文本模式写法，未改动。

这只覆盖两个案例的定位输出，不能扩大为所有案例或内部浮点逐位一致。0.8.4 的 32 路并行后处理、16 路实时与录制压力测试没有重做；本版没有改动队列、实时或解析代码。

## 产品对比（真实数据）

使用整理后的测试数据（参考为 WUM 最终产品六天，对比产品包括 WHU/CHC 实时产品和其他机构最终产品），在最终的 Windows 包上经原生拖放事件拖入整个文件夹：

- 参考产品识别 18 个文件；对比产品 1、2 为 BIA+CLK+SP3，产品 3 为 CLK+SP3，产品 4 只有 BIA；
- 页面提示“能比的部分会照常对比”并说明产品 4 不比轨道、产品 3 不比偏差；
- 结果：已完成对比，轨道钟差 3 组、偏差 3 组，偏差页的总体 RMS 表正常显示，脚本错误 0。

测试脚本：tests/compare-desktop.mjs。各卫星直方图的图例颜色与柱子颜色一致由单元测试保证，没有在最终包的画面上逐像素检查。

## Linux 桌面运行

Linux 包解压到 `/tmp/FINDU 便携 测试`（含中文和空格），以普通用户在 Xvfb + dbus + 软件渲染下运行真实 GTK/WebKit 程序，通过 WebDriver 驱动：

- 实时监控、后处理、数据与下载、分析对比、产品对比五页均正常显示，无横向溢出，脚本错误 0；
- engine_info 与 runtime_paths 指向搬迁后的目录，不依赖开发工程的引擎或 Python；
- 经真实 start_product 调用随包 Python，离线使用 BAUT 实际 RINEX 与本地产品生成 ready OPT。

软件渲染下 WebKit 的页面截图会超时，因此本次没有保存截图；测试脚本改为截图失败只记录跳过，页面断言不受影响。Linux 上没有重做产品对比页的真实数据对比，也没有测试拖放（拖放事件由窗口系统提供）。

## 未覆盖

- CLAS（QZSS L6）产品转换未支持；`.gz` / `.Z` 压缩产品需先解压；混合 UBX 的 HAS 记录未验证。
- 北斗二、三代按卫星编号区分，未使用元数据。
- 程序未签名；仅验证 Ubuntu 22.04 / x86_64。
