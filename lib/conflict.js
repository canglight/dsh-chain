/** Read-only lexical candidates. Similarity is evidence for review, not a contradiction verdict. */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from './store.js';
import { poolOf } from './pools.js';
import { initRetrieval, queryTokens, scoreEntry, searchableTextOf } from './retrieval.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const limitOf = (k) => Number.isInteger(k) && k > 0 ? k : 3;
const original = (entry) => ({
  id: String(entry.id), pool: poolOf(entry), weight: Number(entry.weight) || 0,
  judgement: entry.judgement ?? '', conclusion: entry.conclusion ?? '',
});
const indexed = (entries) => entries.filter((e) => e && e.superseded !== true)
  .map((entry) => ({ entry, text: searchableTextOf(entry), tokens: queryTokens(searchableTextOf(entry)) }));

// 泛词过滤：文档频率高 = 泛词（文件/一次/必须/代码…），这类命中只说明"字面像"。
// 不写死词表，用库内 df 自适应；并要求每对至少 1 个"专名级"锚点。
const GENERIC_DF_RATIO = 0.1;
const GENERIC_DF_MIN = 4;
function documentFrequency(items) {
  const df = new Map();
  for (const item of items) for (const w of new Set(item.tokens)) df.set(w, (df.get(w) ?? 0) + 1);
  return df;
}
function isGeneric(word, df, size) {
  const seen = df.get(word) ?? 0;
  return seen >= Math.max(GENERIC_DF_MIN, Math.ceil(size * GENERIC_DF_RATIO));
}
const isProperish = (word) => /[A-Za-z0-9_.\/\\-]/.test(word) || [...word].length >= 3;

function compare(a, b, df, size) {
  // Reuse the retrieval score: highest shared general IDF, without weight discount.
  const forward = scoreEntry(b.entry, a.tokens, b.text);
  const reverse = scoreEntry(a.entry, b.tokens, a.text);
  const shared = [...new Set([
    ...a.tokens.filter((w) => b.text.includes(w)),
    ...b.tokens.filter((w) => a.text.includes(w)),
  ])];
  const strong = shared.filter((w) => !isGeneric(w, df, size) && isProperish(w));
  const anchors = [...strong, ...shared.filter((w) => !strong.includes(w))].sort();
  // 没有一个"具体"锚点 = 只是泛词撞上，不当作候选。
  const specific = shared.filter((w) => !isGeneric(w, df, size));
  if (!specific.length) return null;
  return { a: original(a.entry), b: original(b.entry), anchors,
    score: Math.max(forward.score, reverse.score), specific: specific.length, strong: strong.length };
}
const byScore = (a, b) => (b.strong ?? 0) - (a.strong ?? 0) || b.score - a.score
  || b.anchors.length - a.anchors.length
  || a.a.id.localeCompare(b.a.id) || a.b.id.localeCompare(b.b.id);

/** Pure, same-pool, unordered pairs; top k per pool, including hippocampus. */
export function conflictPairs(entries, k = 3) {
  const pools = new Map();
  const all = indexed(entries);
  const df = documentFrequency(all);
  const size = all.length;
  for (const item of all) {
    const pool = poolOf(item.entry);
    if (!pools.has(pool)) pools.set(pool, []);
    pools.get(pool).push(item);
  }
  const result = [];
  for (const items of pools.values()) {
    const pairs = [];
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const pair = compare(items[i], items[j], df, size);
        if (pair && pair.score > 0) pairs.push(pair);
      }
    }
    result.push(...pairs.sort(byScore).slice(0, limitOf(k)));
  }
  return result;
}

/**
 * Return B's original fields plus A, shared anchors and IDF score. Never writes events.
 * With query only, the best lexical hit supplies A and its pool; A is excluded from B.
 * Invalid/missing id never falls back silently to query or to an unrelated pool.
 */
