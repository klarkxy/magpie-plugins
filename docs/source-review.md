# 源码可行性与限制

核对日期：2026-10-11；多实例扩展复核：2026-10-12。固定基线：

| 项目 | commit |
| --- | --- |
| Magpie | `396a6a3d4fc44b736ca34e303138ad8882ca11e8` |
| 社区插件 | `7e67b980aa568c9750e95b547e1149e1db8b60ce` |
| New API | `42e694eb60fe3191795c00d416571ced716eb9c4` |

## 宿主与候选

[host.js servers/loadPlugins](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/plugin/host.js#L1104) 把模块的多个函数导出分别当成 hooks，再由 `auths()` 注册独立 provider。普通单个 server 返回的 `auth`/`provider` 是一个对象，不能简单返回数组；仅向 config.provider 添加条目也不会在 providers() 中产生独立 auth/loader。

0.2 使用单个 CommonJS 入口。Bun 1.4.2 在真实宿主测试中把动态 enumerable 函数暴露为命名导出，从同一 `options.sites` 产生不同 provider 的 hooks，不生成站点代码文件。[host.go](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/plugin/host.go#L790) 在 settings.Dir 启动 Bun；入口因此只读当前目录 plugins.json 的本插件选项，在导出生成前取得实例列表，再核对传入 options 相符。这是已验证版本的 Magpie/Bun 行为依赖，不宣称是所有 OpenCode 宿主的标准动态多实例 API。

GUI 的 [plugins.js](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/gui/assets/plugins.js#L975) 仅对 middleware 显示 JSON Options，Custom API 的创建编辑器在核心 app.js。插件 hooks 没有注册任意表单的扩展点。当前站点管理提供 CLI；真正的表单支持需核心扩展，见 [最小方案](magpie-template-support.md)。

[Magpie host.js](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/plugin/host.js#L1329) 的 `info` 调用每个账号 models hook；`providers` 合并同 ID 时保留先出现的模型。其他账号列表抛错时，其账号 models 可能缺失。[plugins.go](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/provider/plugins.go#L279) 的 `pluginLists` 对无列表账号返回 true。故发现阶段名单不能作为最终分组边界；本插件每次 fetch 都再次核对账号元数据与别名。

[pluginFetch](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/provider/plugins.go#L435) 在调用插件前会用 `modelAPIID` 还原 `api.id`。因此本插件 `api.id` 必须保持分组别名，不能写原模型名；参考 [ZCode loader](https://github.com/magpie-community/plugins/blob/7e67b980aa568c9750e95b547e1149e1db8b60ce/packages/zcode/index.mjs#L1473) 的 Trial 别名在 fetch 中处理。账号级 models/usage 参考 [Kiro hooks](https://github.com/magpie-community/plugins/blob/7e67b980aa568c9750e95b547e1149e1db8b60ce/packages/kiro/index.mjs#L1405)。

[pluginAccounts](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/provider/plugins.go#L108) 使用首账号构造供应商；[Available/buildEntries](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/provider/models.go#L1368) 最终目录默认来自首账号模型。真实 CLI 测试确认，其他组入口不能直接拿来建路由组。安装辅助脚本需要用户显式把宿主并集写为供应商展示 picks，随后核心 `Exposed` 可以展示它们。发送仍走原账号列表和 fetch 校验。第二账号独有条目的完整上下文/能力元数据并不会因此自动合并到核心目录，这仍是上游限制。

[fallback.go perKeyBarred/pinTo](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/gateway/fallback.go) 管理原生账号候选与 pin；[gateway.go](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/gateway/gateway.go) 管理响应发送前后的 retry。真实运行已确认同组 A 429→B、pin 不换账号、显式跨组路由可以转 premium、列表失败不能让 premium key 消耗 cheap 请求、流取消和首内容后中断不重放。本插件不自行 retry 或自动创建 fallback。

[pluginProtocol/pluginCatalog](https://github.com/yetone/magpie/blob/396a6a3d4fc44b736ca34e303138ad8882ca11e8/internal/provider/plugins.go#L127) 依据 SDK npm 判协议，`pluginCatalog` 只有 input/output 至少一项正数才创建价格，并没有完整传递缓存价格。零价、未知价和个性化计价不能据此保证精确计费。本插件只把手动倍率写在 name，未创建货币 price。

## New API 授权边界

[api-router.go](https://github.com/QuantumNous/new-api/blob/42e694eb60fe3191795c00d416571ced716eb9c4/router/api-router.go#L282) 中 `/api/token/*` 使用 UserAuth，`/api/group/` 使用 AdminAuth，`/api/usage/token/` 使用 TokenAuthReadOnly；这些授权不能互相替代。

[GetTokenUsage](https://github.com/QuantumNous/new-api/blob/42e694eb60fe3191795c00d416571ced716eb9c4/controller/token.go#L229) 返回 token_name、quota 数值、unlimited、模型限制和到期时间，未返回分组、用户钱包、用户计费身份或个性化倍率。插件不请求账户管理凭证或管理员权限，而是把固定有效组与计费 profile 明确交给用户手动核对。

[GetUserGroups](https://github.com/QuantumNous/new-api/blob/42e694eb60fe3191795c00d416571ced716eb9c4/controller/group.go#L26) 按用户组计算可用组与倍率；[GetPricing](https://github.com/QuantumNous/new-api/blob/42e694eb60fe3191795c00d416571ced716eb9c4/controller/pricing.go#L38) 在有用户身份时应用 group-group ratio，并返回 auto_groups 等。匿名站点价格不能自动被认为是某个推理 key 的实际个性化价格。

[middleware/auth.go](https://github.com/QuantumNous/new-api/blob/42e694eb60fe3191795c00d416571ced716eb9c4/middleware/auth.go#L608) 使用 token.Group，空组继承用户有效组；还保留 AutoGroups 和 CrossGroupRetry 到 context。[token.go](https://github.com/QuantumNous/new-api/blob/42e694eb60fe3191795c00d416571ced716eb9c4/controller/token.go#L315) 在非 auto 组关闭跨组 retry。插件无法由推理 key 证明这些远端元数据，故拒绝 auto，并明确手动配置不能防止管理员后续在远端改组。

## 运行范围

单个通用插件从选项的 sites 列表为各站注册独立供应商；供应商及别名都包含站点指纹，账号存储和调度池按 provider 分开。fetch 检查完整目的 URL、协议路径，重定向失败关闭。一个插件中的两个独立假站点已由真实宿主验证隔离。

没有改 Magpie 核心，没有上游 PR，没有 npm 发布或市场提交。New API 仅检出并核对源码，未启动真实服务或访问真实账户。假服务证明本插件与指定 Magpie 宿主的行为，不能代替真实站点的协议/能力/账单验证。
