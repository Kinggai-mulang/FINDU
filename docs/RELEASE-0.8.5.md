# FINDU 0.8.5

本版在 0.8.4 的 Linux x64 / Windows x64 双平台基础上，合并为一个“产品对比”页面，并加入偏差对比和产品转换。Windows 与 Linux 同步发布，引擎来自同一干净提交。

## 新增

- **产品对比页统一。** 一个“产品”就是一组 BIA、SP3、CLK 文件，可一次拖入多个文件或整个文件夹。参考产品加最多 8 个对比产品，能比什么就比什么：有 SP3 的产品比较轨道与钟差，有 BIA 的产品比较偏差。页面在比较前就写明哪部分不能比及原因；某个产品出错只在结果里列出，不影响其他产品。
- **偏差对比。** 对 Bias-SINEX 做码偏差、DCB、宽巷和扣除基准后的相位比较，符号约定默认自动判定，也可手工指定。
- **卫星剔除。** 按系统、北斗代别（以编号区分）、GEO/IGSO/MEO（按实测轨道形状）、区间和连续号段选择卫星，两类比较共用同一份剔除列表。
- **产品转换。** 引擎能力 `product_convert` 为 3 时，可在产品框内把 RTCM SSR 转为 SP3 / CLK、把 SSR / OSB 转为 Bias-SINEX，也可由 Galileo HAS、北斗 PPP-B2b 记录转换；转换结果可直接进入对比。引擎不具备该能力时入口提示“当前引擎不支持”。
- 各卫星直方图的图例颜色与柱子一致；比较色板扩展到 8 色。

## 平台与引擎

- Windows 与 Linux 两个引擎取自 IPSPOS 提交 3bef934（源码未改动，`source_modified=false`），清单声明 `observation_decode` 2、`satellite_snapshot` 3、`product_convert` 3。解算流程与 0.8.4（引擎 5e2fa3b）相比没有改动。
- Windows 完整解压 ZIP 后启动 FINDU.exe；Linux 在原生文件系统解压 tar.gz 后执行 ./FINDU。程序和 engine、product-tools、product-runtime 必须整体保留，目录需要可写。
- Linux 适用 Ubuntu 22.04+ / x86_64 / glibc 2.35+，需要图形桌面和 WebKitGTK 4.1、GTK 3、xdg-utils、curl、gzip。随包 Python，无需 Wine、Docker、MATLAB 或另装 Python。
- 容量及协议不变：16 路实时、6 份比较、32 路后处理，Log=4 / StatusLog=1。实时增量缓存和二进制分析协议未变。

程序未签名。本版不包含 ARM64、Alpine/musl 或 AppImage；未承诺所有 Linux 发行版均已实机验证。CLAS 产品转换尚未支持。数据、历史、缓存和连接凭据不打进发行压缩包。详细验证及未覆盖范围见 VALIDATION-0.8.5.md。

## 首次运行

Windows x64 需要 Microsoft Edge WebView2 Runtime 和 Microsoft Visual C++ 2015–2022 x64 运行库。完整解压后双击 FINDU.exe。

Ubuntu 22.04 / x86_64：

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2 xdg-utils curl gzip
tar -xzf FINDU-0.8.5-linux-x64.tar.gz
cd FINDU-0.8.5-linux-x64
./FINDU
```

保留 Linux 执行权限和符号链接，不要在 Windows 中先解开 Linux 包再复制。需要图形桌面；解压到自己的可写目录，以普通用户运行。
