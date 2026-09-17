# ZCode 新会话的桌面可见性：源码调研

> 决策（2026-09-17）：新建会话功能暂不实现，app-server 创建原型及其 CLI、daemon 接口和专用测试已撤回，也不接入 CDP 桌面创建。本文保留源码分析与实验记录，不代表当前产品能力；本轮仅保留已有会话的自动唤醒。

调研日期：2026-09-17。对象为本机 ZCode Desktop **3.11.2**，build commit `89817f5b`，bundled runtime **0.16.5**。分析的是已安装应用的 JavaScript 产物，不是上游源码仓库；结论限定于这个版本。

## 结论与此前判断的纠正

**此前 app-server 原型创建的新会话，如果已经落盘，且桌面使用同一会话数据库、打开匹配的 workspace，重启桌面并重新初始化该 workspace 的 runtime 后，有可能进入桌面列表。不能保证立即显示，也不应将重启作为创建流程。**

此前“设置了独立 `ZCODE_STORAGE_DIR`，所以重启桌面也看不到”的解释不成立：会话数据库由另一个配置 `storage.sessionDbPath` 控制。已撤回的 `src/daemon/adapters/zcode.ts` 原型只设置 `ZCODE_STORAGE_DIR`，没有设置 `ZCODE_SESSION_DB_PATH`，因此**当时没有实现所宣称的数据库隔离**。未另外配置时，会话数据库仍为 `~/.zcode/cli/db/db.sqlite`。

这同时说明：桌面列表没有立即显示，不足以证明新会话与桌面存储隔离；重启后显示，也不足以证明桌面接管了原来的运行实例。

**后续外部入口实测已通过：** 发行版显式启用 CDP 后，外部 Node 进程可以经 Renderer 的服务代理调用桌面 Host `createTask`；任务立即进入 `listTasks` 和实际侧边栏，沿用同一个 workspace runtime。该路径需要启动参数和版本相关的内部服务访问，不是默认开放的任务 API。详见第 7 节。

## 1. 存储目录与会话数据库是独立配置

runtime 的配置和启动链路：

- 默认配置分别声明 `storage.dir = ~/.zcode` 和 `storage.sessionDbPath = ~/.zcode/cli/db/db.sqlite`。
- `gxe` 将 `ZCODE_STORAGE_DIR` 映射到 `storage.dir`，将 `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` 映射到 `storage.sessionDbPath`。
- `Wae` / `getSessionDbPath` 直接读取 `config.storage.sessionDbPath`；`Ssn` / `openStartupZCodeProtocolSessionStore` 据此打开 SQLite。
- app-server 启动使用 `ns({ env: e.env })` 加载配置，不向这一步传入请求中的 workspace。不能假定 workspace 下的 `.zcode/config.json` 就能隔离启动阶段的数据库。

因此，真正的 headless 隔离必须同时明确设置存储目录和数据库路径。当时的 `scripts/verify-zcode.mjs` 也只配置了前者；此前插件缓存隔离、MCP 发现和 create/read/close 的通过结果，**不能作为会话数据库隔离的证据**。空会话测试没有持久化会话行，也不代表启动没有打开默认数据库。撤回创建功能时，验证脚本已补上显式临时 `ZCODE_SESSION_DB_PATH`，仅保留插件与 MCP 验证。

## 2. 桌面任务列表有自己的索引

桌面 Host 的 `getTasksIndexDatabasePath` 返回 `<dataBaseDir>/.zcode/v2/tasks-index.sqlite`。默认 `dataBaseDir` 为用户主目录，桌面设置或环境可覆盖它。

`createZCodeTaskService`（打包符号 `lM`）的 `listTasks`、`listPinnedTasks`、`listTaskList` 读取 `TaskIndexRepository` 的任务行，按 workspace、provider `glm`、归档/删除/置顶状态过滤。

Renderer 的 `pvt` 确实合并 `taskIndexItems` 和 runtime 的 `sessions`，但实现是遍历 `taskIndexItems`，用匹配的 session 补充状态，**不是两个集合的并集**。只有 runtime 会话记录，并不直接生成一个列表项。

原生 `createTask` 除了调用 runtime 的 `session/create` 或 v4 `createSession`，还会：

1. 写入/同步 task meta。
2. 初始化任务排序。
3. 建立 workspace/session 订阅。
4. 广播 `task_created`，触发桌面列表更新。

