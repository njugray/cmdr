# cmdr

让本机已经打开的 **Claude Code、Codex、ZCode 和其他支持 MCP 的 Agent** 组成小队：指挥官发任务，执行方汇报、提问，消息按优先级持久化到 SQLite。

[English](../README.md) · [设计方案](cmdr-design-v1.md) · [接入指南](agent-integration.md) · [实现与验证记录](implementation.md)

## 安装

支持 macOS / Linux，需要 Node.js ≥22.5（推荐 24）。Git 只保存源码和插件元数据，打包产物进入 npm 发布包，不提交到仓库。

源码安装先构建，再注册下面的插件市场：

```sh
npm ci
npm run build
```

`npm pack` / `npm publish` 会在 prepack 阶段构建并把 4 个入口、插件资源和许可证声明装入包；安装包不依赖外部运行时 npm 包：

```sh
npm pack
npm install --global ./cmdr-0.1.0.tgz
cmdr --help
```

下面的 `/path/to/cmdr` 可以是已构建的源码目录，也可以是安装后的包目录（`$(npm root -g)/cmdr`）。未经构建的 Git 源码不能直接作为可运行插件安装。本次不执行 npm registry 发布。

Claude Code：

```sh
claude plugin marketplace add /path/to/cmdr
claude plugin install cmdr@cmdr
```

Codex：

```sh
codex plugin marketplace add /path/to/cmdr
codex plugin add cmdr@cmdr
```

Codex 需要启用 hooks，并按提示信任 5 类 cmdr hook。`codex mcp list` 应出现 cmdr；安装后新开会话。没有 hooks 时仍可用 `read(wait)` 和工具返回的未读数协作。

ZCode 桌面端：先打开工作区，在 **设置 → 插件 → 创建 → 添加插件市场** 选择本仓库或根目录 `marketplace.json`，安装 cmdr 后新开会话。原生 `.zcode-plugin` 清单负责 MCP、命令和技能，ZCode 自动发现 4 类受支持的 hooks。

其他 Agent：

```sh
/path/to/cmdr/plugins/cmdr/bin/cmdr config --agent my-agent
```

把输出的 MCP 配置合并到宿主配置。任意合法的 Agent 标识都可接入，不会被冒充为 Codex；无需依赖特定宿主的插件或 hooks 协议。详细的身份、超时和多会话规则见[接入指南](agent-integration.md)。

## 使用

每个会话输入同一个名字：

```text
/cmdr my-project
```

第一个会话创建小队并成为指挥官，其余会话加入为执行方。宿主没有 slash command 时说 `cmdr my-project`，或让 Agent 调用 `join(squad_name="my-project")`。查找与创建在同一事务内完成，避免并发重名。已有孤立小队时，需要明确选择接管或加入。

执行方加入后 `report(ready)` 报到，说明目录、能力和当前上下文。指挥官通过 `list` 看成员，用 `send` 下发可验证任务。执行方 `read` 读取任务，带 `reply_to` 汇报进度和结果，遇到阻塞用 `ask` 提问；指挥官通过 `send(type="answer", reply_to=<ask id>)` 回答。

双方使用 `read(wait=me.recommended_wait)` 待命，技能默认最多等待 40 轮。cmdr 不创建 Agent，也不主动唤醒已经结束回合的宿主；空闲成员可能需要用户去说一句“继续”。

## 工具和运维

固定 7 个 MCP 工具：`join`、`list`、`send`、`report`、`ask`、`read`、`leave`。读取即出队，`peek` 不出队，`history` 可回看。报告状态保存在 `message.data.status`。指挥官离队后小队变为 orphaned，可按原 ID 接管；`leave(dissolve=true)` 解散小队，但已经排队的消息仍可读取。

```sh
plugins/cmdr/bin/cmdr status
plugins/cmdr/bin/cmdr list --all
plugins/cmdr/bin/cmdr tail --follow
plugins/cmdr/bin/cmdr send --squad <id> --to tests "运行测试"
plugins/cmdr/bin/cmdr read --session <sid> --peek
plugins/cmdr/bin/cmdr daemon start
plugins/cmdr/bin/cmdr daemon restart
plugins/cmdr/bin/cmdr doctor
plugins/cmdr/bin/cmdr config --agent zcode
plugins/cmdr/bin/cmdr purge
```

默认数据目录 `~/.cmdr/`，可用 `CMDR_HOME` 覆盖。目录 0700、Unix socket 0600；队列和历史默认保留 7 天。`purge` 只清理过期数据，`purge --all` 会删除全部消息与成员关系。配置示例见英文 README。

消息持久化可以跨 daemon 重启恢复；工具返回消息后即视为投递，不提供“Agent 已完成处理”的确认。宿主在收到结果后崩溃时，可从 history 恢复。

## 开发与验证

```sh
npm ci
npm run check
npm run verify:zcode
```

`check` 包括格式、类型、打包、单元/真实进程测试，以及 npm tarball 在临时目录中的离线安装和 7 个工具验证。ZCode 验证可选，需要已安装桌面端；它在临时目录使用 App 内置运行时验证插件和 7 个 MCP 工具连接，不发起模型请求。

插件版本由 `package.json` 统一生成。源码修改后需重新打包，并更新宿主缓存；同版本代码变更需手动重启 daemon。CI 验证 macOS/Linux、Node 22/24、npm 包可运行性，并确保生成产物没有被 Git 跟踪。

设计文档中的旧试用记录不代表本次实现已经完成对应 GUI/模型实测；具体测试范围和待验证项以[实现记录](implementation.md)为准。
