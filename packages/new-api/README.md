# New API for Magpie

每个站点有独立供应商 ID，每个推理 key 是该供应商下的原生账号。模型入口区分站点、有效分组、计费身份和协议，倍率写在显示名称中，调整倍率不会改变 ID。同组、同计费身份的 key 复用 Magpie 原生账号调度。

**首版分组和倍率是手动配置，始终显示“手动未验证”。** 推理 key 无法证明自身实际分组或个性化倍率，插件也不会用额度查询结果冒充分组证明。请从站点控制台核对 key 的有效固定组：当 key 的分组为空时，需核对其所属用户的实际组。远端修改 key 组后，需要重新连接该账号。不能靠本地标注改变远端账单。

## 本地安装

1. 将 [站点配置示例](../../examples/new-api.site.json) 复制到 `generated/site.local.json`，填写公开或本地站点地址、计费身份和模型能力。不要写 key。站点 URL 应是 New API 根地址（可带部署子路径），**不带 `/v1`**；非回环地址必须 HTTPS。
2. 为该站点生成一个 wrapper，并安装这个文件：

```sh
node packages/new-api/setup.mjs generated/site.local.json generated/site-plugin.mjs
magpie plugin add ./generated/site-plugin.mjs
magpie plugin list --json
```

`setup` 不覆盖既有 wrapper；配置变化时显式生成新文件并重新安装。wrapper 引用本地包的绝对地址，移动仓库后需要重新生成。不要公开生成文件。一个站点只安装一个 wrapper；多个站点分别生成不同文件，规范化 URL 的 SHA256 前 16 位决定供应商 ID，互不共享账号或请求。相同地址、不同显示名称仍是同一个供应商。

3. 从列表取得 `new-api-…` ID，连接一个或多个 key：

```sh
magpie plugin login new-api-<site-hash>
```

Magpie 会询问有效固定组、计费身份和 key。key 保存在 Magpie 原生账号存储中，wrapper 和站点配置不保存凭证。不需要管理员或账户管理凭证。

4. **多个组需要显式同步供应商展示列表。** 在已验证的 Magpie 版本中，插件宿主给出所有账号模型的并集，但核心目录默认只展示首账号。下面的辅助脚本先预览，再按用户请求替换这个供应商的展示列表和模型名称：

```sh
node packages/new-api/sync-catalog.mjs new-api-<site-hash>
node packages/new-api/sync-catalog.mjs new-api-<site-hash> --apply
magpie models
```

可通过 `MAGPIE_EXE` 指定 Magpie 可执行文件。列表不完整或任何账号模型查询失败时，辅助脚本拒绝写入。添加账号或修改显示倍率后需重新运行。此操作不扩大账号自身的模型列表，不创建 fallback 或路由组。非首账号独有模型的完整能力元数据仍受 Magpie 核心目录限制；辅助脚本同步显示名称，不宣称同步全部能力。需要精确图像/上下文能力时应先在目标账号上验证。

## 分组、计费身份和路由

稳定别名结构为 `na.<site-hash>.<group-base64url>.<profile-base64url>.<protocol>.<model-base64url>`。ID 可解码，不能用来藏秘密。`api.id` 保留别名，发送前再检查当前账号元数据、站点、分组、计费身份和请求路径；通过后才还原远端模型名。原始模型名、错误组、错误站点或错误协议请求会被拒绝。模型列表查询失败也不会跳过这项校验。

同一组中个性化倍率或身份不同的账号，应使用不同的 profile 名称，例如 `standard` 与 `vip`，以免同 ID 的首模型覆盖另一份价格说明。`multiplier` 可省略，显示“倍率未知”；它只是用户声明的展示信息。首版不自动抓取 `/api/pricing`，也不把倍率推成美元价格。Magpie 当前转换插件价格时不完整保留缓存项，零价与未知价格也不能据此区分，因而不要把其价格统计当远端账单。

直接请求固定组入口，只能尝试该入口所属组和 profile 的 key。同组 key 返回可重试错误时由 Magpie 原生调度决定故障切换，插件自身不重试。跨组需用户显式建立 Magpie 路由组，例如 `magpie group add ... models=<固定组入口1>,<固定组入口2> routing=order`。供应商 fallback 也是显式路由配置，会影响最终目标，使用前应审查；插件不会替用户设置。

`auto` 组首版拒绝。New API 的 auto 和 cross-group retry 是远端行为，推理 key 的额度响应不能证明其实际候选组，无法承诺“固定组绝不在远端换组”。需要这一保证时请使用远端固定分组 key，核对站点设置。账号 pin、候选排序、会话粘性、重试和流中断行为由 Magpie 决定。已验证账号 pin 不改用其他 key；首段内容已发出后的流中断或取消不重放。

## 模型与协议

默认从 key 的 `/v1/models` 读取模型，按保守的 Chat Completions、文本能力暴露。该接口本身通常不足以声明 tools、image、context、reasoning 等能力，插件不猜测。

站点配置 `models` 非空时使用显式列表，不再请求模型发现接口；每项可以设置 `protocol: chat | responses | messages`、`context`、`output`、`tools`、`image`、`reasoning`。这是手动能力声明，远端仍可拒绝。每个 raw model 在一个站点中只声明一种默认协议。只转发对应的 `/v1/chat/completions`、`/v1/responses` 或 `/v1/messages`；不支持图像生成、embeddings、rerank、Gemini、WebSocket 或视频接口。

请求正文除模型名外保持原样，调用方认证、cookie、分组覆盖 header 不转发，真实 key 仅发送到绑定站点。拒绝重定向，取消信号传递给上游。HTTP 错误与 SSE 内容透传，不人为重试以免重复计费。

## 额度

使用推理 key 只读查询 `/api/usage/token/`。`total_granted`、`total_used`、`total_available` 必须是非负安全整数且一致，否则返回未知额度错误。限额显示为 **Token 额度**，不称为钱包余额；不限额 key 不表示共享钱包无限。`expires_at` 是 key 到期时间，不是套餐窗口重置。没有猜测额度单位到货币的换算，站点钱包、套餐共享池和账户余额不在首版范围。

在未部署真实 New API 的前提下，已验证固定源码协议和假站点测试。分叉站点、历史版本、个性化计价、真实多媒体/工具行为与远端账单仍需用户在各自站点核对。
