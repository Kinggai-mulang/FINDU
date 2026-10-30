# 独立引擎更换

FINDU 以独立进程调用 IPSPOS.exe / IPSClient.exe，仅适配 GNSS Log=4 与 StatusLog=1。本仓库不提供 IPSPOS 解算源码及其构建工具。

0.8.0 的 BetaV0.611 清单另声明 `capabilities.observation_decode=1` 与 `satellite_snapshot=2`。版本号或 Log=4 不能代替能力声明。旧引擎仍可解算；无相应能力时观测检查／卫星详情明确报不支持。

原生只读检查使用普通 OPT：`GNSS_PMode=0`、`GNSS_RoveFile`、`GNSS_DecodeOutput`，以及仅在需要时填写的 `GNSS_DecodeDate=YYYY-MM-DD`（GPST）。没有新增 inspect 命令行模式。模式 0 不初始化定位应用、不联网、不输出定位结果；输出 JSON 的 status 为 ok 或 needs_date，失败用非零退出码。日期冲突、纯产品流、纯 UBX RAWX 和多站流失败。生成的原始流后处理 OPT 保留同一 DecodeDate；其余求解模式保持原流程。

实时诊断不写入 OPT，也不扩展 IPSClientOption。FINDU 仅对子进程设置 `IPSPOS_DIAG_SATELLITE_DIR`、`IPSPOS_DIAG_SATELLITE_RUN_ID` 环境变量；独立启动引擎时默认关闭。能力版本 2 表示这一启动约定，快照 JSON 格式仍为版本 1。订阅文件 `satellites.request` 是 Unix 到期秒数，FINDU 每秒续期至 5 秒后；引擎只接受未来 10 秒内的租约。独立线程原子替换 `satellites.json`，schemaVersion=1，最多保留最新完整快照。求解线程只做每秒最多一次的固定容量非阻塞复制，写盘与序列化在诊断线程。诊断失败不影响求解。

Windows 诊断发布线程使用低于普通线程的优先级，心跳检查间隔 500 ms。此优先级不改变求解或接收线程；高负载下允许详情延迟，缓冲忙时跳过采集。

候选 engine 目录须由引擎提供方生成，包含 IPSPOS.exe、IPSClient.exe、manifest.json；清单需记录 build_id、ipspos_version、source_sha256、solver_sha256、client_sha256 和 protocols。不能只替换单个 EXE 或手改哈希。

关闭目标 FINDU，使用便携包自带工具核验并安装：

```powershell
.\product-runtime\python.exe -B engine-tools\engine-bundle.py check D:\candidate\engine
.\product-runtime\python.exe -B engine-tools\engine-bundle.py install D:\candidate\engine --app .
```

工具核验协议、Windows x64 文件头、文件哈希与运行占用；替换前备份，失败时恢复。备份位于目标程序 runtime/engine-backups；关闭程序后，将备份内 engine 作为候选安装即可回退。

开发工程可用 resources/product-runtime/python.exe 调用 scripts/engine-bundle.py check resources/engine。开发资源与不同便携目录互相独立；更新运行目录后应验证后处理已知案例、实时启动和正常停止。历史结果保留原引擎标识。协议或配置语义变化时，需先更新 FINDU 适配层。
