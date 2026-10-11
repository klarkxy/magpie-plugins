# magpie-plugins

面向 Magpie 的独立工具包，根目录是 `private` workspace，各包独立版本、入口和安装。当前两个包均为 `0.1.0`，接口尚未稳定。

| 包 | 用途 | 安装入口 |
| --- | --- | --- |
| [new-api](packages/new-api/README.md) | 一个 New API 站点一个供应商，多 key 作为账号；固定组模型别名与发送校验 | 本地生成的站点 `.mjs` 文件 |
| [quota-collector](packages/quota-collector/README.md) | 本地采集脱敏额度与 token 证据 | 独立 CLI，按需运行 |

仓库地址不是所有子包的自动安装入口。没有发布 npm，没有提交 Magpie 市场 PR。无需依赖安装即可运行脚本（Node.js 22+）。Magpie 自身以 Bun 运行 provider 插件。

```sh
git clone https://github.com/klarkxy/magpie-plugins.git
cd magpie-plugins
npm test
```

未设置真实宿主测试的环境变量时，两个 native 测试会明确 skip；这不代表原生调度已经验证。完整运行方式见 [验证记录](docs/verification.md)。

已经核对双方源码并以真实 Magpie/Bun、隔离 HOME 和假 New API 服务测试。实现依据及限制见 [源码调查](docs/source-review.md)，采集字段依据见 [额度与 usage 字段](docs/quota-evidence.md)。

不要提交站点配置、账号配置、key、采集状态或导出。示例只有保留域名和虚构占位值。生成文件放在 `generated/`，该目录已忽略。采集器不自动上传，不设置开机自启；New API 插件不请求管理账户或管理员权限。