已撤回的 cmdr 原型直接启动另一个 app-server 并调用 `session/create`，没有经过这条桌面 Host 流程。`--surface desktop` 只配置 runtime 的呈现行为，不会将它注册到正在运行的 Electron Host。

## 3. 为什么重启可能起效，普通刷新不可靠

`createZCodeTaskIndexSyncer`（`xge`）监听 Host 管理的 runtime 生命周期，订阅 workspace 的 v4 sessions-index。

- runtime 的 `ensureIndexPublisherExclusive` 首次建立索引时调用 `loadStoredSessionSummaries`，读取数据库中的会话。该读取按 workspace/path、任务类型、非归档条件过滤，最多取 200 条。
- Host 收到初始快照后，由 `seedMissingRowsFromInitialSnapshot` 将非 `draft` 会话补入桌面任务索引；已有索引行不会被覆盖。
- 同一 runtime 已有 index publisher 时，`ensureIndexPublisher` 通常直接返回内存中的 publisher。重新订阅/请求快照不是重新扫描数据库。
- 该链路没有自动将另一个 app-server 的数据库写入转成当前 runtime 的 sessions-index 事件。

所以，重建 workspace runtime 可以让它重新读盘，再补齐桌面索引。重启整个桌面是一种可能触发方式，但会话必须先落盘、数据库和 workspace 必须匹配，且仍受读取范围、初始化和界面刷新时序影响。这里只验证了底层协议和源码链路，**没有实际重启用户桌面验证 GUI 最终显示**。

仅修改 `tasks-index.sqlite` 同样不是完整方案：它既不通知现有 Renderer，也不让桌面连接到 cmdr 已有的运行实例。

## 4. 空 create 不等于已持久化

`session/create` 的 `l3e` / `jwt` 建立运行实例并放入当前进程的 `sessions` Map。即使 record 标记为 `persistence: immediate`，普通空 create 也没有在这一步直接创建数据库会话行。

实际持久化由 runtime 的 `ensureSessionPersisted` 在处理输入/外部活动等路径触发；历史导入也会显式写入会话。

无模型实验中，普通空 create 后：创建进程的 `session/list` 能看到它，另一个同库进程看不到；另一个进程 `session/resume` 返回 `-32004 Session not found`。

原型在创建成员后会发送初始通知并尝试唤醒。只有这条后续执行链路触发了持久化，才具备重启后发现的前提。不能只凭 create 成功就承诺可跨进程恢复。

## 5. 列表可见不等于安全接管

runtime 的 `session/resume` 查自己的内存 Map 和持久化会话，然后在当前进程建立运行实例；这里没有跨 app-server 的会话运行权交接。

临时实验验证：A 保持会话加载，B 仍可对同一 ID 成功 `session/resume`，随后 A 的 `session/read` 仍成功。实验未发送模型请求，只证明双实例可以同时存在，不声称验证了并发模型执行。

桌面 `resumeTask` / 会话订阅走的是桌面自己管理的 runtime。因此让桌面发现 cmdr 的会话后再打开，存在创建第二个运行实例的风险。Host 的 command queue 和 `ownerRunId` 检查属于该 Host 自身的运行状态，不能据此推断两个独立 app-server 之间有全局锁。

## 6. 曾评估的接入方向（暂不实施）

桌面原生新建能力应以 **桌面 Host 的 `createTask` 为接入目标**：让桌面拥有唯一 runtime，同时完成建会话、索引、排序和事件通知；cmdr 得到真实 session ID 后加入小队，唤醒沿用桌面原生机制。这样原生创建链路本身就负责显示，不需要把“请重启桌面”加进使用步骤。

初步调研定位了以下入口边界；后续实测结果见第 7 节：

- 本地服务经 Electron `MessagePort` / `ChannelServer` 暴露给桌面附件；底层 runtime 经 stdio 连接。
- 查到的 deep link 支持打开 workspace、OAuth 和支付回调，没有找到按参数调用 `createTask` 或接管指定会话的入口。
- 固定 remote-debugging 端口的启用条件包含 `!app.isPackaged`，不能把开发环境的 CDP 端口当成发行版默认 API。
- v4 会话命令和 Host 的队列确实存在，但启动自己的 app-server 调用这些接口，仍然是在操作自己的 runtime。

调研曾评估显式 CDP 桌面适配器：连接指定本机调试端点并探测内部服务能力。headless 路径则还需要完整数据库隔离，以及停止原 owner、确认持久化、由桌面恢复、更新管理方式的显式交接。两条路径均有额外接入成本，本轮均已放弃；同库双进程恢复不构成 attach。

