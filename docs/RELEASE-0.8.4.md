# FINDU 0.8.4

本版在当前 0.8.3 工作区上增量更新，保留源表、列宽、分析拖入等已有修改，加入 Linux x64 桌面版与双平台生成流程。

- Windows 完整解压 ZIP 后启动 FINDU.exe；Linux 在原生文件系统解压 tar.gz 后执行 ./FINDU。程序和 engine、product-tools、product-runtime 必须整体保留，目录需要可写。
- Linux 使用原生 ELF 引擎及随包 Python，无需 Wine、Docker、MATLAB 或另装 Python。适用 Ubuntu 22.04+ / x86_64 / glibc 2.35+，需要图形桌面和 WebKitGTK 4.1、GTK 3、xdg-utils、curl、gzip。Ubuntu 安装命令见下文。
- 后处理队列、实时会话、仅录制、观测解码与产品工具按平台启动原生程序。Linux 允许 UTF-8 文件路径；取消任务和关闭程序清理所属子进程组。既有 Windows Job Object 行为保留。
- 容量及协议保持：16 路实时、6 份比较、32 路后处理，Log=4 / StatusLog=1。实时增量缓存和二进制分析协议未变。
- 两个平台的引擎来自同一干净源码提交 5e2fa3b，包含此前 CLK 文本定位问题修复：CLK 统一二进制读取，避免 Windows LF/CRLF 产生不同 PPP 坐标。引擎源码仍独立于 FINDU。
- Windows 上 pnpm desktop:package 默认生成 Windows 和 WSL Linux 两份便携包；pnpm desktop:package:native 生成当前平台。CI 配置支持双平台矩阵，生成文件与应用哈希、引擎提交记入 build-info.json。

程序未签名。本版不包含 ARM64、Alpine/musl 或 AppImage；未承诺所有 Linux 发行版均已实机验证。数据、历史、缓存和连接凭据不打进发行压缩包。详细验证及未覆盖范围见 VALIDATION-0.8.4.md。

## 首次运行

Windows x64 需要 Microsoft Edge WebView2 Runtime 和 Microsoft Visual C++ 2015–2022 x64 运行库。完整解压后双击 FINDU.exe。

Ubuntu 22.04 / x86_64：

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2 xdg-utils curl gzip
tar -xzf FINDU-0.8.4-linux-x64.tar.gz
cd FINDU-0.8.4-linux-x64
./FINDU
```

保留 Linux 执行权限和符号链接，不要在 Windows 中先解开 Linux 包再复制。需要图形桌面；解压到自己的可写目录，以普通用户运行。
