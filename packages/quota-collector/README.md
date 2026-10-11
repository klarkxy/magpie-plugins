# Magpie quota collector

按用户选定的间隔从本机 Magpie 只读接口采集额度快照和请求 token 分项，保存脱敏证据。它是独立本地 CLI，**不是 provider 插件后台服务**：普通 provider hooks 没有可承诺的定时或退出生命周期。采集器不修改 Magpie 配置，不自动启动，不设置开机自启，不上传数据。

只负责采集，不计算月额度、标价 worth、负载归一、单价或评级。`real-api-pricing` 的导入适配仍需对齐其 schema，当前 JSON 不宣称可直接导入现有网页。

## 使用

Node.js 22+，无需安装依赖。先复制 [配置示例](../../examples/quota-collector.config.json) 到 `generated/collector.local.json`。填写公开套餐名称、价格、币种和周期；修改配置时设置新的 `effectiveAt`。匿名账号 `id`、`planId`、`poolId` 应使用与私人信息无关的代号。

本地配置中的 `provider`、`user`、可选 `providerAccount` / `providerKeyId` / `from` / `computer` 是精确匹配源数据的选择器，不进入采集状态或导出。它们需用户从本机已有 Magpie 数据核对，采集器不猜账号或共享额度池。没有明确映射时，快照与请求分别生成匿名 unknown 标识，不自动认为二者同属一池。模型同样由 `models` 显式映射为公开名称；未映射的模型匿名化。套餐版本是用户配置的价格元数据，不是供应商账单证明。

```sh
# 单次采集，便于先检查输出
node packages/quota-collector/cli.mjs once generated/collector.local.json generated/collector.state.json

# 显式开启循环；p + Enter 暂停，r 恢复，q 或 Ctrl+C 退出
node packages/quota-collector/cli.mjs run generated/collector.local.json generated/collector.state.json

# 只导出本地已采集证据，不联系接口，不覆盖已有导出文件
node packages/quota-collector/cli.mjs export generated/collector.local.json generated/collector.state.json generated/sample.evidence.json
```

默认 5 分钟，可设 10、30 或 1–1440 分钟。采用“本轮完成后再等一个间隔”，慢读会拉长开始时间间隔，不会重叠。读失败保存异常标记，下轮重试；暂停/退出取消当前读，不生成新后台进程。状态持久化失败则停止，不推进去重状态。状态通过临时文件原子替换并持有排他 lock；异常终止后残留 lock 需要用户确认没有运行实例后处理。没有承诺断电级持久性，也没有自动清理历史，数据文件会随使用增长。

地址只允许本机回环 Magpie gateway。若已配置的 gateway 需要 key，可通过 `MAGPIE_COLLECTOR_TOKEN` 环境变量提供；它不写入状态、导出或日志。示例和测试不使用真实 key。

## 证据与缺口

使用 `GET /v1/magpie/quotas` 和 `GET /v1/magpie/usage/requests?period=30d&limit=500&offset=…`。每轮最多 `maxPages` 页。窗口的 `used/remaining/amount/limit` 和请求 `in/out/cache_read/cache_write/cache_write_1h/reasoning/ms/status/tries` 保留 Magpie 字段值、缺字段名单和非法数字名单，未折算。已存在但为 null、字符串或非法数值时，不伪装成有效 0。

采集起止时刻分别是 `collectedAt`、`finishedAt`，`sourceReadAt`、`sourceAsOf` 是接口报告的读取/缓存时间。`readAt` 有时是 Magpie 本机接收到快照的时间，不能称为供应商原数据更新时间。窗口匿名 ID 基于源站、账号、窗口名和池名，不是上游提供的稳定 ID；缺字段或改名时需谨慎。`resetsAt` 保留报告值，未知保持 null。`percentageDirection` 只声明方向，不做百分比转换。

额度下降、remaining 上升、重置变化、较大跳变、陈旧缓存、未知账号/池和读失败均记录标记；这些不能单独证明某个时间段的真实消耗。`coverage: unknown | declared-complete` 是用户关于外部消耗覆盖范围的声明，采集器不验证全覆盖。没有按百分比差分推算 token。

请求日志通常完成后才可读取，`t` 是请求/尝试开始时间，不是完成时间。在途请求在接口里不存在，不能被凭空记录。采集每次重新分页读取近 30 天，跨轮/重启按匿名事件标识去重，源 token 数据变化保留新 revision。晚出现的旧时间记录标为 `delayed_or_backfilled_record`，不能直接归到上一个采样区间。`handed_on` 与最终行分别保留，不能把每个尝试都当独立成功请求；`routeId` 关联尝试。缺 route/rid 的身份较弱，只能保守标记，无法保证区分完全相同的两次调用。分页不是事务快照，超出页数、部分失败或分页漂移均有局限；超过 30 天才落账的请求可能漏收。

Magpie 的 `in` 在核对版本中是未缓存输入；`out` 含 reasoning，`cache_write` 含其中的 `cache_write_1h`。不要把子项再加到父项上。部分供应商/插件可能估算 token，原始来源标记已丢失，采集器不能恢复。Magpie 本身对缺失 usage 可给出 0，因此 **观察到 0 仍可能代表未报告**。导出包含 `upstream_usage_reporting_unknown`；省略的缓存/思考字段保持 unknown。session 文件来源行标记 `session-log` 和未验证路由；不自动据此认定供应商消耗。报告的错误只保留存在性和状态码，不保存供应商错误文本。

导出按白名单构建：不包含邮箱、原账号名、provider host、会话名、请求/响应正文、key、请求 ID 原文、原窗口名或模型私有别名。未知标识用带本地随机盐的 HMAC；盐保存在本地状态，导出不含盐。本地状态仅保存同样的脱敏证据及盐，不留原响应。配置中的明确公开套餐名/代号会导出，请勿把私人信息填入这些公开字段。导出仍含时间、用量和价格，分享前需用户检查。

配置变化创建新的匿名版本并保留 `effectiveAt`、套餐价格/币种/周期、账号与池映射。旧快照不会重写，请求记录不硬绑定当前套餐价格，消费者需按版本及实际生效时刻解释。原始字段口径证据见 [quota-evidence.md](../../docs/quota-evidence.md)。
