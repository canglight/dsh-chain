/**
 * 联想边（2026-10-30）：条目之间的持久连接。
 *
 * **为什么必须有这一步**：现在的"走线"是每次现算——两条记忆共享了 df 2~3 的稀有词，
 * 就临时当成邻居。那等价于**没有边**：
 *   · 同一个查询每次都要重算 470 个词 × 全库；
 *   · 边不累积、不遗忘，也学不到"哪两条老是一起被想起"；
 *   · 夜巡③ 明明已经找出「讲了同一件事却没连线」的对，却只写进报告，没沉淀。
 *
 * 所以这里给边一个独立的小文件（不进 chains.jsonl，因为边不是"记忆"）：
 *   ~/.dsh/memories/.chain-<id8>/edges.jsonl
 *
 * 一行一条边：`{ a, b, w, via, kind, ts, hits }`
 *   · a/b   条目 id（**排序后存**，避免 A→B 与 B→A 存两条）
 *   · w     权重 0..1
 *   · via   凭什么连（共享的那个词 / 'co-recall' / 'manual'）
 *   · hits  这条边被走过几次
 *
 * 三条硬规矩：
 *   ① 只增不减的文件，但**权重会淡**（读的时候按天衰减，不重写历史）；
 *   ② 边不改记忆正文、不改池、不改权重 —— 它只是"路"；
 *   ③ 建错可回退：删掉 edges.jsonl 就回到"没有边"的状态。
 *
 * @module dsh-chain-shared/edges
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { storeDir } from './config.js';

/** 边权重下限：低于它就当作没有这条边（不删，只是不参与走线）。 */
export const EDGE_MIN_WEIGHT = 0.12;
/** 边权重的半衰期（天）：没人走的边会慢慢变轻。 */
export const EDGE_HALF_LIFE_DAYS = 45;
/** 单次「一起被想起」给边加多少（Hebbian）。 */
export const EDGE_CO_RECALL_BOOST = 0.06;

/** 边的文件路径。 */
export function edgesPath() {
  return join(storeDir(), 'edges.jsonl');
}

/** 无向边的规范键：两个 id 排序后拼起来。 */
function pairKey(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x <= y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * 读全部边，**按时间衰减后的权重**返回。
 *
 * 衰减用半衰期而不是线性：边和记忆一样，不该"到点突然消失"。
 *
 * @param nowMs - 当前时间（便于测试注入）。
 * @returns `Map<pairKey, { a, b, w, rawW, via, kind, ts, hits, ageDays }>`
 */
export function loadEdges(nowMs = Date.now()) {
  const path = edgesPath();
  const out = new Map();
  if (!existsSync(path)) return out;
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    let rec = null;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    if (!rec || !rec.a || !rec.b) continue;
    const key = pairKey(rec.a, rec.b);
    const prev = out.get(key);
    const tsMs = Date.parse(String(rec.ts ?? '')) || 0;
    const ageDays = tsMs > 0 ? Math.max(0, (nowMs - tsMs) / 86400000) : 0;
    const rawW = Math.max(0, Math.min(1, Number(rec.w) || 0));
    const decay = 0.5 ** (ageDays / EDGE_HALF_LIFE_DAYS);
    const w = Number((rawW * decay).toFixed(3));
    // 同一条边出现多次：取"最近那条 + 最大权重 + hits 累加"
    if (prev) {
      prev.rawW = Math.max(prev.rawW, rawW);
      prev.hits += Number(rec.hits) || 0;
      if (tsMs > (Date.parse(String(prev.ts ?? '')) || 0)) {
        prev.ts = rec.ts;
        prev.via = rec.via ?? prev.via;
        prev.kind = rec.kind ?? prev.kind;
      }
      const prevDecay = 0.5 ** (prev.ageDays / EDGE_HALF_LIFE_DAYS);
      prev.w = Number((prev.rawW * prevDecay).toFixed(3));
    } else {
      out.set(key, {
        a: rec.a,
        b: rec.b,
        w,
        rawW,
        via: String(rec.via ?? ''),
        kind: String(rec.kind ?? 'related'),
        ts: rec.ts ?? '',
        hits: Number(rec.hits) || 0,
        ageDays,
      });
    }
  }
  return out;
}

