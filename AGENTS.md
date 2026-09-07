# cmdr 项目指引

cmdr 通过 MCP 连接已有的 Agent 会话，由本机 daemon 协调消息。当前 v1 面向 macOS/Linux、单机单用户，使用 Unix socket 和 SQLite WAL。保持通用 MCP 宿主兼容性；创建 Agent、主动唤醒、远程传输和 executor 互发消息不属于当前范围，除非任务明确要求扩展。

## 按任务查阅

- 修改消息、角色、队列或持久化：从 `src/daemon/core.ts`、`src/daemon/store.ts` 和 `src/shared/protocol.ts`、`src/shared/schemas.ts` 定位；设计背景见 `docs/cmdr-design-v1.md`，实际实现与设计差异见 `docs/implementation.md`。
- 修改身份、MCP 桥接或生命周期 hooks：查看 `src/mcp/`、`src/hook/` 和 `docs/agent-integration.md` 对应宿主章节。
- 修改安装或分发：查看 `scripts/build.mjs`、`plugins/cmdr/` 下的宿主 manifests、`bin/` 启动脚本及 marketplace 文件。
- 修改用户操作方式：同步相关的 `README.md`、`docs/README.zh-CN.md` 及插件命令/技能说明。

这些是按需入口，不要求每次修改前通读文档。设计文档中的历史原型记录不代表当前实现或验证结果。

## 实现约束

- 对外 MCP 工具为 `join`、`list`、`send`、`report`、`ask`、`read`、`leave`。修改接口时保持 schema、daemon、桥接层和使用说明一致；Agent 标识是开放字符串，不限定为已知宿主枚举。
- 消息读取即交付，不代表任务执行成功，也没有处理确认或 exactly-once 保证。保留 peek/history、优先级、关联回复，以及等待中的读取被取消后不消费消息的语义。
- 身份重绑定和共享 MCP 进程中的会话隔离必须保留队列、成员关系及回复路由。具名 squad 的创建/加入保持原子性。
- Hooks 只暴露消息元数据，不注入正文或附件；保留失败放行和 Stop 提醒节流行为。
- 使用 TypeScript strict、ESM/NodeNext；本地 TypeScript 模块导入沿用 `.js` 后缀。格式以现有 Prettier 配置为准。

## 构建与验证

开发需要 Node.js ≥22.5（推荐 24）和 npm；安装依赖使用 `npm ci`。

| 场景 | 命令与说明 |
| --- | --- |
| 针对性验证 | `npm test -- tests/core.test.ts`，按改动选择测试文件；身份/hooks 对应 `tests/hooks-identity.test.ts`，工具函数对应 `tests/utilities.test.ts` |
| 涉及真实进程或打包入口 | 先 `npm run build`，再 `npm test -- tests/process.test.ts`；进程测试执行的是打包产物 |
| 代码或构建变更交付前 | `npm run check`：格式、类型、构建、测试和 npm 包离线安装验证，与 CI 的主检查一致 |
| ZCode 集成验证 | `npm run verify:zcode`，仅相关变更且本机装有 ZCode runtime 时使用；它在临时环境验证，不发送模型请求 |

纯文档修改检查内容、链接和 diff 即可。检查通过后，无新改动或失败证据无需重复运行。宿主 GUI、信任提示和真实模型协作需单独验证，不能用进程测试通过来代替。

`tests/helpers.ts` 和进程测试使用可丢弃的临时数据目录，可以自主运行、修复本次改动引起的失败并重跑受影响测试。手动调试 daemon、CLI 或 hooks 时也设置指向临时目录的 `CMDR_HOME`，避免操作默认的 `~/.cmdr/` 会话和消息；只清理本次创建的测试目录与进程。

## 分发与完成标准

- `plugins/cmdr/dist/*.mjs` 和 `plugins/cmdr/THIRD_PARTY_NOTICES.txt` 是 Git 忽略的生成文件，通过 `npm run build` 更新，不直接手改或提交到 Git。`npm pack` / `npm publish` 在 prepack 阶段构建，将产物和许可证声明放入 npm 发布包。
- 源码仓库安装插件前运行 `npm ci && npm run build`；安装端使用构建好的 npm 包时不需要开发依赖。不要把未构建的 Git 源码目录当作可直接运行的插件。
- CI 验证 npm 包可在临时目录离线安装、暴露 7 个 MCP 工具，并检查构建产物没有被 Git 跟踪。宿主 manifests 和 marketplace 版本仍由 `package.json` 同步，构建后这些受跟踪文件不应有额外差异。
- 已安装宿主使用插件缓存。涉及已安装版本的验证需要刷新/重装；相同版本的代码更新需要显式重启对应测试 daemon。
- 在任务范围内完成实现、相关文档、必要构建及验证，并修复由本次变更引入的问题，不在第一版实现后提前停止。交付时简述改动、实际验证结果和仍受环境限制的部分。

维护此文件时，只加入长期有效、会影响本项目决策的信息；具体工作流放到对应文档或技能中，避免积累通用提示词和逐步操作清单。
