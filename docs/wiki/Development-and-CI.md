# 开发、CI 与文档维护

运行用户从[安装与更新](Installation-and-updates.md)开始。本页面向维护者；源码许可证为 MIT。

## 本地检查

需要 Node.js 22+、npm、Git 和 tar。准备依赖和固定 SDK 对应的官方宿主编译器：

```sh
npm ci --ignore-scripts
npm run host:prepare
export PASEO_COMPILER_PATH="$PWD/.build/host/package/dist/server/server/plugins/compiler.js"
npm run check
npm run host:smoke
npm run package
```

`host:prepare` 下载检查所用的官方 server 包到忽略目录 `.build/`，不会安装或启动用户的 daemon。`check` 包括文档链接、版本一致性、TypeScript、测试和双运行时编译。设置 `PASEO_COMPILER_PATH` 后会再用官方编译器验证边界。

`host:smoke` 使用官方 bundle 执行器、设置存储和任务存储，验证配置迁移、保存后 RPC 顺序、任务元数据与通知路由；会话 SDK 和外部发送使用替身，不运行真实 AI、不发送实际通知。

`package` 用 npm 白名单生成 `.tgz`，检查排除项，在没有开发依赖的解压目录用宿主编译器验证双入口，并写入 SHA-256 与 `release.json`。`package:check` 做同样验证但不保留输出。安装包包含插件源码、概述、README、许可证及 Wiki 源文件，不包含凭据、运行数据、依赖或测试。

## CI

[Checks](https://github.com/Makiras/paseo-notify-ts/actions/workflows/ci.yml) 在 main 推送、PR 和手动触发时运行，矩阵为 Node.js 22 / 24。两组都运行完整检查、宿主冒烟和打包，Node.js 22 上传安装构件，保存 14 天。

CI 默认只有读取仓库权限。发布流程复用同一组检查；发布阶段单独获得 `contents: write`，只有检查通过后才创建 Release。

## 发布一个版本

项目约定：**创建或推送版本标签时，必须一并完成对应的正式 Release**。标签推送只是开始；继续跟进 Release 工作流，确认页面已公开且三个下载文件齐全、校验正确后，才算发布完成。失败时修复或重跑原工作流，不能把仅有标签的状态报告为已发布。

维护者决定语义版本号：修复增加 patch，新功能增加 minor，不兼容调整增加 major；CI 不根据每次提交猜测版本。

```sh
npm run version:set -- 0.2.2
```

该命令同步 `package.json`、锁文件和 `shared/version.ts`。补充变更说明，执行检查，把变更提交到 main，并等待 Checks 成功。随后在同一提交创建、推送标签：

```sh
git tag -a v0.2.2 -m "Release v0.2.2"
git push origin v0.2.2
```

[Release](https://github.com/Makiras/paseo-notify-ts/actions/workflows/release.yml) 核对标签与文件版本一致、提交属于 main，并运行完整检查。发布任务再次核对构件中的版本、提交、文件名和 SHA-256；先创建草稿、上传三个文件，再公开发布：

- `paseo-notify-ts-X.Y.Z.tgz`：可安装源码包。
- 同名 `.sha256`：归档校验值。
- `release.json`：版本、标签、提交、Paseo 要求、归档名和校验值。

已公开的 Release 不被覆盖；需要修正时发布新版本。失败留下的草稿可以通过重跑原标签工作流继续。普通 main 的 CI 包可能包含尚未发布的变更，不会被自动检查当作正式新版。

上面的版本号是示例，以本次待发布且尚未使用的版本为准。发布后从 Release 下载三个文件，核对归档 SHA-256、`release.json` 的版本和提交号，并为用户补充清晰的变更说明。

## Wiki 维护与发布

`docs/wiki/` 是页面源文件；首页为 `Home.md`，侧栏为 `_Sidebar.md`。每页解释一个功能，用户步骤与技术原理分别维护。页面之间使用相对 `.md` 链接，便于仓库和离线阅读。

```sh
npm run docs:check
npm run wiki:publish -- --output /tmp/paseo-notifier-wiki-preview
```

预览命令只写出转换后的页面，不推送。正式发布使用现有 GitHub CLI 登录身份：

```sh
npm run wiki:publish
```

发布器把页间链接转换为 GitHub Wiki 地址，只同步本项目管理的页面，保留其他页面；没有变化时不创建提交。

GitHub 要求先在网页创建一个 Wiki 首页，之后 `.wiki.git` 才能克隆和推送。首次使用需在[仓库 Wiki](https://github.com/Makiras/paseo-notify-ts/wiki)创建并保存 `Home`，然后执行发布命令；这不是启用 Wiki 开关就能完成的步骤。依据：[GitHub 官方 Wiki 说明](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages#cloning-wikis-to-your-computer)。

当前 Wiki 使用维护者命令发布，不依赖 Actions Token 对 Wiki 的写入权限，也不要求增加 PAT。Wiki 尚未初始化时，所有页面仍可在[仓库文档目录](https://github.com/Makiras/paseo-notify-ts/tree/main/docs/wiki)阅读。
