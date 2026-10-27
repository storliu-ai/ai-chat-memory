# 贡献指南 / Contributing

[中文](#中文) | [English](#english)

## 中文

感谢你帮助改进 AI Chat Memory。修改前请阅读 [README](README.md)、
[AGENTS.md](AGENTS.md) 和 [ARCHITECTURE.md](ARCHITECTURE.md)。

### 提交 Issue

- 先检索现有 Issue，避免重复；一个 Issue 聚焦一个问题或建议。
- Bug 报告请包含扩展版本、浏览器及版本、平台、采集方式、复现步骤、预期和实际结果。
  如涉及长对话、附件、共享目录或多个配置文件，请补充相应设置与出错阶段。
- 优先使用虚构的最小对话。截图请遮盖私人信息，不提交真实对话、账号邮箱、Cookie、
  令牌、完整网络响应或能访问私人内容的分享链接。
- 功能建议请说明实际使用场景、现有功能为何不足，以及对本地存储和权限的影响。
- 疑似漏洞不要公开细节，请按 [SECURITY.md](SECURITY.md) 处理。

### 提交 Pull Request

1. Fork [项目仓库](https://github.com/storliu-ai/ai-chat-memory)或从默认分支创建独立分支；提交前同步默认分支。
2. 一个 PR 解决一个明确问题，说明触发条件、修改后的行为和相关 Issue。
3. 保留用户数据和无关改动；站点选择器与 DOM 解释放在对应 adapter 内。
   不扩展隐私边界，不加入遥测、认证信息读取或私有接口调用。
4. 提取或容易回归的行为需要聚焦验证脚本；界面改动可附脱敏截图。
   中英文 README、隐私政策及其他双语文档需同步更新。
5. 提交前运行下面的检查，在 PR 中记录实际结果与尚未验证的边界。
6. 不提交生成产物、ZIP、依赖目录、内部计划、研究数据或本机配置，不强制添加忽略文件。

开发需要 Node.js 22、npm，以及打包使用的 zip、unzip 命令：

```bash
npm ci
npm run verify:secrets
npm run typecheck
npm run lint
npm run build
```

迭代时可运行相关的 verify 命令，例如 verify:chatgpt、verify:gemini、
verify:capture-windows、verify:attachments、verify:privacy 和 verify:license。
完整构建会再次运行仓库验证。实际浏览器测试需要重新加载扩展，并刷新已打开的 AI 标签页。

`npm ci` 在 Git 检出中安装本仓库的提交前检查；之后初始化 Git 时需运行
`npm run setup:git-hooks`。提交前使用仓库级 Git 配置选择公开署名和 GitHub noreply 邮箱，
详见 README 的 Git 提交范围。钩子检查实际暂存内容及提交身份，不输出敏感值；
请人工检查暂存差异，不提交真实对话夹具，不绕过检查。

可分发改动需同步递增 package.json、package-lock.json 根条目和 public/manifest.json
中的版本，并在 [CHANGELOG.md](CHANGELOG.md) 记录实际改动。不要填写尚未执行的测试、
不存在的发布记录或未经核实的修复效果。

### 许可与 AI 辅助贡献

除另有明确书面约定外，提交并接受的项目代码贡献采用 GPL-3.0-only，贡献者保留版权。
请确保你有权提交所用代码，并保留第三方许可和来源声明。
合并 PR 不代表贡献者转让版权，也不自动授予维护者将该贡献按非 GPL 条款再授权的权利；
相关说明见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

允许 AI 辅助开发，但提交者仍需理解、审阅改动并核实测试。不要把私人对话、令牌或
未经授权的用户数据作为公开示例、测试夹具或提示记录提交。

## English

Read the [README](README.en.md), [AGENTS.md](AGENTS.md), and
[ARCHITECTURE.md](ARCHITECTURE.md) before editing.

### Issues

- Search existing reports and keep each issue focused on one problem or proposal.
- Include extension/browser versions, platform, capture method, reproduction steps,
  and expected/actual behavior. Describe relevant attachment, directory, long-conversation,
  or multi-profile settings and the stage where a failure occurs.
- Prefer a minimal synthetic conversation. Redact screenshots. Do not attach real
  conversations, account emails, cookies, tokens, raw network responses, or private share links.
- Feature proposals should explain the use case, the current limitation, and implications
  for local storage and permissions.
- Report suspected vulnerabilities through [SECURITY.md](SECURITY.md), not public details.

### Pull requests

1. Fork the [project repository](https://github.com/storliu-ai/ai-chat-memory) or create a branch from its default branch;
   synchronize with that branch before submitting.
2. Address one concrete problem. Explain the trigger, resulting behavior, and related issue.
3. Preserve user data and unrelated changes. Keep host selectors and DOM interpretation
   inside their adapters. Do not add telemetry, credential access, or private API calls.
4. Add focused verification for extraction or regression-prone changes. Provide redacted
   screenshots where useful, and update both language versions of affected documentation.
5. Run the checks above and report actual results and remaining validation limits.
6. Do not commit build output, ZIPs, dependencies, private plans, research captures,
   machine configuration, or force-added ignored files.

Use Node.js 22, npm, zip, and unzip. Focused verify scripts can help during iteration;
the complete build reruns repository verification. Browser testing requires reloading
the extension and refreshing existing AI tabs.

`npm ci` installs the repository pre-commit check in a Git checkout. If Git is initialized later,
run `npm run setup:git-hooks`. Choose a public name and GitHub noreply email in local Git configuration
as described in the README. The hook inspects staged contents and commit identity without printing
sensitive values. Review staged changes manually, use synthetic conversation fixtures, and do not bypass it.

Distributable changes need matching version increments in package.json, the root lockfile
entries, and public/manifest.json, plus factual [CHANGELOG.md](CHANGELOG.md) entries.
Do not claim tests, releases, or fixes that have not been verified.

### Licensing and AI assistance

Unless explicitly agreed otherwise in writing, submitted and accepted project code
contributions use GPL-3.0-only and contributors retain copyright. Ensure you have the
right to contribute the code and preserve third-party licensing and provenance.
Merging a PR does not assign copyright or automatically permit non-GPL relicensing;
see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

AI-assisted contributions are welcome. The submitter remains responsible for understanding,
reviewing, and validating the change. Never submit unauthorized user data, private conversations,
or credentials in examples, fixtures, or prompt records.
