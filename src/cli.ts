import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { ZodError } from 'zod';
import { catalogSchema, requestSchema } from './domain.js';
import { DraftStore } from './store.js';
import { SchedulingTools } from './tools.js';
import { runAgent } from './agent.js';
import { createModel } from './config.js';
import { ModelError } from './model.js';

class InputError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const usage = `素材审核与发布排期 Agent（仅保存草稿）
用法：npm run dev -- --input examples/inputs/normal.json [选项]
  --model mock|live   默认 mock，离线不需要密钥
  --catalog PATH      默认 data/catalog.json（合成素材、规则与占用）
  --db PATH           默认 .runtime/drafts.sqlite；:memory: 不落盘
  --output PATH.json  可选的完整 JSON 报告文件
  --max-steps N       模型决策步数上限，默认16
  --max-tools N       工具调用次数上限（含finish），默认32
  --fail-save N       注入前N次保存失败，默认0
退出码：0=草稿已保存/待确认，2=需补充信息/风险阻断/输入错误，1=失败/未完成。
live 使用本地 .env 中 OPENAI_BASE_URL、OPENAI_MODEL、OPENAI_API_KEY。`;

function count(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new InputError('INVALID_LIMIT', `次数必须是${minimum}到${maximum}之间的整数`);
  return result;
}

async function aliases(left: string, right: string): Promise<boolean> {
  const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  if (normalize(resolve(left)) === normalize(resolve(right))) return true;
  try {
    const [a, b] = await Promise.all([realpath(left), realpath(right)]);
    if (normalize(a) === normalize(b)) return true;
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new InputError('INVALID_OUTPUT', '无法确认输出路径与输入资料相互独立');
  }
}

async function main(): Promise<void> {
  let store: DraftStore | undefined;
  try {
    let values;
    try {
      ({ values } = parseArgs({ options: {
        input: { type: 'string' }, model: { type: 'string', default: 'mock' },
        catalog: { type: 'string', default: 'data/catalog.json' }, db: { type: 'string', default: '.runtime/drafts.sqlite' },
        output: { type: 'string' }, 'max-steps': { type: 'string' }, 'max-tools': { type: 'string' },
        'fail-save': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      }, strict: true, allowPositionals: false }));
    } catch { throw new InputError('INVALID_OPTIONS', '命令参数不合法；运行 npm run dev -- --help 查看帮助'); }
    if (values.help) { console.log(usage); return; }
    if (!values.input) throw new InputError('INPUT_REQUIRED', '请使用 --input 提供请求 JSON 文件');
    if (!['mock', 'live'].includes(values.model)) throw new InputError('INVALID_MODEL_MODE', '--model 仅支持 mock 或 live');
    const maxSteps = count(values['max-steps'], 16, 1, 200), maxToolCalls = count(values['max-tools'], 32, 1, 200);
    const failSave = count(values['fail-save'], 0, 0, 100);
    const input = await readFile(values.input, 'utf8').catch(() => { throw new InputError('INPUT_READ_FAILED', '无法读取请求文件'); });
    const catalogInput = await readFile(values.catalog, 'utf8').catch(() => { throw new InputError('CATALOG_READ_FAILED', '无法读取合成资料文件'); });
    const request = requestSchema.parse(JSON.parse(input));
    const catalog = catalogSchema.parse(JSON.parse(catalogInput));
    if (values.output) {
      const collisions = await Promise.all([values.input, values.catalog, values.db].map(path => aliases(path, values.output!)));
      if (extname(values.output) !== '.json' || collisions.some(Boolean)) throw new InputError('INVALID_OUTPUT', '输出须为独立的 .json 文件，不能覆盖输入、资料或数据库');
    }
    const model = createModel(values.model as 'mock' | 'live');
    if (values.db !== ':memory:') await mkdir(dirname(resolve(values.db)), { recursive: true });
    store = new DraftStore(values.db);
    const tools = new SchedulingTools({ request, catalog, store, failures: { save_draft: failSave } });
    const report = await runAgent({ request, tools, model, maxSteps, maxToolCalls });
    let artifactError: { code: string; message: string } | undefined;
    if (values.output) {
      try {
        await mkdir(dirname(resolve(values.output)), { recursive: true });
        await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', 'utf8');
      } catch {
        artifactError = { code: 'REPORT_WRITE_FAILED', message: '报告文件写入失败；标准输出保留实际业务结果，已保存草稿不会回滚' };
      }
    }
    console.log(JSON.stringify({ ...report, ...(artifactError ? { artifactError } : {}) }, null, 2));
    process.exitCode = artifactError ? 1 : ['completed', 'needs_confirmation'].includes(report.taskStatus) ? 0 : ['needs_input', 'blocked'].includes(report.taskStatus) ? 2 : 1;
  } catch (error) {
    const inputError = error instanceof InputError || error instanceof ZodError || error instanceof SyntaxError;
    console.log(JSON.stringify({ taskStatus: inputError ? 'needs_input' : 'failed',
      error: { code: error instanceof InputError || error instanceof ModelError ? error.code : inputError ? 'INVALID_INPUT' : 'CLI_FAILED',
        message: error instanceof InputError || error instanceof ModelError ? error.message : inputError ? '输入不符合要求，请检查 JSON、必填字段与带时区的时间' : '执行失败，未声明任务成功',
        ...(error instanceof ZodError ? { issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })) } : {}) } }, null, 2));
    process.exitCode = inputError ? 2 : 1;
  } finally { store?.close(); }
}

await main();
