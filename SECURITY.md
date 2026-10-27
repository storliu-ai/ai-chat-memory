# 安全政策 / Security Policy

[中文](#中文) | [English](#english)

## 中文

### 报告渠道与当前状态

项目仓库为 [storliu-ai/ai-chat-memory](https://github.com/storliu-ai/ai-chat-memory)，维护者为
[storliu](https://github.com/storliu-ai)。专用安全联系方式和 GitHub 私密漏洞报告入口目前尚未配置或核实。
添加本文件本身不会启用 GitHub 的 Private vulnerability reporting。

仓库启用该功能后，优先使用仓库安全页的 **Report a vulnerability** 按钮提交私密报告。
维护者需先在仓库设置中启用私密漏洞报告，再确认该入口可用。

如果看不到该按钮，也没有已公布的私密联系方式，可以只创建一个请求私密联系渠道的
[Issue](https://github.com/storliu-ai/ai-chat-memory/issues/new)，例如“Request a private security contact”，不包含漏洞类型、利用步骤、影响目标、
截图、PoC 或私人数据。等待维护者提供渠道后，再私下发送细节。
现有测试用户也可通过取得测试版本时的原有渠道联系维护者。

GitHub 的官方操作说明见[私密报告漏洞](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)。

### 私密报告中提供什么

- 受影响的扩展和浏览器版本、运行平台，以及相关采集或权限设置。
- 问题涉及的组件、必要前提、最小复现步骤和预期影响。
- 尽量使用虚构对话、测试文件和自己的隔离配置文件，提供最小 PoC。
- 可行时说明临时缓解办法；不要发送令牌、Cookie、真实对话或完整原始网络响应。

优先关注扩展边界内的未授权数据读取、跨上下文消息验证、归档或共享目录越权访问、
恶意导入、脚本执行、附件处理和误写入等问题。第三方网站自身的漏洞需要其对应渠道处理。

### 版本与协调披露

安全修复优先针对最新版本评估；旧版本回补按具体问题决定，目前没有长期维护分支承诺。
请在修复或协调披露前保持利用细节私密。维护者核实后会视需要更新源码、版本说明和
安全公告；本文件不承诺固定响应/修复时间、奖励或尚不存在的审计结论。

普通功能故障、使用问题和建议请按 [CONTRIBUTING.md](CONTRIBUTING.md) 提交。
用户数据处理说明见 [PRIVACY.md](PRIVACY.md)。

## English

### Reporting channel and current status

The project repository is [storliu-ai/ai-chat-memory](https://github.com/storliu-ai/ai-chat-memory),
maintained by [storliu](https://github.com/storliu-ai). A dedicated security contact and GitHub private reporting
endpoint have not yet been configured or verified. Adding this file does not itself
enable GitHub Private vulnerability reporting.

After the repository enables that feature, prefer its **Report a vulnerability** button
on the security page. The maintainer must enable and verify the feature first.

If that button is absent and no private contact is published, open only an [issue](https://github.com/storliu-ai/ai-chat-memory/issues/new) requesting
a private contact, such as “Request a private security contact.” Include no vulnerability
type, exploit instructions, affected target, screenshots, PoC, or private data. Wait for a
private channel before sending details. Existing testers may also use the channel through
which they received their test build.

See [GitHub's private reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

### What to include privately

- Affected extension/browser versions, platform, and relevant capture or permission settings.
- Affected component, prerequisites, minimal reproduction, and expected impact.
- A minimal PoC using synthetic conversations, test files, and your own isolated profile.
- A potential mitigation if known. Do not send tokens, cookies, real conversations,
  or full raw network responses.

Relevant extension issues include unauthorized reads, cross-context message validation,
archive or shared-directory access control, malicious imports, script execution,
attachment handling, and unintended writes. Vulnerabilities in the host websites themselves
belong in those vendors' reporting channels.

### Versions and coordinated disclosure

Security fixes are evaluated against the latest version first. Older-version backports
depend on the issue; no long-term support branch is promised. Keep exploit details private
until a fix or coordinated disclosure. Verified issues may result in code, release-note,
and advisory updates. No fixed response/fix deadline, reward, or completed audit is promised.

Use [CONTRIBUTING.md](CONTRIBUTING.md) for ordinary bugs and proposals.
See [PRIVACY.md](PRIVACY.md) for user-data handling.
