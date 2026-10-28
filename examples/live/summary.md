# live 实际运行结果

开始：2026-10-28T09:40:51.841Z

11/11 用例通过。真实模型调用；所有业务资料为合成数据。

| 用例 | 预期 | 实际 | 通过 | 步数 | 草稿数 |
|---|---|---|---|---:|---:|
| [normal](normal.trace.json) | completed | completed | true | 5 | 1 |
| [duplicate](duplicate.trace.json) | completed | completed | true | 5 | 1 |
| [conflict](conflict.trace.json) | needs_confirmation | needs_confirmation | true | 5 | 1 |
| [confirmed](confirmed.trace.json) | completed | completed | true | 5 | 1 |
| [changed-occupancy](changed-occupancy.trace.json) | completed | completed | true | 5 | 1 |
| [missing](missing.trace.json) | needs_input | needs_input | true | 3 | 0 |
| [risk](risk.trace.json) | blocked | blocked | true | 3 | 0 |
| [save-failure](save-failure.trace.json) | failed | failed | true | 6 | 0 |
| [multi](multi.trace.json) | blocked | blocked | true | 5 | 1 |
| [no-slots](no-slots.trace.json) | needs_input | needs_input | true | 4 | 0 |
| [step-limit](step-limit.trace.json) | incomplete | incomplete | true | 1 | 0 |
