# 素材审核与发布排期 Agent

小影校招 AI Agent 工程师笔试，第 1 题。帮助内容团队审核素材、处理排期冲突并保存待确认草稿；不接真实发布。

项目按阶段开发，每阶段经验证后通过 Pull Request 合并。完整的运行说明与验收记录将随对应实现提交，尚未提交的能力不视为完成。

## 当前阶段

设计、业务工具、模型驱动循环和 CLI 已实现。完整场景证据与最终交付检查在下一阶段归档。

环境：Node.js 22.18+、npm。安装与基础检查：

```sh
npm ci
npm test
npm run typecheck
```

## 复制运行

离线示例（无需密钥，只验证执行流程）：

```sh
npm run dev -- --model mock --input examples/inputs/normal.json --db .runtime/demo.sqlite --output .runtime/normal.json
npm run dev -- --model mock --input examples/inputs/conflict.json --db .runtime/conflict.sqlite
```

再次执行相同命令会复用草稿；`requestId` 相同但基本请求内容改变会被拒绝。要独立试验可指定新的数据库文件。

真实模型：将 [.env.example](.env.example) 复制为 `.env`，填写 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_API_KEY`。本地 `.env` 被 Git 忽略。已实际验证 DeepSeek 的 `https://api.deepseek.com` 与 `deepseek-flash`；其他兼容服务需要自行验证。

```sh
npm run dev -- --model live --input examples/inputs/conflict.json --db .runtime/live.sqlite --output .runtime/live.json
```

查看帮助、构建及运行编译产物：

```sh
npm run dev -- --help
npm run check
npm start -- --model mock --input examples/inputs/normal.json --db :memory:
```

## 确认、失败与结果

- `conflict.json` 要求抖音 18:00，而资料占用该时段。模型可以建议 19:00，但草稿为 `pending_confirmation`，且不占用替代时段。
- 将 [confirmed.json](examples/inputs/confirmed.json) 对同一个数据库执行，输入中的精确授权可将原草稿更新为 `confirmed`，ID 不变。这里的 confirmed 只表示草稿已确认，**不表示已发布**。
- `--fail-save 100` 可模拟持续保存失败；`--max-steps 1` 可观察未完成状态；`--catalog PATH` 可更换规则或占用数据。
- 输出包含每项审核状态、风险依据、建议时段、待确认项、保存回执与逐步 Trace。任务状态包括 `completed`、`needs_confirmation`、`needs_input`、`blocked`、`failed`、`incomplete`。
- 退出码：0 为草稿已保存或待确认；2 为资料不足、风险阻断或输入错误；1 为失败或未完成。报告文件写入失败也返回 1，但标准输出保留真实业务状态和已保存结果。

素材与规则都是合成数据；工具白名单没有发布、Shell、任意文件读写或联网搜索能力。程序从业务账本生成最终状态，不以模型自然语言声称的成功为依据。

## 实现入口

- `src/agent.ts`：模型选择动作、执行工具、观察结果和结束循环，硬性步数/工具次数上限。
- `src/tools.ts`、`src/store.ts`：审核、确认与保存边界，SQLite 事务和幂等约束。
- `src/model.ts`：OpenAI 兼容非流式工具调用，有限重试、超时及响应校验。
- `src/mock-model.ts`：显式离线模型替身，不能证明真实模型决策效果。

未使用 Agent 框架；Zod、TypeScript 等精确版本见 `package.json` / `package-lock.json`。Node 22 的内置 SQLite 是实验性 API，CI 固定 Node 22.18.0 并验证 Windows 和 Ubuntu。接口参考：[Node SQLite](https://nodejs.org/download/release/v22.18.0/docs/api/sqlite.html)、[DeepSeek 工具调用](https://api-docs.deepseek.com/guides/tool_calls/)。

评审入口：[需求](docs/01-requirements.md) · [方案](docs/02-solution.md) · [评估](docs/03-evaluation.md) · [AI 使用](docs/04-ai-usage.md) · [复盘](docs/05-retrospective.md) · [一天开发计划](docs/06-development-plan.md)。
