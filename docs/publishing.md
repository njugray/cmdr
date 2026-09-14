# npm 发布

首个版本 `cmdr-mcp@0.1.0` 已发布；本轮目标为 `cmdr-mcp@0.1.1`。npm 包名是 `cmdr-mcp`，CLI、宿主插件和 marketplace 名称仍为 `cmdr`。安装后的包根目录是 `$(npm root -g)/cmdr-mcp`。

## 准备与验证

在 macOS / Linux、Node.js ≥22.5（推荐 24）环境，从仓库根目录执行：

```sh
npm ci
npm run check
npm pack
npm publish ./cmdr-mcp-0.1.1.tgz --dry-run --access public --registry https://registry.npmjs.org/
```

涉及 ZCode 的发布另运行 `npm run verify:zcode`：从实际 tarball 安装到隔离缓存，核对完整性并移走安装源后验证 7 个工具；需要本机 ZCode runtime。

`npm run check` 包括格式、类型、构建、测试以及临时目录中的 npm 包离线安装验证：检查发布资源、安装后 marketplace 路径、CLI 和 7 个 MCP 工具。`npm pack` 通过 `prepack` 生成 4 个运行入口及第三方许可证声明，输出 `cmdr-mcp-0.1.1.tgz`。源码、测试和开发依赖不进入发布包。

检查 `git diff`，确认版本与预期一致，构建未意外修改宿主 manifests。发布前保留经过验证的源码提交；不要手改或提交 `plugins/cmdr/dist/`、`THIRD_PARTY_NOTICES.txt` 和 `.tgz`。

`--dry-run` 不发布包，也不能证明账号有发布权限或包名一定可注册。GUI 安装、信任提示和真实模型协作需单独验证，不能用自动化测试替代。

## 发布新版本

准备完成后，由发布者登录公共 npm，并确认账号和包名：

```sh
npm login --registry https://registry.npmjs.org/
npm whoami --registry https://registry.npmjs.org/
npm view cmdr-mcp name version --registry https://registry.npmjs.org/
```

包已经存在，发布前核对账号的包所有权和目标版本是否尚未发布。网络或身份验证错误不能作为版本可用的依据。账号需要启用 2FA，按 CLI 提供的浏览器链接完成发布授权。

确认发布时，上传已检查的 tarball，并按 npm 提示完成账号验证：

```sh
npm publish ./cmdr-mcp-0.1.1.tgz --access public --registry https://registry.npmjs.org/
```

此命令会公开发布 `0.1.1` 并使用默认的 `latest` 标签。相同包名和版本不能重复发布；后续修改需要提升版本并重新构建验证。发布使用 tarball，以保持上传内容与已检查产物一致。

## 发布后核对

```sh
npm view cmdr-mcp@0.1.1 name version dist.integrity --registry https://registry.npmjs.org/
npm install --global cmdr-mcp@0.1.1 --registry https://registry.npmjs.org/
cmdr --help
```

按照 [安装说明](README.zh-CN.md#安装) 注册安装后的包根目录。已安装宿主有插件缓存，升级后需要刷新或重装；同版本测试代码变动需要重启对应测试 daemon。

npm 命令行为参考：[npm publish 官方文档](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。

## Marketplace 直接安装分发

开发分支继续忽略生成产物。`.github/workflows/marketplace.yml` 在 GitHub Release 发布时运行，也可手动运行 **Publish marketplace**。工作流先完成 `npm run check`，再通过 `npm pack` 生成并校验完整包，最后把解包内容提交到独立的 `marketplace` 分支。该分支只存分发文件，不含开发依赖；各 marketplace 的相对路径直接指向带 `dist/` 的插件目录。更新保留分支历史，不强制推送。

首次部署：提交并推送本次工作流及脚本，在 GitHub Actions 手动运行 **Publish marketplace**，确认成功后再向用户提供 `njugray/cmdr#marketplace`。后续发布 Release 自动更新。工作流需要仓库 `contents: write` 权限；分支保护如禁止自动推送，应由维护者调整。仅本地生成文件不会使远端安装地址生效。

本地验证分发目录（目标目录必须不存在）：

```sh
npm run prepare:marketplace -- /tmp/cmdr-marketplace-release
npm run verify:zcode -- /tmp/cmdr-marketplace-release
```

ZCode 从带 `#marketplace` 的 GitHub 来源选择分支，然后按相对路径缓存完整插件。首次使用仍需要系统提供 Node.js ≥22.5；无需用户运行 npm 安装或构建。不要把默认开发分支的 Git 地址作为成品分发源。
