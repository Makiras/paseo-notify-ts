# 项目约定

## 版本标签与正式发布

用户已明确要求：创建或推送 `vX.Y.Z` 版本标签时，一并完成对应的 GitHub 正式 Release。这是本项目持续有效的发布偏好，不以只推送标签作为完成。

使用现有 `.github/workflows/release.yml`，等待检查和发布任务成功；若失败，修复或重跑并跟进结果。完成时确认 Release 已公开、标签对应目标提交，安装包、SHA-256 和 `release.json` 均已上传且校验一致，再提供发布链接。已公开的版本标签和安装包不覆盖，代码修正使用新版本。

具体命令及版本规则见 `docs/wiki/Development-and-CI.md`。
