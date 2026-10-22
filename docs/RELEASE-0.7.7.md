# FINDU v0.7.7

- 实时会话最多同时运行 16 路；最多保留 16 路配置及会话，移除已结束记录保留磁盘文件。
- 实时及历史结果一次最多选择 6 路方案对比；批量导入仍保留全部结果，超出 6 路的结果可切换查看。
- 后处理支持一次导入最多 32 份 OPT，维持 1–32 路并发、最多 128 个待处理任务。
- 容量限制由同一配置提供给界面与原生接入层，避免提示与实际限制不一致。
- 继续保留 v0.7.6 的 Ratio、新鲜度、切页和跨日期修复。运行引擎保持 IPSPOS BetaV0.604。

完整解压后启动 FINDU.exe，整体保留 engine、product-tools、product-runtime 等目录。需要 WebView2 和 Visual C++ x64 运行库。并发上限是应用允许值，实际吞吐取决于本机资源及数据源；验证结果与范围见 [容量验证记录](https://github.com/Kinggai-mulang/FINDU/blob/v0.7.7/docs/CAPACITY-VALIDATION-0.7.7.md)。