/**
 * 建一条边（或给已有边加权）。
 *
 * @param a - 条目 id。
 * @param b - 条目 id。
 * @param options - `{ via, kind, w, hits }`。
 * @returns 写入的记录；参数非法时返回 null。
 */
export function addEdge(a, b, options = {}) {
  const ida = String(a ?? '');
  const idb = String(b ?? '');
  if (ida === '' || idb === '' || ida === idb) return null;
  try {
    const dir = storeDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const rec = {
      a: ida,
      b: idb,
      w: Math.max(0, Math.min(1, Number(options.w) || 0.3)),
      via: String(options.via ?? ''),
      kind: String(options.kind ?? 'related'),
      ts: new Date().toISOString(),
      hits: Math.max(0, Math.floor(Number(options.hits) || 0)),
    };
    appendFileSync(edgesPath(), JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  } catch {
    return null;
  }
}

/**
 * 一起被想起 → 这条边变强（Hebbian：一起放电，一起连）。
 *
 * @param ids - 这一轮被想起的条目 id 列表。
 * @param options - `{ via, maxPairs }`。
 * @returns 实际加强了几条边。
 */
export function reinforce(ids, options = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x ?? '')))].filter((x) => x !== '');
  if (list.length < 2) return 0;
  const maxPairs = Math.max(1, Number(options.maxPairs) || 6);
  const edges = loadEdges();
  let done = 0;
  for (let i = 0; i < list.length && done < maxPairs; i += 1) {
    for (let j = i + 1; j < list.length && done < maxPairs; j += 1) {
      const key = pairKey(list[i], list[j]);
      const prev = edges.get(key);
      // 只有**已经存在**的边才加强 —— 不凭空造边，否则一轮就可能长出一堆假关联。
      if (!prev) continue;
      addEdge(prev.a, prev.b, {
        via: prev.via,
        kind: prev.kind,
        w: Math.min(1, prev.rawW + EDGE_CO_RECALL_BOOST),
        hits: prev.hits + 1,
      });
      done += 1;
    }
  }
  return done;
}

/**
 * 取一条条目的邻居（按权重降序）。
 *
 * @param id - 条目 id。
 * @param options - `{ max, minWeight }`。
 * @returns `[{ id, w, via, kind }]`
 */
export function neighborsOf(id, options = {}) {
  const target = String(id ?? '');
  if (target === '') return [];
  const max = Math.max(1, Number(options.max) || 4);
  const minWeight = Number.isFinite(Number(options.minWeight)) ? Number(options.minWeight) : EDGE_MIN_WEIGHT;
  const edges = loadEdges();
  const out = [];
  for (const e of edges.values()) {
    if (e.w < minWeight) continue;
    if (e.a === target) out.push({ id: e.b, w: e.w, via: e.via, kind: e.kind });
    else if (e.b === target) out.push({ id: e.a, w: e.w, via: e.via, kind: e.kind });
  }
  out.sort((x, y) => y.w - x.w);
  return out.slice(0, max);
}

/** 统计信息（给夜巡 / 调试用）。 */
export function edgeStats(nowMs = Date.now()) {
  const edges = loadEdges(nowMs);
  const alive = [...edges.values()].filter((e) => e.w >= EDGE_MIN_WEIGHT);
  const deg = new Map();
  for (const e of alive) {
    deg.set(e.a, (deg.get(e.a) || 0) + 1);
    deg.set(e.b, (deg.get(e.b) || 0) + 1);
  }
  const degs = [...deg.values()].sort((a, b) => b - a);
  return {
    total: edges.size,
    alive: alive.length,
    nodes: deg.size,
    maxDegree: degs[0] ?? 0,
    avgDegree: deg.size === 0 ? 0 : Number((degs.reduce((s, n) => s + n, 0) / deg.size).toFixed(2)),
  };
}

/* ════════════ 第一批边：从"共享稀有词"长出来 ════════════ */

/** 中文虚字：以它们开头/结尾的滑窗碎片不算词（与 patrol/trace 同一套判据）。 */
const EDGE_STOP = new Set('的了是在我他她你您我们这就都很也还又和与及而但所以因为如果这个那个一些什么怎么可以不是没有一自己现在时候这样那样东西事情吗呢吧啊哦呀嘛啦么着过被把让给对从向'.split(''));

