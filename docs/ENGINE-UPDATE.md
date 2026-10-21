# 独立引擎更换

FINDU 以独立进程调用 IPSPOS.exe / IPSClient.exe，仅适配 GNSS Log=4 与 StatusLog=1。本仓库不提供 IPSPOS 解算源码及其构建工具。

候选 engine 目录须由引擎提供方生成，包含 IPSPOS.exe、IPSClient.exe、manifest.json；清单需记录 build_id、ipspos_version、source_sha256、solver_sha256、client_sha256 和 protocols。不能只替换单个 EXE 或手改哈希。

关闭目标 FINDU，使用便携包自带工具核验并安装：

```powershell
.\product-runtime\python.exe -B engine-tools\engine-bundle.py check D:\candidate\engine
.\product-runtime\python.exe -B engine-tools\engine-bundle.py install D:\candidate\engine --app .
```

工具核验协议、Windows x64 文件头、文件哈希与运行占用；替换前备份，失败时恢复。备份位于目标程序 runtime/engine-backups；关闭程序后，将备份内 engine 作为候选安装即可回退。

开发工程可用 resources/product-runtime/python.exe 调用 scripts/engine-bundle.py check resources/engine。开发资源与不同便携目录互相独立；更新运行目录后应验证后处理已知案例、实时启动和正常停止。历史结果保留原引擎标识。协议或配置语义变化时，需先更新 FINDU 适配层。