最终决定撤回创建原型，保留调研证据。没有改写用户桌面任务索引、桌面配置或强行接管现有会话。

## 7. 外部调用入口实测

### 已跑通：显式启用 CDP → Renderer 服务代理 → 桌面 Host

使用 `/Applications/ZCode.app/Contents/MacOS/ZCode` 原始发行版，未修改应用文件。测试启动参数为 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`，实际监听 `127.0.0.1:62868`。源码只是不在 packaged 模式自动添加固定调试端口；这不等于发行版拒绝显式 CDP 参数。

独立测试配置同时设置了 `ZCODE_DATA_BASE_DIR`、`ZCODE_STORAGE_DIR`、`ZCODE_SESSION_DB_PATH`、`ZCODE_HOME`、`ZCODE_DESKTOP_HOME_DIR`、`ZCODE_DESKTOP_USER_DATA_DIR`、`ZCODE_DESKTOP_SESSION_DATA_DIR` 和临时 `CMDR_HOME`。没有改写进程的 `HOME`。通过 `lsof` 确认 Host 的 `tasks-index.sqlite` 和 workspace runtime 的 `db.sqlite` 均位于本次临时目录。原桌面进程保持运行。

外部 Node 进程读取 CDP 的 `/json/list`，连接该临时窗口的 `webSocketDebuggerUrl`，使用 `Runtime.evaluate` 访问 Renderer。服务对象由已挂载 React Provider 的 `value` 获取，包含 `zcodeTaskService`、`zcodeAgentService` 等代理；它不是 `window.zcode.createTask`，也不是额外安装的插件接口。

为了不发送模型请求，测试只在临时配置中注册虚拟 provider，模型地址为 `http://127.0.0.1:1/v1`，未调用 sendPrompt / session/send。经过 UI 的“使用 API key → 暂时跳过”进入临时窗口，再通过同 profile 的第二个应用进程传入 `--open-workspace <临时目录>`，成功打开测试 workspace。

实际创建调用为：

```js
const task = await services.zcodeTaskService.createTask({
  workspacePath,
  model: 'cmdr-entry-probe/no-model-request',
  mode: 'build',
});
```

| 检查 | 实测结果 |
| --- | --- |
| 第一次原生创建 | 返回真实 ID `sess_abf59d9b-eb34-48d5-afc0-f82efa759d57`，`listTasks` 立即包含它 |
| workspace 已显示时再创建 | 返回 ID `sess_21b33cb3-df90-4401-a69c-c140e5468bcc` |
| 实际 Renderer | 侧边栏的 `New session` 从 1 条增至 2 条；另行截图确认，不只是查询数据库 |
| 事件 | 收到 `workspace_task_list_changed`，`reason: task_created` |
| 第二次创建前后 runtime | `processId: 79105`、`generation: 1`、`identity` 均一致 |
| 网页远程控制状态 | `idle`；CDP 路径不依赖启用云端配对 |
| 刷新/重启 | 两次创建之间没有重启桌面、Host 或 workspace runtime，也没有重新加载 Renderer |

这验证的是**外部原生创建、桌面即时可见、复用 Host 管理的 runtime**。尚未验证从该入口注入 cmdr MCP 后的 join/report、真实模型任务、自动唤醒和失联恢复；这些不应由创建成功推导出来。

结束时已关闭测试桌面及其 Host/runtime/helper 子进程，删除临时 profile 和数据库；记录的测试 PID 均已退出，原桌面与原 Host/runtime 进程仍在运行。该次外部入口探针仅补充调研文档；随后按用户决定撤回创建原型。

另一次可选 rename 探针中，`listTasks` 的标题已更新，但空会话侧边栏仍显示 `New session`。这不影响新建条目的可见性验证，但本轮不将“外部重命名即时同步”列为通过项。

### 其他入口的边界