/** 2–8 字滑窗，过滤虚字碎片。 */
function wordsOf(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const run of s.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let n = 2; n <= 8; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) {
        const w = run.slice(i, i + n);
        if (EDGE_STOP.has(w[0]) || EDGE_STOP.has(w[w.length - 1])) continue;
        if ([...w].every((c) => EDGE_STOP.has(c))) continue;
        out.add(w);
      }
    }
  }
  return out;
}

/**
 * 词尾巴上的虚义字：以它们收尾的滑窗碎片不该当桥。
 * 实测噪音样本：「插件只」「输出里」「测试里」「省时间」—— 都是把半句切成"像词"的碎片。
 */
const EDGE_TAIL_STOP = new Set('只里上时个些样法来去们么过着把让给对从向就是都在和有也都还又而但所以因为如果'.split(''));

/** 这个词够不够格当桥：长度 ≥3、首尾不是虚字、尾巴也不是虚义字。 */
function isBridgeWord(w) {
  if (w.length < 3) return false;
  if (EDGE_STOP.has(w[0]) || EDGE_STOP.has(w[w.length - 1])) return false;
  if (EDGE_TAIL_STOP.has(w[w.length - 1])) return false;
  return true;
}

/** 只保留极大词：`空转的` 出现了就不留 `空转`。 */
function maximalWords(words) {
  const list = [...words].sort((a, b) => b.length - a.length);
  const kept = [];
  for (const w of list) {
    if (kept.some((k) => k.includes(w))) continue;
    kept.push(w);
  }
  return kept;
}

/**
 * 计划第一批边：哪些条目"共享了罕见的词"，应该连起来。
 *
 * 这是**纯函数**，只出计划不写盘 —— 写盘由调用方决定（夜巡 / 手动脚本）。
 *
 * df 门槛用 **2..3**：df=1 的词只在自己那条里出现，永远连不上别人（实测占 95%）；
 * df 太大的词是"的/我们"这类，不是桥。
 *
 * @param entries - `loadAll()` 的 entries（内部会滤掉已取代与海马体）。
 * @param options - `{ maxEdges, minWordLen }`。
 * @returns `[{ a, b, via, w }]`
 */
