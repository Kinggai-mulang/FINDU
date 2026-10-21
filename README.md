# FINDU
支持PPP、PPP-AR、RTK实时与后处理高效解算平台
支持B2b，HAS等解算
全面的数据结果对比分析与实时监控

Windows GNSS 工作台，提供产品下载、后处理解算、实时监控、数据录制与结果分析。基于 Tauri 2、React、TypeScript、Ant Design 和 ECharts。

当前正式版：**v0.7.5**，运行引擎 **IPSPOS BetaV0.604**（GNSS Log=4 / StatusLog=1）。

## 下载与运行

从 [v0.7.5 正式发布](https://github.com/Kinggai-mulang/FINDU/releases/tag/v0.7.5) 下载 Windows x64 便携包，完整解压后双击 FINDU.exe。请整体保留 engine、product-tools、product-runtime 等目录。

需要 Windows x64、Microsoft Edge WebView2 Runtime 和 Microsoft Visual C++ 2015–2022 x64 运行库。程序未签名。产品下载和实时数据源需要网络；无需另装 Python、MATLAB 或 Docker。

## 主要功能

- **数据与下载**：读取 RINEX 观测时间范围，准备轨道、钟差、偏差、导航与天线产品，检查覆盖并生成后处理配置。
- **后处理**：导入与编辑 OPT，排队运行独立解算进程，查看进度、日志、运行记录及可重新加载的结果。
- **实时监控**：配置数据流，实时解算、回放或仅录制；切换页面保持后台会话和已有统计，返回后继续显示。
- **分析对比**：位置、ENU、残差、产品时效及大气诊断；跨天曲线标注 UTC 日期，显示完整时间范围和覆盖日数。没有独立参考坐标时，ENU 表示相对位置变化。

详细使用与变化见 [版本说明](docs/RELEASE-0.7.5.md)，测试范围与限制见 [验证摘要](docs/VALIDATION-0.7.5.md)。

## 从源码构建

开发环境：Windows x64、Node.js 22 或以上、pnpm 11.25.0、Rust stable、Visual Studio C++ Build Tools 与 Windows SDK。

```powershell
git clone https://github.com/Kinggai-mulang/FINDU.git
cd FINDU
pnpm install --frozen-lockfile
pnpm check
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml --bin findyou
pnpm desktop:dev
```

生成正式便携目录：

```powershell
pnpm desktop:package
```

输出位于 deliverables/FINDU-0.7.5-windows-x64。仅运行 pnpm dev 是浏览器界面预览，真实解算需要桌面程序。UI 冒烟测试可在 pnpm dev 启动后运行 pnpm test:ui，需要本机 Microsoft Edge。

## 仓库范围与数据

本仓库保存 FINDU 的前端、Rust 接入层、数据协议、测试、必要产品下载辅助脚本及独立运行资源。**不包含 IPSPOS 解算算法源码**；engine 目录仅提供二进制与版本/哈希清单。更换引擎见 [说明](docs/ENGINE-UPDATE.md)。

用户观测、产品缓存、连接凭据、运行结果、编译产物和测试中间文件均不纳入 Git。正式便携包在 GitHub Releases 发布。默认运行数据保存在程序旁的 runtime 目录；请将便携包放在可写目录。实时运行副本可能含连接凭据，请自行妥善保管。

仓库未指定 FINDU 自有代码的开源许可证；公开可读不代表授予额外许可。第三方组件沿用各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
