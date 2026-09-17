# cmdr

让本机已经打开的 **Claude Code、Codex、ZCode 和其他支持 MCP 的 Agent** 组成小队：指挥官发任务，执行方汇报、提问，消息按优先级持久化到 SQLite。

[English](../README.md) · [设计方案](cmdr-design-v1.md) · [接入指南](agent-integration.md) · [实现与验证记录](implementation.md)

## 安装

支持 macOS / Linux，需要 Node.js ≥22.5（推荐 24）。开发分支保存源码和插件元数据；npm 发布包及自动生成的 `marketplace` 分支包含完整运行时。

**一条命令完整安装（0.4.0）**，将 `claude-code` 换成实际使用的 `codex` 或 `zcode`：

```sh
npx -y --package=cmdr-mcp@latest cmdr setup --agent claude-code
```

安装器会安装运行时、技能、MCP 和 hooks，并保留已有配置。重复执行可升级，增加 `--dry-run` 可预览。完成后新开会话并处理宿主信任提示。构建后的源码可直接运行 `plugins/cmdr/bin/cmdr setup --agent …`。

只安装技能文件时使用：

```sh
npx skills add njugray/cmdr --skill cmdr
```

技能需要可用的 cmdr 运行时和 MCP 连接，可通过 setup 或下面的原生插件方式安装。配置位置、升级和恢复见[安装说明](setup.md)。

npm 包名为 **`cmdr-mcp`**，CLI 和宿主插件仍叫 **`cmdr`**。需要全局 CLI 或原生插件时也可安装：

```sh
npm install --global cmdr-mcp
cmdr --help
```

源码安装先构建，再注册下面的插件市场：

```sh
npm ci
npm run build
```

`npm pack` / `npm publish` 会在 prepack 阶段构建并把 4 个入口、插件资源和许可证声明装入包；安装包不依赖外部运行时 npm 包：

```sh
npm pack
npm install --global ./cmdr-mcp-0.4.0.tgz
cmdr --help
```

下面的 `/path/to/cmdr` 可以是已构建的源码目录，也可以是安装后的包目录（`$(npm root -g)/cmdr-mcp`）。未经构建的 Git 源码不能直接作为可运行插件安装。发布准备和操作见[发布说明](publishing.md)。

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

ZCode 桌面端：打开工作区，在 **设置 → 插件 → 创建 → 添加插件市场** 输入 **`njugray/cmdr#marketplace`**，安装 cmdr 后新开会话。发布分支自带完整运行时，无需全局安装 npm 包或本地构建；仍需 Node.js ≥22.5。维护者首次运行 **Publish marketplace** 工作流发布该分支后，这个地址才可用。

原生 `.zcode-plugin` 清单负责 MCP、命令和技能，ZCode 自动发现 4 类受支持的 hooks。本地开发仍可选择已构建的仓库或已安装 npm 包根目录。

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

按名称创建/加入是原子操作，默认作为执行者，首个加入者也不会自动成为指挥官。需要指挥官时明确调用 `join(role="commander", squad_name="my-project", standby="auto")`。这是相对 0.1.x 的行为变化。没有指挥官时也可加入；普通离开、宿主结束和 daemon 重启不会删除频道或改变其 ID。

执行方加入后 `report(ready)` 报到，说明目录、能力和当前上下文。指挥官通过 `list` 看成员，用 `send` 下发可验证任务。执行方 `read` 读取任务后立即用 `report(working, reply_to=<command id>)` 接单，再带相同 `reply_to` 汇报 done/failed/cancelled，遇到阻塞用 `ask` 提问；指挥官通过 `send(type="answer", reply_to=<ask id>)` 回答。

加入时设置 `standby="auto"`，再按 `listener.arm` 和 `list` 的健康状态操作。Codex 由 daemon 自动探测 proxy，并在不可用时尝试 `codex queue`；Claude 使用原生 Monitor，ZCode 使用 `run_in_background=true` 的后台 Bash，两者都运行内置 `cmdr standby watch`。宿主 watcher 真正挂载后才显示 `can_auto_respond=true`，此时可结束空闲回合；任务完成、失败、到期或宿主重启后重新挂载。只有不支持原生通知或挂载失败时，才退回两次有限轮询并说明需人工续接。完整操作与边界见[长期协作](long-running-collaboration.md)。

## 工具和运维

固定 9 个 MCP 工具：`join`、`list`、`send`、`report`、`ask`、`read`、`leave`、`task`、`artifact`。读取即出队，`peek` 不出队，`history` 可回看。报告状态保存在 `message.data.status`。指挥官离队后小队变为 orphaned，可按原 ID 接管；`leave(dissolve=true)` 解散小队，但已经排队的消息仍可读取。

```sh
plugins/cmdr/bin/cmdr status
plugins/cmdr/bin/cmdr list --all
plugins/cmdr/bin/cmdr tail --follow --json --full --after 0
plugins/cmdr/bin/cmdr standby status --session <sid>
plugins/cmdr/bin/cmdr send --squad <id> --to tests "运行测试"
plugins/cmdr/bin/cmdr read --session <sid> --peek
plugins/cmdr/bin/cmdr daemon start
plugins/cmdr/bin/cmdr daemon restart
plugins/cmdr/bin/cmdr doctor
plugins/cmdr/bin/cmdr config --agent zcode
plugins/cmdr/bin/cmdr purge
```

