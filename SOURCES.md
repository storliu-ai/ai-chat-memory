# 对应源码 / Corresponding Source

## 中文

本项目的原始代码采用 GPL-3.0-only，全文见 [LICENSE](LICENSE)，归属说明见
[COPYRIGHT](COPYRIGHT)，运行时依赖许可见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。

每个通过验证的扩展安装包都包含 `corresponding-source.zip`。它提供本次构建对应的
项目源码、界面静态资源、构建和验证脚本、依赖锁文件、项目说明，以及本次使用的
React、React DOM、Scheduler 运行时依赖副本和原许可。归档内的 `SOURCE_MANIFEST.json`
记录版本、构建标识及文件 SHA-256，便于核对。

在扩展管理器的设置页打开“开源许可与源码”，可以下载该归档；也可以直接解压安装包
取得它。原始项目仓库为 [storliu-ai/ai-chat-memory](https://github.com/storliu-ai/ai-chat-memory)，
但各安装包所附的归档才对应其具体构建；仓库默认分支可能已有后续修改。

构建需要 Node.js 22、npm，以及打包步骤使用的 `zip` 和 `unzip` 命令。
解压源码归档后，在包含 `package.json` 的目录中运行：

```bash
npm ci
npm run typecheck
npm run lint
npm run build
```

`npm ci` 根据锁文件从所配置的包注册表下载构建依赖，需要网络连接。
随后生成可加载的 `dist/` 和版本 ZIP。原始构建标识与时间每次不同，不承诺压缩包逐字节相同。

源码归档不包含用户对话、账号数据、浏览器目录句柄、内部计划、研究记录或本机配置。
原样再分发时应保留许可与对应源码；分发修改版本时还须按 GPL 标明修改，并提供
实际对应修改版的源码，不能仅附上本项目未修改的旧归档。

## English

Original project code is licensed under GPL-3.0-only. See [LICENSE](LICENSE),
[COPYRIGHT](COPYRIGHT), and the runtime dependency licenses in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

Every verified extension package includes `corresponding-source.zip`, containing
the project source matching that build, static UI assets, build and verification
scripts, the dependency lockfile, project documentation, and copies of the React,
React DOM, and Scheduler runtime packages used, with their original licenses.
`SOURCE_MANIFEST.json` records the version, build identifier, and file SHA-256 hashes.

Open the license/source page from the manager's Settings to download the archive,
or extract it directly from the extension package. The canonical repository is
[storliu-ai/ai-chat-memory](https://github.com/storliu-ai/ai-chat-memory).
Use the included archive for the source matching a specific build; the default branch may contain later changes.

Building requires Node.js 22, npm, and the `zip` and `unzip` commands used during
packaging. Extract the source archive, then run the commands above from its
`package.json` directory. `npm ci` downloads locked build dependencies from the
configured package registry and requires network access. The build produces
`dist/` and a versioned ZIP. Build identifiers and timestamps change each time;
byte-for-byte identical archives are not promised.

The archive excludes user conversations, account data, browser directory handles,
private plans, research captures, and machine-specific configuration. Preserve
license and source materials when redistributing unchanged packages. When
distributing modifications, identify them and provide their actual Corresponding
Source under the GPL; the original unmodified source archive is not sufficient.
