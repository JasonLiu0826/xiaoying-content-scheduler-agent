# 效果验证与证据

## 实际结果

2026-10-28执行：58/58项自动化测试通过，类型检查与构建通过；离线Mock 11/11组、真实`deepseek-flash` 11/11组验收通过。真实模型运行时间为北京时间17:40:51至17:41:42，共47轮模型请求、51次工具调用（多素材场景有批量工具调用）。这些数字是本次固定样本结果，不是生产成功率。

- [真实模型汇总](../examples/live/summary.md)、[原始汇总JSON](../examples/live/summary.json)
- [离线Mock汇总](../examples/mock/summary.md)、[原始汇总JSON](../examples/mock/summary.json)
- [全量58项测试实际输出](../examples/test-results/phase-03.txt)
- [交付收尾的完整检查输出](../examples/test-results/final-check.txt)（类型检查、58项测试、构建）
- [业务工具32项测试实际输出](../examples/test-results/phase-02.txt)

完整验收记录的源码commit为`f985cdfda955cbe4c148d92394690c6921654f6c`，生成时`src/`与`scripts/`无未提交变更。后续提交归档证据与文档；若之后修改实现，须重新生成相应证据。

## 必须验收点映射

每组前缀文件包括`.input.json`（实际输入）、`.catalog.json`（实际资料/占用快照）、`.output.json`（实际报告）、`.trace.json`（动作及观察）、`.audit.json`（实际持久化结果与断言）。下表链接真实模型结果，Mock同名文件位于`examples/mock/`。

| 验收点 | 输入/运行记录 | 实际结果 |
|---|---|---|
| 正常排期 | [normal输入](../examples/live/normal.input.json)、[Trace](../examples/live/normal.trace.json)、[输出](../examples/live/normal.output.json) | 原18:00可用；审核通过；保存confirmed草稿，未发布 |
| 素材信息缺失 | [missing输入](../examples/live/missing.input.json)、[Trace](../examples/live/missing.trace.json)、[输出](../examples/live/missing.output.json) | 缺title、rights，needs_input，0草稿 |
| 规则风险 | [risk输入](../examples/live/risk.input.json)、[Trace](../examples/live/risk.trace.json)、[输出](../examples/live/risk.output.json) | R01及匹配原文支持blocked，0草稿 |
| 时段冲突 | [conflict输入](../examples/live/conflict.input.json)、[Trace](../examples/live/conflict.trace.json)、[输出](../examples/live/conflict.output.json) | 原18:00占用，建议19:00，保留原要求，仅保存pending_confirmation |
| 重复提交 | [duplicate Trace](../examples/live/duplicate.trace.json)、[数据库审计](../examples/live/duplicate.audit.json) | 与normal共享数据库，草稿总数仍为1，ID不变，duplicate=true |
| 保存失败 | [save-failure输入](../examples/live/save-failure.input.json)、[Trace](../examples/live/save-failure.trace.json)、[输出](../examples/live/save-failure.output.json)、[审计](../examples/live/save-failure.audit.json) | 保存失败后模型有限重试并结束；failed，0草稿，未虚报保存成功 |
| 补充人工确认 | [confirmed输入](../examples/live/confirmed.input.json)、[Trace](../examples/live/confirmed.trace.json)、[审计](../examples/live/confirmed.audit.json) | 与conflict共享数据库，同一草稿ID更新为confirmed，仍只有1份 |
| 更换占用时段 | [changed-occupancy资料](../examples/live/changed-occupancy.catalog.json)、[Trace](../examples/live/changed-occupancy.trace.json)、[输出](../examples/live/changed-occupancy.output.json) | 将占用从18:00改为19:00，在独立数据库对照运行；模型改选原18:00，结果completed |
| 多素材部分成功 | [multi Trace](../examples/live/multi.trace.json)、[输出](../examples/live/multi.output.json)、[审计](../examples/live/multi.audit.json) | M01已保存，M02缺资料，M03阻断；总体blocked，保留1份成功草稿 |
| 无可用时段 | [no-slots资料](../examples/live/no-slots.catalog.json)、[Trace](../examples/live/no-slots.trace.json)、[输出](../examples/live/no-slots.output.json) | 明确needs_input，请补充排期窗口，0草稿 |
| 执行上限 | [step-limit Trace](../examples/live/step-limit.trace.json)、[输出](../examples/live/step-limit.output.json) | 一轮上限后返回incomplete/MAX_STEPS，不伪装完成 |

自动化测试另覆盖：工具调用次数硬上限、未知工具、非法参数、模型提前结束、模型HTTP/响应错误、超时、不可伪造的确认、重复请求换输入、跨连接唯一约束、规则/占用查询后的变化、回执隔离，以及CLI跨进程重跑和输出文件故障。

## 动态决策证据

正常路径为`read_material → check_rules → query_slots → save_draft → finish`。资料不足或规则风险路径为`read_material → check_rules → finish`，模型根据审核观察停止，无保存动作。冲突路径根据query_slots的实际占用改为19:00，并在reason中说明待确认；更换占用后则保存原18:00。保存失败路径观察错误后重试一次，继续失败就finish，最终状态仍为failed。

上述真实Trace由实际模型返回的tool_calls和实际工具结果生成。`reason`是简短动作说明，未采集或要求模型内部思维过程。程序不预写真实模型决策日志，也不以自然语言声称的成功替代业务账本。

## 故障与修复记录

- 已确认草稿被不同建议时间重放：现在返回`DRAFT_ALREADY_CONFIRMED`，不静默替换或返回另一未校验时间。
- 输入亚毫秒时间被Date截断：所有输入限制为最多毫秒精度，避免确认和请求指纹误判。
- 保存回执与账本共享引用：现在隔离副本，外部修改返回对象不影响权威状态。
- 成功保存保留旧“无时段”状态：实时校验保存成功后清除该标记。
- 模型批次含坏参数、HTTP重定向、响应体中断：批次整体校验、拒绝重定向，并区分无效JSON与可重试传输故障。
- Windows输出路径大小写、硬链接别名：保存前比较规范路径和文件身份，防止覆盖输入。
- 报告文件写入失败：退出码1，同时在标准输出保留实际已保存业务结果和`artifactError`。

均保留回归测试。此前依赖安装期间提前检查曾因依赖未就绪失败，完成安装后重跑通过；这不是业务功能测试结果。

## 复现命令

```sh
npm ci
npm run check
npm run evaluate -- --model mock --out .runtime/my-mock-evaluation
npm run evaluate -- --model live --out .runtime/my-live-evaluation
```

live需要本地`.env`且会产生API费用。CI无需模型密钥，只运行离线评估；真实结果来自本机明确配置的服务。

## 已知限制

- Mock只验证流程，不证明真实模型能力；真实评估仅一个模型和固定小样本，未做多次随机重复或统计泛化评估。
- 保存故障通过写入前的业务工具故障注入实现，未模拟磁盘损坏或磁盘写满；不会将注入故障描述为真实磁盘事故。
- 合成审核规则是明确短语匹配，不能替代真实内容审核服务；review级风险要求补充人工核验依据，当前没有审核员审批界面。
- 候选时段由资料显式给出，没有实现任意日历时段搜索；带偏移时间最多支持毫秒精度。
- SQLite确认草稿具有唯一时段约束；待确认建议不预占位，最终确认可能失败并需要重新查询。
- 未对已有confirmed草稿提供重新排期工具；改期须另行设计明确的撤销/变更流程。
- 未接真实发布、UI、线上部署、多Agent业务运行时或跨进程共享Agent检查点；这些不在本次核心范围。