默认数据目录 `~/.cmdr/`，可用 `CMDR_HOME` 覆盖。目录 0700、Unix socket 0600；消息和事件默认保留 7 天，但未终结 command、其改派依赖以及未关闭频道独立保留。`purge` 只清理过期数据，`purge --all` 会删除全部消息与成员关系。配置示例见英文 README。

消息投递状态与任务状态分开：queued → read → accepted → completed/failed/cancelled。`working + reply_to` 接单；`read(recover=true)` 找回所有未终结 command，包括已读未接单。`pending=0`、`unread=0`、offline 均不代表停工。`list` 展示归属、接单时长与进度时间；`send(task_key=...)` 防止同一票重复派发，`reassign=<command id>` 先请求原执行者取消，终态确认后才放行替代任务；改派保留原 task_key，不允许换键。每条任务的首次关联终态报告有保留入队能力，角色收件箱满时仍会原子保存终态和报告；普通报告与重复终态报告仍受队列上限约束。没有 exactly-once 执行承诺。

`read`/`list` 默认精简输出，完整摘要用 `--full`，列表始终不含任务正文；使用 `--limit` 或 `read --id` 获取正文，未放行的替代任务通过 ID 查阅时也会返回 `REASSIGNMENT_PENDING`，不会提前暴露正文；不要用 head 截断消费型读取。`tail --after EVENT_SEQ --for SID --json --full` 提供可补播事件，永不消费工作队列。升级改用 `cmdr daemon restart`：先在数据库副本上验证，再停止旧 daemon；旧客户端不能再通过 upgrade 请求反复关闭服务。0.2 daemon 在握手阶段拒绝 0.1.x 客户端并提示刷新/重装插件缓存、重连宿主。

## 开发与验证

```sh
npm ci
npm run check
npm run verify:zcode
```

`check` 包括格式、类型、打包、单元/真实进程测试，以及 npm tarball 在临时目录中的离线安装和 9 个工具验证。ZCode 验证可选，需要已安装桌面端；它在临时目录使用 App 内置运行时验证插件和 9 个 MCP 工具连接，不发起模型请求。

插件版本由 `package.json` 统一生成。源码修改后需重新打包，并更新宿主缓存；同版本代码变更需手动重启 daemon。CI 验证 macOS/Linux、Node 22/24、npm 包可运行性，并确保生成产物没有被 Git 跟踪。

设计文档中的旧试用记录不代表本次实现已经完成对应 GUI/模型实测；具体测试范围和待验证项以[实现记录](implementation.md)为准。

## 安装诊断与成员 CLI

工具未出现时，用 `cmdr doctor --plugin-root /实际宿主缓存中的插件目录` 检查缓存里的文件校验和与版本。加 `--deep` 会在临时数据目录中完成 MCP 握手、9 个工具检查及 daemon 访问，不操作正常小队。基础检查器独立于 dist，CLI bundle 缺失时仍可诊断；Node 缺失时先安装 Node。修复采用完整 npm 包重新注册市场、刷新/重装缓存并打开新会话，不跨安装目录链接 dist。

`cmdr session join|list|send|report|ask|read|leave|task|artifact` 提供完整成员操作，原有运维命令含义不变。显式传 `--agent`、`--native-id`，或设置 `CMDR_AGENT`、`CMDR_SESSION_ID`；与 MCP/hook 共享会话时必须使用相同原生 ID，共享 MCP 进程不能配置一个固定 ID。CLI 显示 `presence=cli`，退出后保留成员关系和任务状态；连接结束不代表模型停工。监听由 daemon 独立管理。

```sh
cmdr session join --agent zcode --native-id YOUR_SESSION_ID --squad-name my-project
cmdr session read --agent zcode --native-id YOUR_SESSION_ID --wait 45
cmdr session report --agent zcode --native-id YOUR_SESSION_ID --status done --reply-to COMMAND_ID "已完成"
```

指挥官必须显式声明 role=commander，report/ask 由执行者调用。结果为 JSON，失败使用非零退出码。`--input` 接受该操作完整 JSON 参数；`--timeout`、SIGINT/SIGTERM 可取消等待，等待中的 read 取消不消费后续消息。ask 取消前可能已发送，不能盲目重试。

`CMDR_HOME/logs/diagnostics/` 保存有界、限频的元数据快照。hook 仍失败放行，不写消息正文；unknown 表示尚未观察到，配置存在不代表真实触发。doctor 显示 provisional 会话及等待推荐来源；升级诊断不进入任务消息队列。详细案例见[排障说明](troubleshooting.md)。

## 内置看板

运行 `cmdr dashboard` 打开本机看板；setup 安装使用其返回的稳定 CLI 路径。`--no-open` 只输出短时访问地址。单个 React 页面切换多个小队，以任务工作区、底部成员／活动坞和常驻确认面板展示进展。用户通过内置表单提交答复，也可向当前小队的指挥官留言；留言复用现有用户消息队列，不直接修改任务。普通进展更新不会整页刷新，切换小队保留表单草稿。

看板文案默认跟随系统／浏览器首选语言：中文（`zh-*`）显示简体中文，其他语言显示英文。Agent／用户内容与 HTML 展示保持原样；更改浏览器语言后刷新页面生效。

指挥官通过 `task` 管理任务，`send(task_id=...)` 关联派发，`ask(target="user")` 创建问题，`artifact` 发布隔离的 HTML 补充说明。用户答案持久化后进入当前指挥官收件箱；读取不代表处理，使用 `ask(target="user", action="handle", id=..., version=..., result=...)` 明确记录结果。关闭页面不结束小队。数据隔离、重试、恢复、HTML 限制和升级见[看板使用说明](dashboard.md)。
