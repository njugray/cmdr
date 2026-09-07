# cmdr 中文说明

[English README](../README.md) · [完整设计方案](cmdr-design-v1.md) · [许可证](../LICENSE)

**cmdr（Commander）用于协调同一台机器上的多个 Claude Code / Codex 会话。** 一个会话担任指挥官，负责拆分和派发任务；其他会话担任执行方，负责报到、执行、汇报和提问。所有通信通过本地 MCP 进程和唯一的 cmdr daemon 完成。

> 当前分支仅包含 v1 设计文档；设计中描述的源码、插件包和发布产物尚未加入此分支。

## 快速开始

在所有参与会话中输入同一个容易记忆的小队名：

```text
/cmdr my-project
```

第一个会话会创建 `my-project` 小队并成为指挥官；其他会话输入同一命令后，会以执行方身份加入已有小队。如需明确指定角色、使用 squad id 或接管 orphaned 小队，仍可使用底层 `join` 工具。

## 为什么不采用 cmux / herdr 式架构？

[cmux](https://github.com/manaflow-ai/cmux) 是以 pane、标签页、通知和工作区体验为核心的 macOS 终端应用；[herdr](https://github.com/herdrdev/herdr) 是持有终端生命周期的后台 runtime，适合持久运行、断开重连、查看 pane 状态，并通过 CLI 或 socket 控制会话。它们解决的是「Agent 在哪个终端里运行，以及人如何管理这些终端」。

cmdr 解决的是更上一层的「Agent 会话如何可靠协作」：

- 不拥有终端或 pane，而是把身份绑定到 Agent 会话和小队。
- 不向终端注入非结构化文本，而是通过 MCP 发送带类型、优先级、收件人和关联 id 的消息。
- 使用 SQLite 队列保存未读状态，宿主或 daemon 重启后仍可恢复。
- 使用 hooks 感知会话生命周期并提醒 Agent，不需要抓取屏幕输出。
- 支持终端 CLI、IDE，以及 **Claude Desktop、Codex Desktop 等桌面端应用**；GUI 会话即使没有 tty 也能工作。

两类方案可以互补：如果需要 cmux / herdr 的终端布局、持久化和人工观察能力，可以在其中运行 Agent，同时让 cmdr 负责跨会话的任务消息；如果 Agent 直接运行在桌面端，也可以只使用 cmdr。

## 核心能力

- 同一个插件同时面向 Claude Code 与 Codex，并覆盖 CLI 与桌面端应用。
- 指挥官与执行方角色清晰，单个会话同一时刻只属于一个小队。
- 每个会话拥有基于 SQLite 持久化的优先级消息队列。
- `command`、`ask` 和 `answer` 优先于普通进度汇报。
- hooks 在 Agent 下一次活动时提示未读消息，并可阻止遗漏重要消息后直接结束回合。
- 执行方可通过长轮询待命，新消息到达后立即返回。
- 只使用用户私有的本地 Unix socket，不监听网络端口。

## 七个 MCP 工具

| 工具 | 使用者 | 作用 |
|---|---|---|
| `join` | 双方 | 创建小队，或以指挥官/执行方身份加入小队 |
| `list` | 双方 | 查看会话、小队、在线状态、活动状态和待处理任务 |
| `send` | 指挥官 | 发送命令、答复或通知 |
| `report` | 执行方 | 汇报 ready、working、blocked、done 或 failed 状态 |
| `ask` | 执行方 | 向指挥官提问，并可选择等待答复 |
| `read` | 双方 | 读取队列消息，或阻塞等待新消息 |
| `leave` | 双方 | 离队、解散小队，或让小队进入可接管状态 |

## 典型流程

1. 在一个会话中以指挥官身份调用 `join`。
2. 将返回的 squad 加入提示复制到其他 Claude Code / Codex 会话。
3. 执行方加入后用 `report(ready)` 报告工作目录、能力和上下文。
4. 指挥官通过 `send` 派发目标明确、可验证且包含验收标准的任务。
5. 执行方执行任务，通过 `report` 汇报进展；遇到阻塞时使用 `ask`。
6. 指挥官读取结果并回答问题，最后保留、交接或解散小队。

示例提示词：

```text
以指挥官身份加入 cmdr，名字叫 planner。
```

```text
join cmdr squad k7m2pq as executor, name tests
```

## 设计范围

v1 面向单机、单用户场景。它只协调已经存在的 Agent 会话，不负责创建或启动 Agent；不支持跨机器传输、多用户鉴权、Web UI 或执行方之间的直接通信。对于已经结束回合的空闲会话，v1 不使用未公开的主动唤醒机制，而是在该会话下一次活动时通过 hooks 提醒。

完整的架构、数据模型、队列语义、身份会合、生命周期、插件 manifests、安装方式、CLI、数据库 schema、测试要求和已知风险，请阅读[《cmdr 设计方案（v1）》](cmdr-design-v1.md)。

## 许可证

[MIT](../LICENSE)
