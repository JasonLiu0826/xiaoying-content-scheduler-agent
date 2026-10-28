# 素材审核与发布排期 Agent Implementation Plan

> 执行方式：在指定工作区按任务实施，每阶段先验证再创建并合并 PR；使用测试先行、实现与规格/质量复核。用户已授权制定方案并立即开发，无需阶段间重复确认。

**Goal:** 一天内完成题 1 的可运行 CLI、模型驱动循环、全部业务验收与可复制证据。

**Architecture:** 模型选择白名单业务工具，结果回传形成循环；业务层掌握不可变请求、确认、审核、冲突和保存权限。SQLite 事务保存幂等草稿，最终状态从事实账本生成。

**Tech Stack:** Node.js 22.18+、TypeScript、Zod、原生 fetch、node:sqlite、Node 测试运行器、GitHub Actions。

## 一天时间预算（8 小时上限目标）

| 阶段 | 预算 | 分支 | 阶段验收 |
|---|---:|---|---|
| 1 设计与基础 | 0.5h | stage/01-design-and-foundation | 文档、依赖、配置、仓库基础检查 |
| 2 业务工具 | 2h | stage/02-domain-and-tools | 正常、缺字段、风险、冲突、防重复、保存故障的业务测试 |
| 3 Agent 闭环 | 2.5h | stage/03-agent-and-cli | 模型适配、Mock、CLI、动作结果回传、上限与伪造防护 |
| 4 验收交付 | 2h | stage/04-evaluation-and-delivery | 证据生成、完整验收、CI、真实模型验证或明确缺口、提交信息 |
| 缓冲 | 1h | 对应修复分支 | 修复失败、复核文档与最终 SHA |

## 阶段 1

- [x] 建公开仓库，提交最小初始化。
- [x] 添加 `docs/01-06`、`.env.example`、`.gitignore`、TypeScript 配置和锁定依赖。
- [x] 添加文档/配置烟测，执行 `npm test` 与 `npm run typecheck`。
- [x] 推送分支，创建 PR，检查差异并合并，保留合并历史（PR #1）。

## 阶段 2

文件：`src/domain.ts`（输入/资料/结果类型）、`src/store.ts`（SQLite）、`src/tools.ts`（校验与业务工具）、`data/*.json`（合成素材/规则/排期）、`tests/domain.test.ts`、`tests/tools.test.ts`。

- [x] 先写可执行断言：通过素材可保存；缺版权信息不可保存；禁止用语输出规则依据；18:00 占用时建议其他时段且要求确认。
- [x] 执行测试观察失败，再实现最小输入校验、审核、查询和保存工具。
- [x] 添加重复请求、同 ID 不同输入、确认伪造、过期时段查询、持久化故障、跨连接唯一约束测试。
- [x] 运行 `npm run check`，检查失败状态不会被记录为成功，推送并合并阶段 PR（PR #2，32项领域/工具测试）。

## 阶段 3

文件：`src/model.ts`、`src/agent.ts`、`src/mock-model.ts`、`src/cli.ts`、`tests/model.test.ts`、`tests/agent.test.ts`、`tests/cli.test.ts`。

- [x] 先验证两类工具观察会进入下一次模型请求，不依赖预设决策日志。
- [x] 实现 OpenAI 兼容非流式工具调用；超时/有限重试与结构错误输出明确失败。
- [x] 实现独立 Mock 模型入口，输出显著 `mock` 标记。
- [x] 通过 `finish` 工具提交终止意图，最终业务状态由可信工具账本生成。
- [x] 校验模型/工具上限、未知工具、参数格式、工具失败、伪造确认和提前结束。
- [x] 运行 CLI 回归与 `npm run check`，推送并合并阶段 PR（PR #3，58项全量测试，双平台CI通过）。

## 阶段 4

文件：`scripts/evaluate.ts`、`examples/inputs/*.json`、`examples/mock/*`、按配置生成的 `examples/live/*`、`.github/workflows/ci.yml`、README 和交付文档。

- [x] 生成至少正常、资料不足、工具失败三组实际运行材料，另覆盖风险、冲突、重复、确认和更换占用时段（Mock与真实模型各11组）。
- [x] 检查输入、实际输出、逐步 Trace、持久化数量和预期的一致性（22组证据及77个本地文档链接通过检查）。
- [x] 用户提供本地配置后执行真实模型验收，至少两条不同路径（真实deepseek-flash，正常5步、资料不足/风险3步，冲突与占用变更对照）。
- [x] CI 执行干净安装、类型检查、测试、构建和离线评估；核对文档中的数字来自实际输出。
- [x] 更新实际耗时、AI 使用、失败与已知限制；推送阶段4分支及PR #4。

最终合并与SHA回执以PR #4和交付回复为准，不在提交文件内嵌其自身尚未产生的最终SHA。最终主分支可用`git rev-parse HEAD`读取。

## 发布纪律

每阶段实际完成后立即提交和推送，不能先完成全部代码再补造阶段历史。不伪造时间、运行证据或个人贡献。PR 使用合并提交保留阶段边界；创建的 PR 附加到当前聊天。仅合成资料与脱敏输出进入公开仓库。
