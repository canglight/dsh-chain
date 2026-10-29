/**
 * 检索评估：把「感觉能搜到」变成数字。
 *
 * 用法（在插件目录里）：
 *   cp tools/eval-queries.example.json tools/eval-queries.json    # 改成你自己的查询
 *   node tools/eval-retrieval.mjs
 *
 * 它测三条路径，给你一张对照表：
 *   A. IDF 单路（阈值 9）              —— 旧版注入段用的
 *   B. 整句子串（旧 chain_recall）      —— 只认原话，基本是 0%
 *   C. 两路融合 RRF                     —— 当前版本用的
 *
 * 指标：Recall@3 / Recall@5 / MRR（第一条命中的位置倒数）。
 * 换检索实现之前先跑它 —— 别靠"我觉得更准了"。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const LIB = resolve(argOf('--lib', join(HERE, '..', 'lib')));
const own = join(HERE, 'eval-queries.json');
const example = join(HERE, 'eval-queries.example.json');
const QFILE = resolve(argOf('--queries', existsSync(own) ? own : example));

const store = await import('file:///' + LIB.replace(/\\/g, '/') + '/store.js');
const pools = await import('file:///' + LIB.replace(/\\/g, '/') + '/pools.js');
const retrieval = await import('file:///' + LIB.replace(/\\/g, '/') + '/retrieval.js');

await retrieval.initRetrieval(join(LIB, '..'));

const fixtures = JSON.parse(readFileSync(QFILE, 'utf8')).queries ?? [];
const { entries } = store.loadAll();
const live = entries.filter((e) => !e.superseded && pools.poolOf(e) !== 'hippocampus');

console.log('库内可检索条目: ' + live.length + ' · 评估查询: ' + fixtures.length);
console.log('查询文件: ' + QFILE);
console.log('检索就绪: ' + retrieval.retrievalReady() + (retrieval.retrievalError() ? ' (' + retrieval.retrievalError() + ')' : ''));
if (live.length === 0) {
  console.log('\n库里还没有记忆 —— 先让模型记几条，或用 chain_append 写一条再跑。');
  process.exit(0);
}
console.log('');

const match = (list, expect) => {
  for (let i = 0; i < list.length; i += 1) {
    if (String(list[i]?.judgement ?? '').includes(expect)) return i + 1;
  }
  return 0;
};

function run(label, getList) {
  let r3 = 0; let r5 = 0; let mrr = 0;
  const misses = [];
  for (const f of fixtures) {
    const hit = match(getList(f.query), f.expect);
    if (hit > 0 && hit <= 3) r3 += 1;
    if (hit > 0 && hit <= 5) r5 += 1;
    if (hit > 0) mrr += 1 / hit; else misses.push(f);
  }
  const n = fixtures.length || 1;
  console.log('=== ' + label + ' ===');
  console.log('  Recall@3 ' + (r3 / n * 100).toFixed(0) + '%   Recall@5 ' + (r5 / n * 100).toFixed(0) + '%   MRR ' + (mrr / n).toFixed(2));
  if (misses.length) {
    console.log('  零命中 ' + misses.length + ' 条:');
    for (const m of misses) console.log('    ' + (m.paraphrase ? '[换说法] ' : '[原话]   ') + m.query);
  }
  const para = fixtures.filter((f) => f.paraphrase);
  const orig = fixtures.filter((f) => !f.paraphrase);
  const rate = (rows) => (rows.length === 0 ? '-' : (rows.filter((r) => {
    const h = match(getList(r.query), r.expect);
    return h > 0 && h <= 5;
  }).length / rows.length * 100).toFixed(0) + '%');
  console.log('  分档 Recall@5: 原话 ' + rate(orig) + ' · 换说法 ' + rate(para));
  console.log('');
}

run('A. IDF 单路（阈值 9）', (q) => retrieval.rankEntries(live, q, { threshold: 9, max: 5 }).map((x) => x.entry));
run('B. 整句子串（旧 chain_recall）', (q) => store.filterChains(live, { query: q }).slice(0, 5));
run('C. 两路融合 RRF（当前版本）', (q) => retrieval.rankEntriesRRF(live, q, { max: 5 }).map((x) => x.entry));
