# 更新日志 / Changelog

这里只记录本地工程有依据的版本变化，不将本地构建等同于 GitHub Release 或商店发布。
0.5.68 起的条目来自本次维护会话及已执行的构建验证；更早版本的日期和完整历史未重建。
日期表示本地变更日期，不代表线上发布日期。

This log records evidenced local project changes, not assumed GitHub or store releases.
Entries start at 0.5.68 using changes and build verification from the current maintenance
session. Earlier dates and complete history have not been reconstructed. Dates identify
local changes, not public release dates.

## 0.5.73 — 2026-10-27

- 补齐公开维护者 storliu 及原始项目仓库地址，同步中英文说明、归属、源码获取和贡献文档。
- 隐私和独立授权申请可通过项目 Issue 请求私密联系渠道，不公开敏感信息；安全私密报告入口仍需另行启用和核实。
- Updated bilingual guides, attribution, source access, and contribution documentation with maintainer storliu and the canonical repository.
- Documented project issues for requesting private privacy/licensing contacts without posting sensitive details; private vulnerability reporting still requires separate enablement and verification.

## 0.5.72 — 2026-10-26

- 将 Gemini 验证脚本中的个人账号样例改为 example.com 虚构账号。
- 扩充 Git 忽略规则，排除密钥、凭据、浏览器数据、对话导出及网络抓取文件。
- 增加公开文件及 Git 暂存内容检查、提交前钩子与 GitHub noreply 身份检查，并在打包前运行隐私检查。
- 验证暂存区与工作文件不一致、强制添加密钥、对话 JSON 导出和提交拦截；报告不输出命中值。
- Replaced personal account examples in Gemini verification with a synthetic example.com account.
- Expanded Git exclusions for keys, credentials, browser data, conversation exports, and network captures.
- Added publication/index checks, a pre-commit hook, and explicit GitHub noreply identity checks; builds scan before packaging.
- Verified staged/worktree divergence, force-added keys, conversation JSON exports, commit blocking, and redacted reports.

## 0.5.71 — 2026-10-26

- 新增中英双语贡献指南、安全报告说明、独立授权申请说明和本更新日志，并在两份 README 中链接。
- 四份公共文档纳入对应源码归档；内部计划、研究记录及本机配置继续排除。
- 明确安全私密渠道尚待配置，独立授权取决于实际再授权权利，不限制已授予的 GPL 商用权利。
- Added bilingual contribution, security-reporting, alternative-licensing, and changelog documents, linked from both READMEs.
- Included the four public documents in source snapshots while continuing to exclude private plans, research, and local configuration.
- Documented pending private security contacts and rights-dependent alternative licensing without restricting existing GPL commercial rights.

## 0.5.70 — 2026-10-26

- 原始项目代码采用 GPL-3.0-only，补齐许可全文、项目归属和 React、React DOM、Scheduler 的 MIT 声明。
- 中英文 README 移除原先的商业审批限制；设置页增加离线许可和源码入口。
- 安装包附带与版本及构建标识绑定的 corresponding-source.zip，含项目源码、构建脚本及运行时依赖副本。
- 构建和重新打包校验许可材料及源码文件哈希；验证许可损坏会阻止打包并保留有效旧包。
- Adopted GPL-3.0-only for original code with full license, attribution, and runtime dependency notices.
- Removed earlier commercial-approval wording and added offline license/source access from Settings.
- Bundled a source snapshot bound to its version/build ID with build scripts and runtime package copies.
- Verified license/source integrity and preservation of the valid archive when licensing checks fail.

## 0.5.69 — 2026-10-26

- 补齐独立英文 README，与中文使用指南互相链接，并如实说明 Codex 辅助开发。
- 新增中英双语隐私政策及脚本无关的离线阅读页，设置中提供入口。
- 增加政策文本一致性、双语导航和打包完整性检查；公开联系渠道保持待定。
- Added the English README and language navigation, with factual Codex development attribution.
- Added bilingual privacy disclosures and a script-free offline policy page accessible from Settings.
- Verified policy text parity, language navigation, and inclusion in the distribution; public contact details remained pending.

## 0.5.68 — 2026-10-26

- 整理公开 README 与 Git 忽略规则，排除构建产物、内部文档、研究数据和本机配置。
- 将公开界面和说明中的特定浏览器环境品牌改为通用 Chromium 表述。
- 增加公开内容及产物检查，并在存在 Git 仓库时拒绝已跟踪或暂存的忽略文件。
- 浮动面板验证改为依赖公开 README，验证不含内部文档的公开检出仍可运行相关检查。
- Organized public documentation and Git exclusions for output, private documents, research, and local configuration.
- Replaced environment-specific branding in public UI/documentation with generic Chromium wording.
- Added publication checks, including detection of tracked or staged ignored files in Git repositories.
- Removed the floating-panel check's private-document dependency and checked a public-source-only snapshot.