export function planEdges(entries, options = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && e.id != null && e.superseded !== true && e.pool !== 'hippocampus',
  );
  const maxEdges = Math.max(1, Number(options.maxEdges) || 200);
  const minWordLen = Math.max(2, Number(options.minWordLen) || 3);

  const byIdAlive = new Set(list.map((e) => String(e.id)));
  const wordsById = new Map();
  const df = new Map();
  for (const e of list) {
    const ws = wordsOf(`${e.judgement ?? ''} ${e.conclusion ?? ''}`);
    wordsById.set(String(e.id), ws);
    for (const w of ws) df.set(w, (df.get(w) || 0) + 1);
  }
  // 每条的可当桥的词（df 2..3，且够长）
  const bridgeOf = new Map();
  for (const [id, ws] of wordsById) {
    const out = new Set();
    for (const w of ws) {
      const d = df.get(w) || 0;
      if (d < 2 || d > 3) continue;
      if (w.length < minWordLen) continue;
      if (!isBridgeWord(w)) continue;
      out.add(w);
    }
    bridgeOf.set(id, out);
  }

  const out = [];

  // **标签桥**（2026-10-30）：tags 是写记忆时手写的，比"共享一个滑窗词"可信得多。
  // 两条记忆共享同一个标签（比如都带「检索」「记忆」），就是真的同一主题。
  // 权重给得更高（0.5 起），而且"共享标签越多越强"。
  const genericTags = new Set(['片段', '未归类']);
  const byTag = new Map();
  for (const e of list) {
    const tags = Array.isArray(e.tags) ? e.tags : [];
    for (const t of tags) {
      const tag = String(t ?? '').trim();
      if (tag.length < 2 || genericTags.has(tag)) continue;
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(String(e.id));
    }
  }
  // **星形而不是团块**（2026-10-30 实测）：同一标签下两两全连会造出平均度 8.11 的团块，
  // 联想一扩散就是半库噪声。改成"一个中心连最多 3 个同标签条目"。
  const tagPair = new Map();
  for (const [tag, ids] of byTag) {
    if (ids.length < 2 || ids.length > 12) continue;   // 太长的标签等于"什么都沾"，不当桥
    const hub = ids[0];
    for (let k = 1; k < ids.length && k <= 3; k += 1) {
      const key = hub + '|' + ids[k];
      const prev = tagPair.get(key);
      if (prev) { prev.n += 1; continue; }
      tagPair.set(key, { a: hub, b: ids[k], n: 1, tag });
    }
  }
  for (const [, p] of tagPair) {
    const w = Math.min(0.7, Number((0.4 + 0.1 * (p.n - 1)).toFixed(2)));
    out.push({ a: p.a, b: p.b, via: '标签「' + p.tag + '」', w });
    if (out.length >= maxEdges) break;
  }

  const ids = [...bridgeOf.keys()];
  for (let i = 0; i < ids.length && out.length < maxEdges; i += 1) {
    const a = ids[i];
    const wa = bridgeOf.get(a);
    if (wa.size === 0) continue;
    for (let j = i + 1; j < ids.length && out.length < maxEdges; j += 1) {
      const b = ids[j];
      const wb = bridgeOf.get(b);
      if (wb.size === 0) continue;
      const shared = [];
      for (const w of wa) if (wb.has(w)) shared.push(w);
      if (shared.length === 0) continue;
      const words = maximalWords(shared);
      if (words.length === 0) continue;
      const via = words[0];
      // 初始权重：共享词越长越可信；共享多个词再加一点。上限 0.6 —— 现算的桥只是"可能相关"。
      const w = Math.min(0.6, Number((0.25 + 0.05 * via.length + 0.05 * (words.length - 1)).toFixed(2)));
      out.push({ a, b, via, w });
    }
  }

  // **最近邻弱边**（2026-10-30）：实测 131 条里 39 条一条边都没有。
  // 上一版试过"把 df 放宽到 4"—— 只多出 1 条，因为孤立条目的词全是独有词（df=1），
  // 词面根本不重叠。**这类条目要接上，只能靠"字面上最像的那一条"**：
  // 用二元组重叠找最相似的一条，连一条**弱边**（w=0.22，比标签桥 0.4 / 词桥 0.3 都弱），
  // kind 标成 'nn' —— 让人一眼看出这不是同义词桥，是"凑近看"。
  const bigramsOf = (id) => {
    const ws = wordsById.get(id) ?? new Set();
    const out = new Set();
    for (const w of ws) {
      for (let k = 0; k + 2 <= w.length; k += 1) out.add(w.slice(k, k + 2));
    }
    return out;
  };
  const hasEdge = new Set();
  for (const e of out) { hasEdge.add(e.a); hasEdge.add(e.b); }
  for (const [id] of wordsById) {
    if (hasEdge.has(id)) continue;
    const mine = bigramsOf(id);
    if (mine.size === 0) continue;
    let bestId = null;
    let bestScore = 0;
    for (const [other] of wordsById) {
      if (other === id) continue;
      const theirs = bigramsOf(other);
      let shared = 0;
      for (const g of mine) if (theirs.has(g)) shared += 1;
      if (shared > bestScore) { bestScore = shared; bestId = other; }
    }
    // 至少共享 3 个二元组才算"像" —— 1-2 个太常见，等于乱连
    if (bestId !== null && bestScore >= 3) {
      out.push({ a: id, b: bestId, via: '字面最近邻', w: 0.22, kind: 'nn' });
      hasEdge.add(id);
      hasEdge.add(bestId);
    }
  }

  // **度上限**（2026-10-30）：任何节点的度不超过 maxDegree（默认 5）。
  // 度太高的节点会把"联想"变成"什么都连得上"，那等价于没有联想。
  // 保留权重高的边，超出的直接不建。
  const maxDegree = Math.max(1, Number(options.maxDegree) || 5);
  const deg = new Map();
  const capped = [];
  out.sort((x, y) => y.w - x.w);
  for (const e of out) {
    const da = deg.get(e.a) || 0;
    const db = deg.get(e.b) || 0;
    if (da >= maxDegree || db >= maxDegree) continue;
    deg.set(e.a, da + 1);
    deg.set(e.b, db + 1);
    capped.push(e);
  }
  return capped.slice(0, maxEdges);
}

