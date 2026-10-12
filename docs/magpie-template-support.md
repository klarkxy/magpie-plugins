# 通用模板与 GUI 扩展边界

0.2 已实现一个包、一条 plugins.json 记录、任意多个 `options.sites` 实例；各站独立供应商和原生账号池。实例管理 CLI 不读写凭证，连接账号仍走 Magpie 原生登录。没有通过一个共享 provider 把多个站点的 key 混在一起，也没有每站生成代码文件。

现有 Magpie API 不让 provider 插件注册 Custom API 创建表单。config hook 声明 provider 属性；auth hook 提供该账号的连接问题；provider hook 提供该账号的模型，它们都不是站点 CRUD 表单。原生 plugin options CLI/API 可保存 JSON，但 GUI optionsEditor 的按钮和展开条件都仅针对 middleware。当前实现明确是“单安装、多实例配置”，尚不是完整 GUI 模板。

## 最小核心支持方案（未修改或安装核心）

第一步可复用现有 optionsEditor：在 `internal/gui/assets/plugins.js` 的插件 row 和绘制编辑区域的条件中，允许普通 provider 插件进入编辑器；同一 `POST /api/plugins/options` 已经支持 options，不需新凭证接口。需要提供清楚的非秘密选项说明，保留 middleware 现有行为。验收：普通 provider 可打开/保存/取消 JSON，保存后多站实例生效；空对象、重复URL、非法JSON、key字段保持失败关闭；已有 key 不被编辑器读取或写入。

要得到用户要求的 Custom API 式表单，最小契约应再增加插件的 **可选实例配置 schema**（名称、base URL、profiles、models），从插件 manifest 到 pluginsJSON 暴露给 GUI；沿用上述 options 存储，只编辑 sites 中的一个实例，增删改不改其他实例。key 不属于 schema，表单保存后再转到原生账号登录。需要验证未配置实例、同名不同URL、重复URL、重命名ID稳定、URL变更新身份、多个key、删除实例保留凭证、错误回滚和活动请求不被截断。

长期更稳健的宿主契约是允许一个 server 返回多个 hooks，或提供明确的 provider 注册方法；这样无需依赖 CommonJS 的动态导出和宿主工作目录。涉及 auths/info/fetch/usage/proxies 的 provider-to-spec 关联，需要保证注册来源是同一个插件、每个provider单独寻址。当前可运行方案已做真实宿主测试，不把这个未来契约当成已有功能。

这份方案不授权替换用户 Magpie 二进制或发布上游 PR；本次仅更新插件仓库和本地插件安装。
