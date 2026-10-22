# FINDU v0.7.8

- 内置引擎升级至 IPSPOS BetaV0.605（提交 `981723824b4e3ae12c7803a4c1fea1fdc34e2f51`），同步更新 IPSPOS.exe 和 IPSClient.exe。
- 引擎修复 HAS 产品推进与解算问题，改进广播星历和精密产品的后处理读取，适配长时间解算。
- 保持 Log=4 / StatusLog=1 接口及 16 路实时、6 路对比、32 路后处理容量。
- 引擎从已提交源码隔离构建，发行包记录源码身份、两份程序 SHA-256，支持原有引擎校验和备份回退。

完整解压后启动 FINDU.exe，整体保留 engine、product-tools、product-runtime 等目录。需要 WebView2 和 Visual C++ x64 运行库。测试范围与限制见 [验证记录](https://github.com/Kinggai-mulang/FINDU/blob/v0.7.8/docs/VALIDATION-0.7.8.md)。