export async function conflictCandidates({ entryId, query, ids, k = 3 } = {}) {
  if (!await initRetrieval(pluginRoot)) throw new Error('Conflict retrieval unavailable');
  const items = indexed(loadAll().entries);
  const df0 = documentFrequency(items);
  const size0 = items.length;
  // 指定两条 id 直接对撞：由调用方（AI）提出怀疑，工具只算共享锚点与分数。
  if (Array.isArray(ids) && ids.length >= 2) {
    const [x, y] = ids.slice(0, 2);
    const a = items.find((item) => item.entry.id === String(x));
    const b = items.find((item) => item.entry.id === String(y));
    if (!a || !b) throw new Error('Conflict pair id unavailable');
    const pair = compare(a, b, df0, size0);
    return pair ? [{ a: pair.a, b: pair.b, anchors: pair.anchors, score: pair.score }] : [];
  }
  let source;
  if (entryId !== undefined) {
    source = items.find((item) => item.entry.id === entryId);
    if (!source) throw new Error('Conflict source id unavailable');
  } else {
    if (typeof query !== 'string' || !query.trim()) throw new Error('Provide id or query');
    const tokens = queryTokens(query);
    source = items.map((item) => ({ item, ...scoreEntry(item.entry, tokens, item.text) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.matched - a.matched
        || a.item.entry.id.localeCompare(b.item.entry.id))[0]?.item;
    if (!source) return [];
  }
  const df = documentFrequency(items);
  const size = items.length;
  return items.filter((item) => item.entry.id !== source.entry.id
      && poolOf(item.entry) === poolOf(source.entry))
    .map((item) => compare(source, item, df, size))
    .filter((pair) => pair && pair.score > 0)
    .sort(byScore).slice(0, limitOf(k))
    .map(({ a, b, anchors, score }) => ({ a, b, anchors, score }));
}

/** Full live same-pool scan, sharing compare and corpus df with conflict detection. */
export function eventReview(entries, now = Date.now()) {
  const all = indexed(entries), df = documentFrequency(all);
  const halfWritten = [], links = [];
  const day = (ts) => {
    const d = new Date(ts);
    return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
  };
  for (let i=0; i<all.length; i++) for (let j=i+1; j<all.length; j++) {
    const a=all[i], b=all[j];
    if (poolOf(a.entry) !== poolOf(b.entry)) continue;
    const ta=Date.parse(a.entry.ts), tb=Date.parse(b.entry.ts);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) continue;
    const pair=compare(a,b,df,all.length);
    if (!pair) continue;
    if (pair.strong >= 2 && Math.abs(ta-tb) >= 3_600_000) {
      const [early,late]=ta<tb ? [a.entry,b.entry] : [b.entry,a.entry];
      halfWritten.push({early,late,anchors:pair.anchors,strong:pair.strong});
    }
    if (pair.strong >= 3 && ta >= now-7*86_400_000 && tb >= now-7*86_400_000
        && ta <= now && tb <= now && day(ta) === day(tb)) {
      links.push({a:a.entry,b:b.entry,anchors:pair.anchors,day:day(ta)});
    }
  }
  // Connected components of qualifying pairs; day and pool never cross.
  const groups=[];
  for (const link of links) {
    const matches=groups.filter(g=>g.members.has(link.a.id)||g.members.has(link.b.id));
    const group=matches[0]??{day:link.day,members:new Set(),anchors:new Set()};
    if (!matches.length) groups.push(group);
    for (const other of matches.slice(1)) {
      for (const id of other.members) group.members.add(id);
      for (const anchor of other.anchors) group.anchors.add(anchor);
      groups.splice(groups.indexOf(other),1);
    }
    group.members.add(link.a.id); group.members.add(link.b.id);
    for (const anchor of link.anchors) group.anchors.add(anchor);
  }
  const sequence=new Map();
  const suggestions=groups.sort((a,b)=>a.day.localeCompare(b.day)
    || [...a.members].sort().join().localeCompare([...b.members].sort().join())).map(g=>{
    const n=(sequence.get(g.day)??0)+1; sequence.set(g.day,n);
    return {eventId:'ev-'+g.day+'-'+n,ids:[...g.members].sort(),anchors:[...g.anchors].sort()};
  });
  halfWritten.sort((a,b)=>b.strong-a.strong||a.early.id.localeCompare(b.early.id));
  return {halfWritten,suggestions};
}
