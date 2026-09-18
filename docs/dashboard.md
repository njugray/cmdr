# 内置小队看板

看板随 cmdr 完整运行时分发，支持原生插件与 standalone setup 安装。它使用 React、HTTP 与 SSE，在一个页面中切换本数据目录下的小队。Agent 通过工具更新数据；用户通过内置表单回复问题，也可以向当前小队的指挥官留言。

```sh
cmdr dashboard
# 不自动打开浏览器，输出本机及网卡 IPv4 访问地址
cmdr dashboard --no-open
```

setup 安装使用 setup 返回的稳定 CLI 路径，例如 `~/.cmdr/bin/cmdr dashboard`。不同 `CMDR_HOME` 对应不同看板；同一数据目录的多个宿主 profile 共享看板。开发分支使用构建后的 `plugins/cmdr/bin/cmdr`。如果已有旧 daemon，先协调当前工作，使用该安装的 CLI 执行 `cmdr daemon restart`，再重连 MCP；相同版本的本地代码变化也需要重启。

命令输出的地址含有效期 60 秒的一次性打开凭证。浏览器将它换为 HttpOnly、SameSite Cookie，并从地址栏清除。服务默认绑定 `0.0.0.0`，端口由系统分配。输出中的 `url` 是自动打开的 `127.0.0.1` 地址，`urls` 包含该地址与各非回环网卡 IPv4 地址（去重），使用同一端口。每个地址有独立、绑定来源的一次性凭证，本机打开不会消耗其他地址的凭证。允许的 Host 来自这些地址，写请求的 Origin 必须与所访问的地址一致；不提供任意 RPC 转发。关闭页面不关闭小队、不取消任务、不停止成员监听。活跃 SSE 连接使 daemon 保持运行；关闭后恢复原有空闲退出规则。

看板文案默认跟随系统／浏览器的首选语言：中文（`zh-*`）显示简体中文，其他语言显示英文。页面标题、无障碍标签和时间格式使用相同语言。Agent／用户提供的消息、任务与问题内容、选项及 HTML 展示保持原样，不自动翻译；更改浏览器语言后重新打开或刷新页面生效。

网卡地址变化后重新运行 `cmdr dashboard` 会刷新地址列表。局域网设备使用对应网卡 IP 的链接访问，连通性取决于网络与主机防火墙。所有持有有效链接的浏览器具有同一用户权限；当前为 HTTP 服务，无多用户权限隔离。

## HTTP 实现

看板 HTTP 层使用 Hono 路由和 `@hono/node-server` 适配器，仍由现有 daemon 懒启动、监听所有 IPv4 网卡并由系统分配端口并统一关闭。JSON 请求通过中间件限制为 64 KiB；错误响应沿用 `{ code, message }` 和原有状态码。静态资源只提供三个固定入口，路径从运行时目录解析。

SSE 使用 Hono 的 `streamSSE`，保留提交后失效通知、20 秒注释心跳及断线后的活跃连接清理。每条连接的待写数据和 Node 输出缓冲合计超过 1 MiB 时关闭连接，由浏览器重连并重新读取快照。框架不负责业务事务、Agent 唤醒或访问策略；一次性凭证、同源校验、会话验证和 HTML 沙箱规则仍由看板明确实施。

前端按组件职责拆分：`app.tsx` 负责页面组装、SSE 订阅和跨小队草稿；`question-card.tsx`、`task-details.tsx`、`squad-dock.tsx`、`commander-message.tsx` 和 `artifact-view.tsx` 分别负责问题、详情、成员／活动、留言及 HTML 展示；`display.ts` 共享状态标签与时间／错误格式化。组件拆分不改变状态归属和挂载位置。

## 页面布局

宽屏使用三栏布局：左侧切换小队，中间是四列任务看板与底部成员／活动坞，右侧常驻待确认事项和留言框。顶部将任务数、执行中、待回复和成员数压缩为一行。点击任务或问题中的关联任务，在中间工作区打开详情；返回看板不影响右侧填写中的答复。

已接收、已处理和已撤回的问题折叠在“其他事项”中，可展开查看答复、处理说明和提交时的证据。窄屏将确认面板排列在工作区下方，任务列与成员表格可横向滚动。

## 向指挥官留言

右下方的留言框向**当前选中小队**发送用户消息，不直接编辑、派发或取消任务。只在点击“发送”或按回车后提交；切换小队保留各自草稿。成功回执表示已进入队列，尚不代表指挥官已读取或处理。

留言通过受鉴权、同源校验的 `POST /api/messages` 提交，只有 `squad_id`、`submission_id`（UUID）、`text` 三个字段，文本限 8,000 字符。daemon 以 `from_role="user"` 的 `info` 消息写入 `squad:<id>` 稳定指挥官收件箱，复用 SQLite 队列、容量限制、提交后的通知和现有唤醒机制，不新增 MCP 工具或专用监听链路。没有指挥官时仍可排队，接管者通过现有 `read` 读取；已关闭小队拒绝新留言。

发送失败保留内容和原提交 ID，在消息仍保留期间重试返回同一回执；不同内容复用 ID 会被拒绝。留言沿用普通消息 TTL，不属于永久保存的用户问题／答复记录，也没有独立的“已处理”状态。

## 指挥官操作