| 入口 | 验证程度 | 结论 |
| --- | --- | --- |
| 当前正常运行的发行版桌面 | 进程与监听检查 | 未发现任务控制 TCP 监听，也没有默认 9229 CDP 端口；不能直接把 CDP 探针接到这个默认实例 |
| `--open-workspace` | 独立 profile 实际执行，退出码 0、界面打开项目 | 可以打开 workspace；不是建任务接口 |
| `zcode://workspace/open?path=...` | URL 解析器与分发器源码 | 只读取 workspace path；没有找到 createTask / taskId / prompt 路由。未向用户默认桌面发送 deep link |
| Electron `AttachServicePort` | main/host/preload 源码 | `MessagePort` 由 main 创建并传递给受管理的 Renderer/附件，不是外部进程可按路径连接的 Unix socket |
| 网页远程控制 | 完整静态调用链，未做云端配对实测 | `device_register_init` / 认证 / 配对之后，`workspace-bridge-open` 调用 `attachWorkspaceHost`，以 `web-remote-replayable` 附加同一 Host；`rpc-frame` 转发到 ChannelServer。它是另一条有条件的桥接，不能称为默认本地 API |
| 独立 `app-server --stdio` | 前述 runtime 实验 | 操作新进程自己的运行实例，不会附加桌面 Host |

网页远程控制关键源码：main 的 `createWebRemoteControlManager`、`createWorkspaceBridge`、`routePayload`、`createWebRemoteControlSharedHostAttachments`，以及 Host 的 `AttachServicePort` 分发。这里只确认了桥接链路，未把源码可达等同于外部已完成配对调用。

### 接入决策

该版本的 CDP 路径已有实际调用证据，但依赖首次带调试参数启动桌面，并经内部服务创建和取得真实会话 ID。用户认为接入条件过于苛刻，决定暂不实现桌面创建，并同时撤回 app-server 新建能力。

React Provider 查找和内部 RPC 服务属于版本相关实现，尚无稳定的公开契约。本分支没有桌面创建适配器，也不再提供 headless 创建入口；这些实验仅作为以后重新评估时的证据。

## 实验记录与证据定位

成功探针使用同一个临时 SQLite 文件、不同 `ZCODE_STORAGE_DIR` 启动独立 app-server；隔离对照组使用另一个临时 SQLite 文件。每个进程均显式设置 `ZCODE_SESSION_DB_PATH`，模型端点为不可用的本地地址，关闭标题生成。已落盘样本通过原生 `importedHistory` 写入一条合成测试历史，**不是实际模型任务**。未调用 `session/send`。测试进程和数据目录已清理。

| 场景 | 观察结果 |
| --- | --- |
| 普通空 create | 仅创建进程可见；同库进程无法 resume |
| 不同 storage dir、相同显式 session DB | 已落盘样本可由另一进程的 `session/list` 读到 |
| 观察者先订阅空 sessions-index，之后另一进程落盘 | 同一观察者重新订阅仍为空 |
| 新进程首次订阅同一数据库 | 快照包含样本，历史摘要标为 `completedSuccess` / `sessionEnded: true` |
| 显式切换另一个 session DB | 看不到样本 |
| 新进程直接 read 未加载的样本 | `-32004 Session is not active` |
| 原 owner 存活时，另一进程 resume 同 ID | 成功；原 owner 仍可 read |

首次探针尝试只在 workspace 配置中指定数据库，未满足启动阶段隔离条件，且“空 create 已落盘”的断言失败；该次尝试不作为成功证据。随后明确设置所有进程的数据库环境变量，并分开验证空会话与已落盘样本。未对默认数据库执行手工清理，也不能把之前启动 runtime 的行为描述为已证实完全未触及默认数据库。

证据文件：

- `/Applications/ZCode.app/Contents/Resources/app.asar` 中 `out/metadata/build-meta.json`、`out/host/index.js`、`out/main/index.js`、`out/renderer/assets/styles-DyAcaLKy.js`。
- `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`；SHA-256：`e9f1868c0fdb863537ed910ee3828b9be96b8c2fd805473f63b439e1113266b8`。
- Host 关键检索点：`createZCodeTaskIndexSyncer`、`seedMissingRowsFromInitialSnapshot`、`syncSnapshotAndBroadcast`、`getTasksIndexDatabasePath`、`createTask`、`listTaskMetas`、`initializeGroupedTaskAtTop`、`AttachServicePort`。
- Runtime 关键检索点：`StorageSessionDbPath`、`getSessionDbPath`、`ensureIndexPublisherExclusive`、`loadStoredSessionSummaries`、`ensureSessionPersisted`、`session/resume`。
- Renderer 关键检索点：`taskIndexItems.map`、`tasks-index task 行读取不完整`、`useWorkspaceTaskLists`。

打包变量名和行号随版本变化；上述语义名称及数据流比格式化后的临时行号更适合复核。
