# 素材审核与发布排期 Agent

小影校招 AI Agent 工程师笔试，第 1 题。帮助内容团队审核素材、处理排期冲突并保存待确认草稿；不接真实发布。

项目按阶段开发，每阶段经验证后通过 Pull Request 合并。完整的运行说明与验收记录将随对应实现提交，尚未提交的能力不视为完成。

## 当前阶段

设计与工程基础已提交；业务工具和 Agent 循环正在后续阶段实现。

环境：Node.js 22.18+、npm。安装与基础检查：

```sh
npm ci
npm test
npm run typecheck
```

离线入口不需要密钥。真实模型配置见 [.env.example](.env.example)，本地 `.env` 不提交。

评审入口：[需求](docs/01-requirements.md) · [方案](docs/02-solution.md) · [评估](docs/03-evaluation.md) · [AI 使用](docs/04-ai-usage.md) · [复盘](docs/05-retrospective.md) · [一天开发计划](docs/06-development-plan.md)。