新增 `task`、`artifact`，共九个 MCP 工具。原来的 executor `ask(question=...)` 行为保持不变；指挥官用 `ask(target="user", ...)` 管理用户问题。CLI 后备路径支持同名操作，通过 `cmdr session <tool> --agent HOST --native-id REAL_ID --input '<JSON>'` 传入结构化参数。

创建任务并派发：

```text
task(action="create", title="完成导出功能", description="支持 CSV 导出", acceptance="中文字段正确，空结果可导出")
send(to="实现者", task_id="<返回的任务 ID>", message="实现导出功能并验证验收条件")
```

`task` 支持 `create/update/get/list/archive/restore`。`update` 可修改标题、说明、验收条件、`position` 和 `artifact_ids`，不能直接修改执行状态。小队成员可以查询本小队任务，只有当前指挥官可修改。`list` 使用 `offset/limit`，可按 `archived` 过滤；`get` 的执行记录按新到旧分页，返回 `next`。任务摘要只保留最近的执行信息，详情按需读取。

派发、接单、阻塞、终态和合作式取消仍由 command/report 驱动。`send(task_id=...)` 只允许一个接收者，默认用 task ID 作为 `task_key`；已有未完成工作必须使用 `reassign`，关联任务随重新分配保留。消息已读不等于接单。归档不能释放未完成任务，任务及执行摘要不随消息 TTL 删除。

创建用户问题：

```text
ask(target="user", question="采用哪种导出范围？", kind="single",
    options=[{id:"current",label:"当前筛选结果"},{id:"all",label:"全部数据"}],
    task_id="<任务 ID>")
```

支持 `single`、`multiple`、`text`、`confirm`。选择题有 2–20 个带稳定 ID 的选项；其他类型不传 options。选择题和确认题均可填写补充文字。`artifact_ids` 可关联复杂说明；普通表单由看板内置，不需要 Agent 编写 HTML。

`ask(target="user")` 支持以下操作：

| action | 行为 |
| --- | --- |
| `create` | 创建问题，默认类型为 `text`，返回 ID 和版本 |
| `get` / `list` | 获取问题或分页查询；可按 `status` 查询，包括 `answered` 的未处理答复 |
| `update` | 传 `id/version` 修改 pending 问题，增加内容版本 |
| `withdraw` | 传 `id/version` 撤回 pending 问题，不等于用户拒绝 |
| `handle` | 传 `id/version/result`，明确记录已回答问题的处理结果 |

用户问题不使用 `wait`。用户提交后，答案和去重回执在同一事务内持久化，带 `from_role="user"` 的 answer 消息进入 `squad:<id>` 指挥官收件箱，并接入现有唤醒机制。浏览器失败重试保留原提交 ID；相同 ID 和内容返回原回执。旧版本、撤回问题或第二次不同提交会被拒绝。没有指挥官时答案继续保存；接管者可读取和处理。

读取不代表处理完成。指挥官恢复时除 `read` 和 `read(recover=true)` 外，还应查询 `ask(target="user", action="list", status="answered")`，核对未处理决策，再显式 `handle`。`read(recover=true)` 只恢复未完成 command。已回答的问题不再编辑；再次征询创建新问题。

## HTML 展示块

```text
artifact(title="两种方案对比", html="<!doctype html><html>…自包含内容…</html>")
task(action="update", id="<任务 ID>", artifact_ids=["<展示块 ID>"])
```

`artifact` 支持 `publish/get/list`。更新时提供 `id/version/title/html`；只支持直接传 HTML 内容，不读取任意本机文件。HTML 必须自包含，样式和脚本内联，图片可用 data URL。展示块位于独立 sandbox iframe 中，允许演示脚本，禁止 same-origin、父页面访问、外部资源、网络接口调用和表单提交。用户的正式答复只来自 iframe 外的内置表单。

普通数据更新保留 iframe 节点与地址。展示块内容变化会重新加载该 iframe，切换小队后也可能重新加载，不提供任意 HTML 内部状态恢复。更新关联 pending 问题的 HTML 会递增问题版本，保留草稿并要求用户核对。提交时保存完整说明和 HTML 快照，之后可在“查看提交时的说明”中追溯。

## 容量与保留

每个小队每种记录（Task、Question、Artifact）上限为 200，包括已归档记录；每项任务最多 100 条执行记录，命令与报告各保存最多 2,000 字符的摘要。单份 HTML 上限为 256 KiB，当前展示块总量上限为 8 MiB，每个任务或问题最多关联 8 份。看板记录及提交快照不使用消息 TTL 自动清理；首版不提供单条删除，显式 `purge --all` 会连同协作数据一起清除。

## 连接与验证边界

每个标签页一条 SSE，所有小队共享。事件只提示数据变化，页面再查询快照；断线恢复同样重新查询。表单草稿保存在当前页面内存中，按小队和问题区分，切换小队不丢失；浏览器整页重载不保证恢复。

监听健康、宿主接受唤醒、任务接单和问题处理各自显示。Codex 复用 proxy/queue；Claude/ZCode/Kimi 完整执行 `listener.arm.command`，保留其中的 `CMDR_HOME`，使用宿主原生通知。安装自检与自动化测试不代替真实宿主的信任提示和模型唤醒验证。

设计背景见[方案文档](dashboard-plan.md)。
