# 更新日志 / Changelog

这里只记录本地工程有依据的版本变化，不将本地构建等同于 GitHub Release 或商店发布。
0.5.68 起的条目来自本次维护会话及已执行的构建验证；更早版本的日期和完整历史未重建。
日期表示本地变更日期，不代表线上发布日期。

This log records evidenced local project changes, not assumed GitHub or store releases.
Entries start at 0.5.68 using changes and build verification from the current maintenance
session. Earlier dates and complete history have not been reconstructed. Dates identify
local changes, not public release dates.

## 0.5.79 — 2026-10-29

- 优化中英文 README 的产品定位、功能关键词及安装导航，补充本地归档流程图。
- 区分已构建的扩展安装包与 GitHub 源码 ZIP，保留当前对话、置顶收录及长对话采集限制。
- Improve bilingual README positioning, feature keywords and installation navigation, with a local archive flow diagram.
- Distinguish built extension packages from GitHub source ZIPs while preserving current-conversation, pinned-only and long-conversation capture limits.

## 0.5.78 — 2026-10-29

- 在代理规范中要求每次 Git 提交前检查实际暂存内容及提交元数据，并执行隐私扫描；禁止提交或上传隐私数据及绕过检查。
- Require privacy scanning and manual review of staged content and commit metadata before every Git commit; prohibit committing/uploading private data or bypassing checks.

## 0.5.77 — 2026-10-28

- ChatGPT 仅使用账号控件明确提供的邮箱生成独立账号键，侧栏姓名仅作标签；缺少或冲突的邮箱进入未识别分组。
- 保存、查询、置顶、分享及接口采集绑定账号，取消启动及导入时的全账号合并；历史记录、附件、权限、排除和手动标签保守保留。
- 补充合成账号切换、重名、改名、身份消失及导入回归验证，同步架构、双语说明和隐私政策。
- Derive separate ChatGPT account keys only from explicit profile email evidence; display names remain labels and missing/conflicting evidence stays unassigned.
- Scope saves, lookups, pins and capture tasks by account; remove startup/import account collapsing while retaining historical data and user metadata.
- Add synthetic account isolation/import verification and update architecture, bilingual guides and privacy disclosures.

## 0.5.76 — 2026-10-28

- 修正 ChatGPT 账号说明及代码注释：已支持显示名称识别，存储仍统一使用历史 `unknown` 键。
- 明确同一浏览器配置文件切换 ChatGPT 账号不会分组隔离，自动标签可能变化；本次未更改存储行为。
- Corrected ChatGPT account documentation and comments: display-name detection is implemented while storage retains the legacy `unknown` key.
- Documented the shared account group and changing detected label when switching ChatGPT logins within one browser profile; storage behavior is unchanged.

## 0.5.75 — 2026-10-28

- 补齐 Gemini 分享页 DOM 采集及四种侧边栏选项，不使用调试器、不刷新原对话。
- 核对原页账号、文档、分支、分享末轮锚点和完整 DOM；跨页丢弃页面局部序号，保留已有正文及附件。
- 检查并修复本页 DOM 滑动采集的消息序号缺口、取消失效及旧附件补齐历史后的定位问题；隐藏复制控件不进入新正文。
- Added Gemini DOM share capture and all four sidebar choices, without debugger access or source reload.
- Bind source account/document/branch, share-head text and complete DOM coverage; discard page-local cross-document indexes and preserve existing text and attachments.
- Fixed current-page DOM gap detection, cancellation and legacy attachment positioning when older history is prepended; omit hidden copy controls from new text.

## 0.5.74 — 2026-10-27

- 新增 Gemini 本页接口与分享页接口采集，读取精确目标自然返回的分帧响应，不调用或重放私有接口。
- 核对原生父链、所选回答、历史终点和完整页面正文／代码；过滤隐藏显示注释及建议动作参数，不推定接口消息时间。
- 保留发起账号与文档绑定、刷新前检查、独立附件授权；短分享链接仅在手动启动时无凭据展开。
- 更新双语说明、隐私政策与合成回归验证。
- Added Gemini current-page and share-page network capture using bounded reads of naturally returned framed responses.
- Verify native parent/selected-answer history, terminal boundaries and full rendered prose/code; omit hidden directives and action queries, never infer message times.
- Preserve source account/document checks, safe refresh and independent attachment permissions; expand manually supplied short links without credentials.
- Updated bilingual documentation, privacy disclosures and synthetic regression verification.

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
