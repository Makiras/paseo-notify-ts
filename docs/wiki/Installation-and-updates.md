# 安装与更新

本页介绍安装、更新和重新加载。首次配置接收群组见[快速上手](Quick-start.md)。

## 从 GitHub 安装

在 Paseo 的「设置 → 插件」选择目标 Host，在安装来源中填写：

```text
git:Makiras/paseo-notify-ts
```

也可以在该 Host 的终端执行：

```sh
paseo plugin install git:Makiras/paseo-notify-ts
```

开启 Paseo 的插件总开关和本插件的启用开关，随后进入「Paseo Notifier → 通知与自动恢复」。插件 ID 是 `paseo-notifier`，与仓库名 `paseo-notify-ts` 不同。

运行环境需要 Node.js 22+。安装时宿主会检查兼容性；普通用户不需要为插件单独安装 npm 运行依赖。

## 网页端如何更新

Paseo 自带的网页插件管理界面目前没有审阅并应用远端更新的入口；本插件提供自己的「版本与更新」区域，可以检查正式 Release，并手动在当前 Host 的工作区终端启动安装。完整操作见[版本与更新检查](Updates-and-releases.md)。

尚未带有该功能的旧安装，需要先在安装插件的 Host 终端更新一次：

```sh
paseo plugin update paseo-notifier --ref v0.2.0
```

可以使用网页工作区终端、SSH 或本机终端。更新完成后重新打开插件设置页；若仍保留旧界面，再刷新浏览器。

有多个本地 daemon 时指定 `--home`，远程连接使用 `--host`：

```sh
paseo plugin update paseo-notifier --ref v0.2.0 --home /path/to/paseo-home
paseo plugin update paseo-notifier --ref v0.2.0 --host <目标-daemon-连接地址>
```

不要同时使用这两个选项。`--host` 填 daemon 连接地址，不是任意浏览器页面 URL。示例标签以实际发布版本为准；指定 `--ref` 会直接应用该目标，无需二次交互确认。依据：[Paseo 插件管理说明](https://paseo.sh/docs/plugins/reference#cli-reference)。

## 更新、Reload 与刷新网页

| 操作                                              | 作用                                     |
| ------------------------------------------------- | ---------------------------------------- |
| `paseo plugin update paseo-notifier --ref vX.Y.Z` | 获取并应用指定正式版本                   |
| `paseo plugin update paseo-notifier`              | 审阅并更新到 Git 远端默认分支            |
| `paseo plugin reload paseo-notifier`              | 重新编译、加载 Host 上已经存在的插件源码 |
| 刷新网页                                          | 刷新当前客户端，不能代替拉取新的插件源码 |

Git 来源的普通更新检查远端默认分支的 HEAD。正常更新会保留 Host 配置和私有凭据，配置格式变化由插件迁移处理；更新失败时宿主保留旧安装。

## 从本地源码安装

```sh
git clone https://github.com/Makiras/paseo-notify-ts.git
cd paseo-notify-ts
npm ci --ignore-scripts
npm run check
paseo plugin install "$PWD"
```

本地目录安装直接引用该目录。获取新源码并完成检查后执行：

```sh
git pull --ff-only
npm ci --ignore-scripts
npm run check
paseo plugin reload paseo-notifier
```

目录来源不通过 `plugin update` 拉取更新。使用远程 Host 时，目录必须存在于远程 Host 上。

## 使用 Release 或 CI 安装包

正式安装包在 [Releases](https://github.com/Makiras/paseo-notify-ts/releases) 下载，附带 SHA-256 和提交元数据。

也可在 [Checks](https://github.com/Makiras/paseo-notify-ts/actions/workflows/ci.yml) 的成功运行中下载 `paseo-notify-ts` Artifact，解压 ZIP 后得到 `.tgz` 和 `.sha256`。将文件放到目标 Host 的同一目录：

```sh
sha256sum -c paseo-notify-ts-0.2.0.tgz.sha256
mkdir paseo-notify-ts-package
tar -xzf paseo-notify-ts-0.2.0.tgz -C paseo-notify-ts-package
paseo plugin install "$PWD/paseo-notify-ts-package/package"
```

macOS 可用 `shasum -a 256 -c` 校验。以实际下载的文件名为准。这种安装方式是目录来源；更新时替换该目录中的源码，再 Reload。已经从 GitHub 安装的用户直接使用 `plugin update`。

相关：[快速上手](Quick-start.md) · [运行状态与排错](Activity-and-troubleshooting.md)
