import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { runTriage } from '../lib/triage.js';
import { loadAll } from '../lib/store.js';
import { STORE_DIR_NAME } from '../lib/config.js';

const chainsPath = resolve(homedir(), '.dsh', 'memories', STORE_DIR_NAME, 'chains.jsonl');
const defaultOut = resolve(process.cwd(), 'triage-dryrun.json');

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function parseArgs(argv) {
  let limit = 40; let out = defaultOut;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') { limit = Number(argv[++i]); if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit 必须是正整数'); }
    else if (argv[i] === '--out') { out = argv[++i]; if (!out) throw new Error('--out 缺少路径'); }
    else throw new Error(`未知参数: ${argv[i]}`);
  }
  return { limit, out: resolve(out) };
}
function materialText(entry) {
  return [entry.judgement, entry.conclusion, ...(Array.isArray(entry.evidence) ? entry.evidence : []), ...(Array.isArray(entry.hesitation) ? entry.hesitation : [])].filter((v) => typeof v === 'string' && v.trim()).join('\n');
}
async function main() {
  const { limit, out } = parseArgs(process.argv.slice(2));
  let beforeBytes;
  try {
    beforeBytes = await readFile(chainsPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.error(`找不到记忆库: ${chainsPath}`);
      console.error('说明：这个包还没在这台机器上跑过，或记忆目录不在默认位置。先正常使用插件产生少量记忆后再跑。');
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const before = sha256(beforeBytes);
  console.log(`chains.jsonl SHA-256 before: ${before}`);
  const missing = ['TRIAGE_BASE_URL', 'TRIAGE_API_KEY', 'TRIAGE_MODEL'].filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`缺少环境变量: ${missing.join(', ')}`);
    console.log(`chains.jsonl SHA-256 after:  ${sha256(await readFile(chainsPath))}`);
    process.exitCode = 1; return;
  }
  // ⚠️ 关键：chains.jsonl 是**事件流**，不是最终状态表。
  // 实测（2026-10-31）：1499 行原始事件里 `pool === 'hippocampus'` 的行数是 **0** ——
  // 因为 pool 是 materialize 时才算出来的，退役也是**独立事件行**而不是条目上的字段。
  // 所以必须走 store.loadAll() 折叠，不能直接解析原始行。
  const entries = (loadAll()?.entries) || [];
  const fragments = entries
    .filter((entry) => entry.pool === 'hippocampus' && !entry.superseded)
    .slice(0, limit)
    .map((entry) => ({ id: String(entry.id ?? ''), text: materialText(entry), ageDays: Number.isFinite(Date.parse(entry.createdAt)) ? (Date.now() - Date.parse(entry.createdAt)) / 86400000 : 0, pool: 'hippocampus' }));
  const result = await runTriage(fragments);
  const after = sha256(await readFile(chainsPath));
  const report = { source: chainsPath, selected: fragments.length, result, validation: { inputIds: fragments.map((f) => f.id), outputIds: result.groups.flatMap((g) => g.ids), errors: result.errors, sha256Before: before, sha256After: after, unchanged: before === after } };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.table([{ groups: result.groups.length, coveredIds: new Set(result.groups.flatMap((g) => g.ids)).size, validationErrors: result.errors.length, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, model: result.usage.model }]);
  console.log(`chains.jsonl SHA-256 before: ${before}`);
  console.log(`chains.jsonl SHA-256 after:  ${after}`);
  console.log(`output: ${out}`);
  if (before !== after) { console.error('错误：chains.jsonl 发生变化'); process.exitCode = 1; }
  else if (result.errors.length) process.exitCode = 1;
}

main().catch(async (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
