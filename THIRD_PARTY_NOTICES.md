# 第三方组件

- IPSPOS / IPSClient：独立 Windows x64 解算引擎，仅附二进制与哈希清单，不提供解算算法源码。其权利归原作者所有。
- 产品下载辅助脚本：从 IPSPOS 工程独立复制并在 FINDU 内适配，范围与来源哈希见 resources/product-tools/provenance.json；不包含解算算法实现。
- FAST：使用下载地址目录、时间辅助函数与压缩工具，保留 resources/product-tools/ThirdParty/FAST/LICENSE（GPL-3.0）。
- Python 3.12 运行时：许可证见 resources/product-runtime/LICENSE.txt，包含的标准库及运行依赖适用其各自许可条款。
- gzip 与 Cygwin：随 FAST 工具目录提供；GNU gzip https://www.gnu.org/software/gzip/ ，Cygwin https://cygwin.com/ 。原始版权及许可证适用。
- React、Ant Design、ECharts、Tauri 等前端与桌面依赖：版本锁定于 pnpm-lock.yaml 和 src-tauri/Cargo.lock，按各自上游许可证使用。

FINDU 自有代码未在本次发布中指定额外的开源许可证。
