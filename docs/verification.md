# 验证记录

基线 commit 见 [源码调查](source-review.md)。本机测试平台 Windows x64，Node 26.10.0，Go 自动下载的 1.26.8 工具链，Bun 1.4.2。Bun zip 按 Magpie 源码中的 SHA256 核对。所有测试使用隔离 HOME/XDG/APPDATA/agent 路径和假 key，无真实账户、配置或 key。

## 已运行

0.1 完整基线：21 tests，21 pass，0 fail，0 skip。0.2 在本机已安装 Magpie 0.1.1188 上的隔离完整结果：24 tests，24 pass，0 fail，0 skip；增加注册表/管理命令和单包站点增删改的原生测试，不替换该二进制。远端结果以对应 CI 为准。

- `go build -tags nogui -o <isolated-magpie> .`：真实 Magpie 无 GUI 构建成功，未改其核心源码。
- provider 独立测试：别名随倍率变化保持稳定，组/profile/站点隔离，失败列表仍发前校验，api.id 不提前还原，保守能力、显式协议、HTTP400/401/403/429/500/503、SSE、取消、重定向拒绝、额度异常。
- 真实 Bun `host.js`：一条插件记录注册两个站点，每站独立账号 models、同组同ID、不同组不同ID、secondary list 抛错后没有models仍阻断错误账号/站点、原生 API-key 连接、宿主重启。
- 通用包：80站点配置无固定数量上限；拒绝重复URL/凭证字段；配置备份及其他插件保持不变；真实CLI确认空实例加载、两站添加、改名ID稳定、删除其中一站仍只有一条插件记录且不发推理。
- 真实 Magpie gateway：A429→同组B成功、两个cheap key失败不消耗premium（即便premium列表失败）、原生账号pin、显式展示同步及跨组路由、SSE取消无重放、首内容后断流无重放。
- collector：读取真实隔离 Magpie quota/ledger API，输出无原账号/私有站点/路径；独立测试覆盖原始数值和包含关系、0/缺失/非法字段、方向声明、缓存陈旧、重置和跳变、尝试/重启去重、延迟落账与revision、价格配置版本、断线恢复、定时不重叠、暂停恢复退出、持久化失败/排他lock、破损文件不覆盖、部分分页与截断、session来源、错误存在性、隐私白名单。

## 复现

CI 固定同一 Magpie commit、Go 与 Bun，构建真实 nogui 二进制后运行全套。默认 `npm test` 中没有宿主环境时，native 三项会明确 skip。

```sh
export MAGPIE_EXE=/absolute/path/to/isolated/magpie
export MAGPIE_BUN=/absolute/path/to/bun
export MAGPIE_HOST=/absolute/path/to/magpie/internal/plugin/host.js
npm test
```

PowerShell 使用 `$env:MAGPIE_EXE` 等设置对应路径。测试自行建立独立临时 HOME 与回环服务，并关闭子进程。限制网络或文件重命名的沙箱需要对这些回环/临时文件测试授权。没有把测试目录、二进制或日志加入仓库。

## 未运行或不承诺

没有部署真实 New API、访问真实站点或账单、测试真实工具调用/多媒体；Messages/Responses 的插件路径做了协议与发送检查，真实 gateway 主调度证据是 Chat Completions。没有验证所有历史/分叉 New API。没有 npm 发布、市场 PR、开机自启、真实持续采集或自动上传。real-api-pricing 导入适配未实现。

CI 配置已提供；远端运行结果应以 GitHub Actions 实際状态为准。本记录不把尚未跑过的远端 CI 写成通过。采集窗口/账号ID是匿名本地关联，不是供应商稳定ID；缺 usage 的0、延迟落账、外部消耗与归一前口径仍有不可恢复的缺口。
