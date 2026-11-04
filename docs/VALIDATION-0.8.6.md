# FINDU 0.8.6 验证记录

验证日期：2026-11-04。Windows x64，产品准备与状态展示修复；引擎沿用 0.8.5。

## 真实产品与 TEST 配置

- 已从 CAS 发布目录取得最新可见的 CAS1OPSRAP_20263040000_01D_01D_DCB.BIA.gz。解压 SHA256：7d5705b4a97822e712b752679f6012406147c2a4ff31371594aced041ddcbf44。
- DCB 有效区间为 2026-10-31 至 11-01 GPST；15 天保持截止为 11-16 GPST，含 119 颗卫星。GPS 1C–1W / 2W–2X 可用卫星分别为 32 / 28。
- 官方 IGS20 ANTEX 源 Last-Modified 为 2026-09-28，926 条天线记录，SHA256：0cd58d0d9ee678d5586de6c01f576e5aceb86f4a0735a168f733dfd091c0a614。
- 实时与历史配置共更新 17 份 OPT。历史 SSR 另外取得 09-19、10-09、10-18、10-26 对应产品；不使用未来 DCB 回填历史数据。保留 CLAS 专用 IGS14 天线。
- 更新后 27 个非空天线/DCB 文件引用全部存在。PRODUCT_COMPARE 共 47 文件，与已有真实对比数据逐文件 SHA256 一致。
- TEST 中增加启动前更新入口。不可变快照保存在 TEST/DATA/PRODUCT_CACHE；检查记录含来源、有效期与更新状态，不含连接账号。

## 自动检查

- `pnpm verify`：类型检查、ESLint、Prettier 通过；23 个 Vitest 文件共 132 项通过。
- Rust 主程序：111 项通过，4 项既有大数据测试 ignored；包括增加的清理队列期间保留活动 DCB 的断言。rustfmt 通过。
- Python 可选 DCB 回归：8 项通过，覆盖失效/OSB 拒绝、历史有效期、固定本地文件（包括在线模式不联网）、缓存、在线更新替换较旧有效文件、失败回退与总超时。
- TEST 产品路径更新自检通过：保留 UTF-8 BOM、换行和非产品字段，备份不含测试凭据，重复运行不产生重复修改。
- 浏览器实际组件测试通过：三种准备状态、主任务重试禁用、清理队列请求、无伪下载百分比；完整样式已加载，无脚本错误、拖放初始化错误或横向溢出。截图：runtime/downloads-ui/statuses.png。

## Windows 交付程序

- 在最终 0.8.6 程序中，经原生 IPC 导入 TEST 下 7 份实时配置、14 份后处理配置；实时配置返回的 9 个非空辅助产品路径均存在。实时连接账号仅留在导入函数内存，没有输出到验证报告。
- 使用真实 BAUT 2024-01-19 观测、配套本地产品和随包 Python 离线准备：生成 1 份 ready OPT，DCB 单独显示 unavailable，页面正确显示“配置可用 · 存在缺项”。未执行定位解算。
- `node tests/compare-desktop.mjs --data D:\05_Code\02_posrtk\IPSPOS\Data\TEST\PRODUCT_COMPARE` 通过：参考文件 18 个，轨道钟差 3 组、偏差 3 组，脚本错误 0；未修改对比算法。
- Windows 构建和 package-check 通过；应用 SHA256：d215aaaf8b35d90e8e48ca3a03741dfd2e35890db30f0afdf5eb9c6353cc56ba。引擎 build ID 仍为 3bef9343ac3b-source-410c12c27906f775。ZIP 排除运行数据和测试输入。

## 范围限制

未重新连接用户实时 NTRIP 服务，未重跑 14 个完整后处理解算或长时间负载测试。实时数据桥、图表与引擎未修改。本次不声称定位精度发生改进，也不声称 DCB 尚未发布的日期存在新产品。Linux 本次未重新构建和验证。
