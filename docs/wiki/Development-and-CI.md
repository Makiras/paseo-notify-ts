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

`host:prepare` 下载检查所用的官方 server 包到忽略目录 `.build/`，不会安装或启动用户的 daemon。`check` 包括文档链接、版本一致性、内嵌依赖一致性、TypeScript、测试和双运行时编译。设置 `PASEO_COMPILER_PATH` 后会再用官方编译器验证边界。

`host:smoke` 使用官方 bundle 执行器、设置存储和任务存储，验证配置迁移、保存后 RPC 顺序、任务元数据与通知路由；会话 SDK 和外部发送使用替身，不运行真实 AI、不发送实际通知。

`package` 用 npm 白名单生成 `.tgz`，检查排除项，在没有开发依赖的解压目录用宿主编译器验证双入口，并写入 SHA-256 与 `release.json`。`package:check` 做同样验证但不保留输出。安装包包含插件源码、内嵌正则引擎、概述、README、许可证及 Wiki 源文件，不包含凭据、运行数据、node_modules 或测试。

模板在客户端预览与服务端发送时共用 `shared/templates.ts`。自定义正则使用固定版本 RE2JS，Pattern、编译程序规模、规则数和来源长度均有上限，不交给原生回溯正则引擎执行。引擎及类型、MIT 许可内嵌在 `shared/vendor/`，宿主无需安装额外 npm 包。生成时先转换类语法，再压缩；Paseo 使用 `eval` 动态加载插件，Android Hermes 的这条路径不能直接使用该依赖原来的类表达式。仅指定 ES2020 或在 Node 中编译通过无法验证这种兼容性。

更新开发依赖后运行 `npm run vendor:update` 重新生成；`check` 中的 `vendor:check` 核对生成结果与锁定依赖一致。模板及提取值不写入投递日志副本，发送时用当前设置渲染，并再次应用摘要隐私限制。

## 真实 Host 与浏览器检查

```sh
npm ci
npx playwright install --with-deps chromium firefox
npm run browser:smoke
```

该测试使用固定版本的官方 Paseo CLI，把 `npm pack` 产物安装到临时 Host，实际启动服务和网页界面。Chromium、Firefox 分别完成：进入插件设置、切换全部栏目、数字范围与整数要求的中文错误提示、模板宽窄屏布局、帮助与规则折叠、示例草稿保留、折叠后的错误规则定位、模板与正则校验、保存与刷新后恢复、ntfy 保存后立即测试，以及窄屏下拉栏目切换。

所有 CLI 操作显式指定临时 `PASEO_HOME`，禁用 relay 和 AI 提供方，不操作现有 Host。通知只发送给测试创建的本地 HTTP 接收器。测试结束停止临时 Host；截图、浏览器错误、trace 和测试 Host 日志保存在忽略目录 `.build/browser-smoke/`。可用 `PASEO_TEST_BROWSERS=firefox npm run browser:smoke` 单独运行一个浏览器。

## Android Hermes 检查

在 Linux 开发环境准备 Git、CMake、Ninja、C++ 编译器和 ICU 开发库后执行：

```sh
npm run hermes:prepare
npm run hermes:smoke
```

`hermes:prepare` 读取锁定 React Native 包中的 Hermes 提交号，获取官方源码并构建运行器；构件保存在 `.build/hermes/`。可通过 `HERMES_PATH` 指定已经准备好的运行器。

`hermes:smoke` 用官方 Paseo 编译器生成插件，再通过 Hermes 的 `globalThis.eval` 加载未经二次转换的插件 bundle。它验证客户端初始化、设置与工作区入口注册、默认配置、正则提取、中文与标志位匹配、非法 Pattern 和摘要隐私限制。测试宿主的 React、Zod 等模块提前转换，模拟原生 App 由 Metro 编译的宿主模块；网络和会话接口使用替身。

这能捕获 v0.3.0 的 `right operand of 'in' is not an object` 回归。它是实际引擎兼容测试，**不等同于 Android 模拟器或真机上的原生 UI 测试**；键盘、系统控件及设备通知展示仍需真机验证。

## CI

[Checks](https://github.com/Makiras/paseo-notify-ts/actions/workflows/ci.yml) 在 main 推送、PR 和手动触发时运行：

- Node.js 22 / 24：完整检查、宿主冒烟和打包；Node.js 22 上传安装构件，保存 14 天。
- `installed-host`：安装并启动真实 Paseo，在 Chromium 和 Firefox 中执行设置页回归；失败时上传浏览器诊断构件，保存 7 天。
- `android-runtime`：构建并缓存与 React Native 对应的 Hermes，执行插件动态加载和模板测试。

CI 默认只有读取仓库权限。发布流程复用全部检查；发布阶段单独获得 `contents: write`，只有包括真实 Host 和 Hermes 在内的所有任务通过后才创建 Release。

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
