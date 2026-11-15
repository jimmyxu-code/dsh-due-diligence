# dsh-due-diligence：DSH「背调」模式插件

[English README](README.md) · [数据来源与边界](docs/DATA-SOURCES.md) · [验证说明](docs/VERIFICATION.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）增加独立的 **「背调」agent preset**：查**人、网名/账号、公司/组织和域名**，只使用免费公开数据源；每条结论带来源 URL、抓取时间和置信度，并可生成结构化 Markdown 报告。

人物调查采用**画像优先**的工作流，而不是只回答「账号是否存在」：通过 Wikidata、引导式网页检索和公开主页元信息，整理基本信息、职业机构、教育、作品、媒体、公开账号、时间线和公开争议。

## 功能

- **人物画像**：真名、别名、公开简介；引导模型完成多轮 `web_search` / `web_fetch`。
- **用户名探测**：内置 Sherlock v0.16.2 站点规则的 Node 原生引擎，含误报排除、WAF 识别和可选二次核验。
- **公司/组织查询**：GLEIF LEI、SEC EDGAR CIK/submissions、Wikidata 候选；中国商业/工商站点只给官方入口，绝不抓取。
- **域名调查**：crt.sh 证书、Wayback 存档、RDAP 注册信息，数据源独立软降级。
- **统一证据信封**：`source`、`url`、`fetched_at`、`confidence`、`detail`。
- **Markdown 报告**：支持人物画像章节、证据表、疑点、下一步和合规声明。
- **零运行时依赖**：纯 ESM + Node 内置模块；不需要 Python、付费 key、登录态或浏览器自动化。

## 环境要求

- DeepSeek Harness **0.2.2-rc.1**（已测试版本）
- 本地开发 Node.js **22+**；实测 **24.21.0**
- 能访问所使用的公开数据源

## 安装

无需 `npm install`，无需构建。

```bash
git clone https://github.com/jimmyxu-code/dsh-due-diligence.git
```

在有插件管理权限的 DSH 会话里执行：

```text
plugin_manager({
  action: "install_bundle",
  target: "/absolute/path/to/dsh-due-diligence"
})
```

也可以通过 **Plugins → Add plugin** 选择本地目录。安装或升级后，**新建会话**并选择 **「背调」**。正在运行的 DSH Host 可能需要重启一次，才能加载更新后的 JavaScript 模块。

卸载：

```text
plugin_manager({ action: "remove_bundle", target: "dsh-due-diligence" })
```

已存在的会话保留启动时的 preset 修订。本插件不修改其它 preset，也不安装 shell/文件等本机工具。

## 工具与示例

| 工具 | 用途 |
| --- | --- |
| `dd_name` | Wikidata 候选与别名、搜索链接，以及可直接用于人物画像检索的 `web_queries`。 |
| `dd_username` | 基于内置 Sherlock 规则的用户名探测；`verify=true` 时还读取公开主页标题和 meta 简介。 |
| `dd_company` | GLEIF、SEC EDGAR、Wikidata 候选，附辖区、状态和下一步。 |
| `dd_domain` | crt.sh、Wayback、RDAP 证据，各源独立失败。 |
| `dd_report` | 写出 Markdown 报告，可包含人物画像章节。 |

在「背调」新会话中可以直接说：

```text
查一下 Sam Altman，给我一份有来源的完整公开人物画像。
查用户名 sherlock，并开启二次核验。
查公司 Apple，找出 SEC CIK 和 GLEIF 候选。
查 example.com 的证书、存档和 RDAP。
把以上结论整理成报告。
```

preset 自带 `web_search` / `web_fetch` 和五个 `dd_*` 工具；**不声明 bash、文件、jobs、subagent、workflow、plugin-manager 等工具**。你的 DSH profile 中已有的全局工具是独立配置，仍可能出现在会话里。

## 配置

报告默认写入 `~/Desktop/背调报告/`。

| 配置 | 作用 |
| --- | --- |
| `DSH_DD_REPORT_DIR` | 覆盖 Host 进程的报告目录。 |
| `DSH_DD_SEC_CONTACT` | 写入 SEC User-Agent 的联系邮箱或项目 URL；默认使用本仓库 issue 页。 |
| preset 的 `tool-dd` 行 `reportDir` | 按 preset 配置报告目录，优先于环境变量。 |

从 shell 启动 Host 时示例：

```bash
export DSH_DD_REPORT_DIR="$HOME/Reports/due-diligence"
export DSH_DD_SEC_CONTACT="you@example.com"
```

不要把凭据、API key 或私人数据写入 `cordis.patch.yml` 或纳入版本控制。

## 人物画像工作流

1. `dd_name`：获得 Wikidata 候选/别名和 `web_queries`。
2. 做 3–6 轮 `web_search`，覆盖简介、采访、作品、机构、教育，中英文都尝试。
3. 用 `web_fetch` 阅读 2–5 个关键公开页面。
4. `dd_username` 查已知或候选 handle；人物调查建议 `verify=true`，再挑高价值主页读取详情。
5. 按 `basics / occupation / education / works / media / accounts / timeline / risks` 汇总画像。
6. `dd_report` 的 `profile` 参数接收画像分区，生成含「人物画像」章节的报告。

原则：**先画像，再标注**。置信度是每条信息的标签，不是省略信息的理由。

## 合规与限制

仅用于合法、授权的公开信息研究：

- 不用于骚扰、跟踪、人肉搜索、歧视或对人的自动化决策。
- 不使用泄露库/社工库，不绕过付费墙，不冒充他人，不抓取明确禁止抓取的平台。
- LinkedIn、X/Twitter、Instagram、Facebook、GSXT、天眼查、企查查、爱企查等**不抓取**。
- 不输出敏感个人信息；公开职业、机构、教育和账号信息也应遵守适用隐私法规。
- 报告不构成 consumer report，不构成法律/投资/雇佣建议，关键结论必须人工复核。

详见 [SECURITY.md](SECURITY.md) 和 [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)。

## 开发与测试

```bash
npm run check:all   # 检查宿主、模块和测试语法
npm test            # 全部单测，mock fetch，不需要真实网络
npm run pack:dry-run
```

测试覆盖 Sherlock 判定、二次核验、数据源适配、统一信封、报告生成和 preset 边界。真实网络验收是可选项，不属于默认单测。

## 目录

```text
index.js                 # Host 入口：注册五个工具
cordis.patch.yml         # 背调 preset、人设和 compaction
lib/                     # 纯 ESM 引擎、适配器和工具定义
data/                    # Sherlock 规则、误报排除和上游许可
locale/                  # 插件管理器展示元数据
test/                    # 离线单测
docs/                    # 架构、数据源和验证说明
```

## 许可

本项目采用 MIT。内置 Sherlock 数据与移植的判定逻辑保留上游 MIT 声明；见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [data/SHERLOCK-LICENSE.txt](data/SHERLOCK-LICENSE.txt)。

第三方数据源适用各自条款。本项目只进行单用户、低频率查询，不额外授予任何第三方数据权利。
