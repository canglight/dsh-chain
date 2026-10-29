/**
 * 夜巡：定期扫一遍记忆库，**只出报告，不改数据**。
 *
 * 为什么不自动合并：合并会改写"我记得什么"，而判断"这两条该不该并"需要语义，
 * 一旦并错（两条不同判断被压成一条），原始区分就永久丢了 —— JSONL 能回滚，
 * 但"这两条本来是不同的"这个信息已经没人能恢复了。
 *
 * 所以这里只做三件事，全部输出成给人看的清单：
 *   1. **久未命中**：非原则、从没被想起过、又放了一阵子 → 遗忘候选
 *   2. **疑似重复**：判断句高度相似 → 合并候选（由人拍板）
 *   3. **共享关键词但没连线**：讲同一件事却没有 related 边 → 建链候选
 *
 * @module dsh-chain/patrol
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { storeDir } from './config.js';
import { appendChainEvent } from './store.js';
// 海马体那一节要判池子。注意：**这类漏 import 的错，模块加载时不报，调用时才炸**
// （2026-10-28 差点又犯：import 检查全绿，一调用就 ReferenceError）。
import { hasPoolRule, poolDef, poolOf } from './pools.js';

/**
 * 自动归整的安全边界（写死在这里，不许外部传入放宽）。
 *
 * 因为这是整个系统里**唯一会自己改记忆参数**的动作，边界必须保守：
 *   · 单次最多挪 ±0.05（一次一小步，可观察）
 *   · 一条记忆累计偏移夹在 [-0.15, +0.10]（挪不飞）
 *   · **只动权重，永不改 judgement / conclusion / evidence**（内容改了找不回来）
 *   · 被取代的、原则类的，一律不动
 */
const REBALANCE_STEP = 0.05;
const REBALANCE_FLOOR = -0.15;
const REBALANCE_CEIL = 0.10;
/** 判"疑似重复"的阈值。低于它不动手 —— 让重复检测宁缺毋滥。 */
const DUPLICATE_SIM = 0.60;
/** 被想起这么多次，就该把之前压下去的分还回来。 */
const RECOVER_TOUCH = 3;

/** 常见虚词/连接词，不当作"关键词"。 */
const STOP = new Set([
  '这个', '那个', '这些', '那些', '不是', '就是', '可以', '应该', '一个', '什么',
  '怎么', '因为', '所以', '但是', '而且', '如果', '已经', '还有', '没有', '我们',
  '你们', '他们', '自己', '时候', '现在', '之前', '之后', '东西', '事情', '问题',
  '的话', '一样', '这样', '那样', '知道', '觉得', '需要', '直接', '还是', '一下',
  '这里', '那里', '以及', '对于', '关于', '不会', '不能', '不要', '一定', '其实',
]);

/**
 * 切出候选词：2–8 字滑窗，去虚词。
 * @param text - 任意文本。
 * @returns 去重后的词数组。
 */
function wordsOf(text) {
  const out = new Set();
  const clean = String(text ?? '').replace(/[^\u4e00-\u9fa5]+/g, '\u0000');
  for (const seg of clean.split('\u0000')) {
    if (seg.length < 2) continue;
    for (let len = Math.min(8, seg.length); len >= 2; len -= 1) {
      for (let i = 0; i + len <= seg.length; i += 1) {
        const w = seg.slice(i, i + len);
        if (!STOP.has(w)) out.add(w);
      }
    }
  }
  return [...out];
}

/**
 * 字符 3-gram 的 Jaccard 相似度 —— 用来判"两句话是不是在说同一件事"。
 * @param a - 文本 A。
 * @param b - 文本 B。
 * @returns 0~1。
 */
function similarity(a, b) {
  const grams = (s) => {
    const t = String(s ?? '').replace(/\s+/g, '');
    const set = new Set();
    for (let i = 0; i + 3 <= t.length; i += 1) set.add(t.slice(i, i + 3));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

const isPrincipleEntry = (entry) => {
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  return tags.some((tag) => typeof tag === 'string' && tag.includes('原则'));
};

/**
 * 海马体片段的**分拣信号**：只用词面信号猜它该归哪个池，不调模型、不写盘。
 *
 * 为什么用这么笨的办法：海马体里绝大多数片段本来就没价值（"重启了""哈哈哈"），
 * 只为一小部分去调模型不划算。词面信号能把「出过什么错 / 用户有什么偏好」筛出来，
 * 剩下的按"一次性进展"处理 —— **宁可漏掉，也不要拿噪声去污染长记忆**。
 *
 * @param entry - 海马体片段。
 * @returns `{ pool, label, hits }`
 */
function triageFragment(entry) {
  const text = [
    String(entry?.judgement ?? ''),
    ...(Array.isArray(entry?.evidence) ? entry.evidence.map(String) : []),
  ].join(' ');
  const RULES = [
    {
      pool: 'skill',
      label: '技能/教训',
      words: ['错了', '不对', '改成', '实测', '发现', '原来', '导致', '根因', '下次', '注意',
        '应该', '漏了', '崩', '失败', '修好', '报错'],
    },
    {
      pool: 'fact',
      label: '关于用户的事实',
      words: ['用户喜欢', '用户不喜欢', '用户讨厌', '用户习惯', '用户说过', '偏好', '不要', '必须', '约定'],
    },
  ];
  // **默认兜底 = 日常**（2026-10-29 修）：原来写的是「一次性进展（可丢）」，
  // 而闲聊（"差不多了""间距再小些""哎？上下文还有很长啊"）恰好落进这个兜底 ——
  // 于是夜巡在建议里把它们标成"可丢"，我照着做，把日常层筛空了。
  // 客户的说法：闲聊算日常的。所以这里默认转成日常条目，措辞也不再用"可丢"。
  let best = { pool: 'dailyPartial', label: '日常（相处质感，转成 dailyCore / dailyPartial 条目再退役）', hits: [] };
  let bestScore = 0;
  for (const rule of RULES) {
    const hits = rule.words.filter((w) => text.includes(w));
    if (hits.length > bestScore) {
      bestScore = hits.length;
      best = { pool: rule.pool, label: rule.label, hits };
    }
  }
  return best;
}

const ageDaysOf = (entry) => {
  const from = Date.parse(String(entry.lastTouched || entry.ts || ''));
  return Number.isFinite(from) ? (Date.now() - from) / 86_400_000 : 0;
};

/**
 * 生成一份夜巡报告。
 *
 * @param entries - `loadAll()` 的 entries。
 * @param options - `{ now?: number, staleDays?: number, top?: number }`
 * @returns `{ markdown, counts }`
 */
export function buildPatrolReport(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const top = Math.max(1, Number(options.top) || 10);
  const staleDays = Number.isFinite(Number(options.staleDays)) ? Number(options.staleDays) : 14;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();

  const principles = list.filter(isPrincipleEntry);
  const rest = list.filter((entry) => !isPrincipleEntry(entry));

  // **只拿"还活着"的条目做检测**（2026-10-28 修）。
  // 之前 ②③ 直接遍历 list，把已被取代的条目也算进去 —— 于是报告里出现
  // 「我早就 supersede 过的垃圾片段，还在跟自己配对」这种噪声，白占注意力。
  const living = list.filter((entry) => entry.superseded !== true);
  // **②③⑤ 只看"成过条的"记忆**（2026-10-29）：海马体里是原始片段，
  // 它们天然重复（"重启了"写两次就配成一对），而且拿权重去压原料毫无意义。
  const settled = living.filter((entry) => poolOf(entry) !== 'hippocampus');

  // ---- ① 久未命中：从没被想起过，而且放了一阵子 ----
  const stale = rest
    .filter((entry) => entry.superseded !== true)
    .filter((entry) => Number(entry.touchCount || 0) === 0 && ageDaysOf(entry) >= staleDays)
    .sort((a, b) => Number(b.weight) - Number(a.weight));

  // ---- ② 疑似重复：判断句相似度高 ----
  const dupes = [];
  for (let i = 0; i < settled.length; i += 1) {
    for (let j = i + 1; j < settled.length; j += 1) {
      const a = settled[i];
      const b = settled[j];
      const sim = similarity(a.judgement, b.judgement);
      if (sim >= 0.55) dupes.push({ a, b, sim });
    }
  }
  dupes.sort((x, y) => y.sim - x.sim);

  // ---- ③ 共享稀有词但没连线 ----
  const wordDf = new Map();
  const entryWords = settled.map((entry) => wordsOf(`${entry.judgement} ${entry.conclusion}`));
  for (const ws of entryWords) for (const w of ws) wordDf.set(w, (wordDf.get(w) || 0) + 1);
  const rareOf = (ws) => new Set(ws.filter((w) => (wordDf.get(w) || 0) <= 2));
  const rareSets = entryWords.map(rareOf);
  const sharedPairs = [];
  // 同一对记忆只留一行：先按 id 归并，词集取并集 —— 否则同一对会因词集不同出现两三次。
  const pairKey = (x, y) => [String(x.id), String(y.id)].sort().join('|');
  const pairMap = new Map();
  for (let i = 0; i < settled.length; i += 1) {
    for (let j = i + 1; j < settled.length; j += 1) {
      const shared = [...rareSets[i]].filter((w) => rareSets[j].has(w) && w.length >= 2);
      const meaningful = shared.filter((w) => w.length >= 3 || (wordDf.get(w) || 0) === 1);
      if (meaningful.length >= 2) {
        const key = pairKey(settled[i], settled[j]);
        const prev = pairMap.get(key);
        if (prev === undefined) pairMap.set(key, { a: settled[i], b: settled[j], words: new Set(meaningful) });
        else for (const w of meaningful) prev.words.add(w);
      }
    }
  }
  // 滑窗会把「不等于能启动」拆成「不等于能启」「等于能启动」等一堆子串，
  // 于是同一件事显示四遍。只保留**极大词**：任何是别人子串的都丢掉。
  const maximalWords = (wordSet) => {
    const sorted = [...wordSet].sort((x, y) => y.length - x.length || x.localeCompare(y));
    const out = [];
    for (const w of sorted) {
      if (!out.some((kept) => kept.includes(w))) out.push(w);
    }
    return out;
  };
  for (const item of pairMap.values()) {
    const words = maximalWords(item.words);
    if (words.length >= 1) sharedPairs.push({ a: item.a, b: item.b, words: words.slice(0, 3) });
  }
  sharedPairs.sort((x, y) => y.words.join('').length - x.words.join('').length);

  // ---- 拼报告 ----
  const fmtDate = (ts) => String(ts ?? '').slice(0, 10);
  const row = (entry) => `- \`${entry.id}\` w=${Number(entry.weight).toFixed(2)} ｜ 被想起 ${Number(entry.touchCount || 0)} 次 ｜ ${fmtDate(entry.ts)} ｜ ${String(entry.judgement).slice(0, 60)}`;
  const lines = [];

  lines.push(`# 夜巡报告 · ${new Date(now).toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('> 自动生成。**只出清单，不改数据** —— 合并/取代/归档都由人拍板。');
  lines.push('');
  lines.push('## 概览');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 记录总数 | ${list.length} |`);
  lines.push(`| 原则（永不衰减） | ${principles.length} |`);
  lines.push(`| 其余（会衰减） | ${rest.length} |`);
  const recalled = rest.filter((entry) => Number(entry.touchCount || 0) > 0).length;
  lines.push(`| 其中被想起过的 | ${recalled} |`);
  lines.push(`| 从没被想起过 | ${rest.length - recalled} |`);
  lines.push(`| 已被取代 | ${list.filter((entry) => entry.superseded).length} |`);
  lines.push('');

  lines.push(`## ① 久未命中（≥${staleDays} 天没被想起，共 ${stale.length} 条）`);
  lines.push('');
  lines.push('这些是"已经在淡"的候选。不用处理 —— 想留就留，想清就 supersede。');
  lines.push('');
  lines.push(...(stale.length === 0 ? ['（无）'] : stale.slice(0, top).map(row)));
  lines.push('');

  lines.push(`## ② 疑似重复（判断句相似度 ≥0.55，共 ${dupes.length} 对）`);
  lines.push('');
  lines.push('**只建议，不自动合并。** 合并会改写"我记得什么"，合错了原始区分找不回来。');
  lines.push('');
  if (dupes.length === 0) lines.push('（无）');
  for (const { a, b, sim } of dupes.slice(0, top)) {
    lines.push(`- 相似度 ${sim.toFixed(2)}`);
    lines.push(`  - \`${a.id}\` ${String(a.judgement).slice(0, 60)}`);
    lines.push(`  - \`${b.id}\` ${String(b.judgement).slice(0, 60)}`);
  }
  lines.push('');

  lines.push(`## ③ 共享关键词但没连线（共 ${sharedPairs.length} 对）`);
  lines.push('');
  lines.push('讲同一件事却没建 related 边 —— 可以给它们补一条联系，让图连起来。');
  lines.push('');
  if (sharedPairs.length === 0) lines.push('（无）');
  for (const { a, b, words } of sharedPairs.slice(0, top)) {
    lines.push(`- 共同词：${words.join(' · ')}`);
    lines.push(`  - \`${a.id}\` ${String(a.judgement).slice(0, 50)}`);
    lines.push(`  - \`${b.id}\` ${String(b.judgement).slice(0, 50)}`);
  }
  lines.push('');

  // ④ 海马体待整理：最近三天的原始片段，**还没成条**。
  //
  // 它不进注入、不上图，只在这里露一次面 —— 让人（和下一次夜巡）知道
  // 有哪些原料还躺在缓冲区里，三天后就会被加工掉或过期。
  const nowMs2 = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  // 片段标记：自动捕获写进海马体的条目，judgement 一定以「片段：」开头。
  const FRAG_PREFIX = '片段：';
  const isFragment = (entry) => String(entry?.judgement ?? '').startsWith(FRAG_PREFIX);
  const buffer = list
    .filter((entry) => entry && entry.superseded !== true && poolOf(entry) === 'hippocampus')
    .map((entry) => {
      const from = Date.parse(String(entry.ts ?? ''));
      return { entry, ageDays: Number.isFinite(from) ? (nowMs2 - from) / 86_400_000 : Infinity };
    })
    .filter((row) => row.ageDays <= poolDef('hippocampus').archiveDays)
    .sort((a, b) => a.ageDays - b.ageDays);
  // **B：两组分开**。原来一个数组按年龄切 10 条 —— 今天半天就有十几条片段，
  // 那几条等着分类的老判断一条也挤不进来，等于这一步白做。
  const bufferJudgments = buffer.filter((row) => !isFragment(row.entry));
  const bufferFragments = buffer.filter((row) => isFragment(row.entry));
  lines.push(`## ④ 海马体待整理（判断 ${bufferJudgments.length} 条 · 原始片段 ${bufferFragments.length} 条）`);
  lines.push('');
  lines.push('**判断** = 需要人（或下一次夜巡）决定归哪个池的条目，优先看这些；');
  lines.push('**片段** = 原话原料，三天内该被整理成判断，否则自己过期。');
  lines.push('');
  lines.push('### 怎么清（一步，不用逐条点）');
  lines.push('');
  lines.push('把同类片段**合并成一条判断**写进去（`chain_append`）—— 被它覆盖的原料会**自动退役**。');
  lines.push('判据是「双向包含」或「二元组相似 ≥0.55」，所以合并时把关键原话带进判断正文最稳。');
  lines.push('剩下的纯噪声（「重启了」「差不多了」这类）不用管，三天后自己过期。');
  lines.push('');
  if (buffer.length === 0) lines.push('（无）');
  // F：判断用 judgement 当摘要（原来错用了 evidence[0]，会显示成不相干的技术事实）
  for (const { entry, ageDays } of bufferJudgments.slice(0, top)) {
    lines.push(`- ${ageDays.toFixed(1)} 天前 · \`${entry.id}\` · ${String(entry.judgement ?? '').slice(0, 70)}`);
    lines.push('  建议：**先定池**（chain_touch 的 set-pool），别让它三天后过期');
  }
  for (const { entry, ageDays } of bufferFragments.slice(0, top)) {
    const said = String(entry.judgement ?? '').slice(FRAG_PREFIX.length, FRAG_PREFIX.length + 60);
    const triage = triageFragment(entry);
    lines.push(`- ${ageDays.toFixed(1)} 天前 · \`${entry.id}\` · ${said}`);
    lines.push(`  建议：${triage.label}${triage.hits.length > 0 ? `（命中 ${triage.hits.join('、')}）` : ''}`);
  }
  lines.push('');

  // ⑤ 自动归整：只报"已经/将要"怎么动权重，永不改正文。
  const plan = buildRebalancePlan(settled, { sim: DUPLICATE_SIM, maxActions: top });
  lines.push(`## ⑤ 自动归整（只调权重，共 ${plan.length} 条动作）`);
  lines.push('');
  lines.push('**只动权重，一个字的正文都没改**；单次 ±0.05，一条累计夹在 −0.15 ~ +0.10。');
  lines.push('');
  if (plan.length === 0) lines.push('（无）');
  for (const action of plan) {
    lines.push(`- \`${action.id}\` ${action.delta > 0 ? '+' : ''}${action.delta.toFixed(2)} ｜ ${action.reason}`);
    lines.push(`  - ${String(action.judgement).slice(0, 56)}`);
  }
  lines.push('');

  // ⑥ 未归类待审（2026-10-29 用户定的规则；B/C/D 三处修正在同一天）
  //
  // 池子决定"这条活多久"。标签没命中任何规则时**不再猜**：一律落海马体
  // （原料缓冲区：3 天过期、永不注入）并打「未归类」标注，由这一节把它捞出来。
  // 同一句重复写满 3 次 → 升级「需人工定池」：反复出现说明它值得留，只是标签认不出。
  const UNCLASSIFIED_ESCALATE = 3;
  const unclassified = new Map();
  for (const entry of living) {
    if (entry.superseded === true) continue;
    // 只审「还在海马体里」的：人工定过池的条目已经离开缓冲区，
    // 再去催人定池就是重复提醒（2026-10-29 实测：定到 fact 之后它还赖在 ⑥ 里）。
    if (poolOf(entry) !== 'hippocampus') continue;
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    // **C：两条入口都算**。
    //   ① 标签里带「未归类」（1.4.x 之后由 chain_append 自动打的标）；
    //   ② 标签没命中任何池规则 —— 这才能把 1.4.x 之前写的老条目捞进来，
    //      否则它们只在 ④ 里待三天，然后从图上消失，永远到不了「人工定池」这一步。
    const flagged = tags.some((tag) => String(tag).includes('未归类'));
    const unmatched = !hasPoolRule(tags);
    if (!flagged && !unmatched) continue;
    const key = String(entry.judgement ?? '').slice(0, 120);
    const prev = unclassified.get(key);
    if (prev) {
      prev.ids.push(String(entry.id));
    } else {
      unclassified.set(key, { ids: [String(entry.id)] });
    }
  }
  // **D：按夜巡轮次累计**，不再数记录条数 ——
  // 同一条只写一次的话，"条数"永远是 1，永远升不了级；
  // 而"它出现在几期报告里"才是"反复出现"的真意思。
  const unclassifiedRows = [...unclassified.entries()]
    .map(([key, v]) => ({ key, rounds: countReportRounds(key), ids: v.ids }))
    .sort((a, b) => b.rounds - a.rounds);

  lines.push(`## ⑥ 未归类待审（共 ${unclassifiedRows.length} 组）`);
  lines.push('');
  lines.push('标签没命中任何池 → 已落**海马体**（3 天过期、永不注入）并打「未归类」标注。');
  lines.push(`**同一句重复 ≥${UNCLASSIFIED_ESCALATE} 次的升级为「需人工定池」**——反复出现说明它值得留，只是标签体系认不出。`);
  lines.push('');
  if (unclassifiedRows.length === 0) lines.push('（无）');
  for (const row of unclassifiedRows.slice(0, top)) {
    const escalated = row.rounds >= UNCLASSIFIED_ESCALATE;
    lines.push(`- ${escalated ? '⚠ **需人工定池**' : '待审'} · 出现在 ${row.rounds} 期夜巡 · \`${row.ids[0]}\``);
    lines.push(`  - ${String(row.key).slice(0, 70)}`);
    if (escalated) lines.push(`  - 定池：` + '\`chain_touch({ action: \'set-pool\', id: \'' + row.ids[0] + '\', pool: \'skill\' })\`');
  }
  lines.push('');

  return {
    markdown: lines.join('\n'),
    counts: {
      total: list.length,
      principles: principles.length,
      stale: stale.length,
      dupes: dupes.length,
      shared: sharedPairs.length,
      rebalance: plan.length,
      unclassified: unclassifiedRows.length,
    },
  };
}

/**
 * 计算这一轮该对哪些记忆调权重（**纯计算，不写盘**）。
 *
 * 只两条规则，都保守：
 *
 *   **规则 A —— 压重复**：两条判断高度相似时，把**较弱的那条**（权重低的）压 0.05。
 *     不合并、不改字 —— 只是让"谁是真的"由权重说话；强的那条保持原样。
 *
 *   **规则 B —— 被想起就翻身**：之前被压过（累计偏移为负），后来又被想起 ≥3 次，
 *     就把分还回来 0.05。这条是"别把好东西冤枉死"的保险。
 *
 * 刻意**没有**第三条"常被想起就加权"——`touchCount` 已经通过拉长半衰期奖励过它一次，
 * 再加权就是双重奖励，会把权重顶到 1.0 然后失去区分度。
 *
 * @param entries - `loadAll()` 的 entries。
 * @param options - `{ sim?, maxActions? }`
 * @returns `Array<{ id, delta, reason, judgement }>`
 */
export function buildRebalancePlan(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const sim = Number.isFinite(Number(options.sim)) ? Number(options.sim) : DUPLICATE_SIM;
  const maxActions = Math.max(1, Number(options.maxActions) || 10);

  const eligible = (entry) => {
    if (entry === null || typeof entry !== 'object') return false;
    if (entry.superseded) return false;
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    if (tags.some((tag) => typeof tag === 'string' && tag.includes('原则'))) return false;
    return true;
  };

  const plan = [];
  const claimed = new Set();

  // 规则 A：压重复里较弱的那条
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (!eligible(a) || !eligible(b)) continue;
      if (similarity(a.judgement, b.judgement) < sim) continue;
      // 谁弱压谁；权重相同则压**新的那条**（让更早建立的留下）
      const wa = Number(a.weight) || 0;
      const wb = Number(b.weight) || 0;
      const weaker = wa === wb
        ? (Date.parse(String(b.ts)) > Date.parse(String(a.ts)) ? b : a)
        : (wa < wb ? a : b);
      const key = String(weaker.id);
      if (claimed.has(key)) continue;
      const sum = Number(weaker.rebalanceSum) || 0;
      if (sum <= REBALANCE_FLOOR + 1e-9) continue; // 已经压到底，不再压
      claimed.add(key);
      plan.push({
        id: key,
        delta: -REBALANCE_STEP,
        reason: `与 ${String((weaker === a ? b : a).id)} 判断高度相似（较弱的一条降权，不合并）`,
        judgement: String(weaker.judgement ?? ''),
      });
    }
  }

  // 规则 B：被压过、但后来被想起多次 → 还分
  for (const entry of list) {
    if (!eligible(entry)) continue;
    const key = String(entry.id);
    if (claimed.has(key)) continue;
    const sum = Number(entry.rebalanceSum) || 0;
    const touched = Number(entry.touchCount) || 0;
    if (sum > -REBALANCE_STEP + 1e-9) continue;   // 没被压过
    if (sum >= REBALANCE_CEIL - 1e-9) continue;   // 已经还到底
    if (touched < RECOVER_TOUCH) continue;        // 还没被想起够
    claimed.add(key);
    plan.push({
      id: key,
      delta: +REBALANCE_STEP,
      reason: `被想起 ${touched} 次，把之前压下去的分还回来`,
      judgement: String(entry.judgement ?? ''),
    });
  }

  return plan.slice(0, maxActions);
}

/**
 * 执行归整：把计划写成 `rebalance` 事件。**只写事件，不改任何记录内容。**
 *
 * @param entries - `loadAll()` 的 entries。
 * @param options - 透传 `buildRebalancePlan`。
 * @returns `{ actions, written }`
 */
export function applyRebalance(entries, options = {}) {
  const actions = buildRebalancePlan(entries, options);
  let written = 0;
  for (const action of actions) {
    try {
      appendChainEvent({ id: action.id, type: 'rebalance', delta: action.delta, reason: action.reason });
      written += 1;
    } catch {
      /* 单条失败不影响其它 */
    }
  }
  return { actions, written };
}

/**
 * 本地日期串 YYYY-MM-DD。
 *
 * ⚠️ 2026-10-28 修：原来报告文件名用 `new Date().toISOString().slice(0,10)`，那是 **UTC 日期**；
 * 而「今天该不该跑夜巡」是按**本地 18:00** 判断的。两者混用会在本地 00:00–08:00 期间错成前一天，
 * 表现是「到点了却认为今天已经跑过」。日期口径必须统一成本地时间。
 */
export function localYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 某一天的报告文件绝对路径（dateStr 为本地日期 YYYY-MM-DD）。 */

/**
 * 这条「未归类」出现在几期夜巡报告里（**D：按轮次累计**）。
 *
 * 为什么要读历史文件而不是数记录：同一条判断通常只写一次，
 * 数记录的话永远是 1 —— "反复出现说明值得留"这个判据就永远不成立。
 * 而它每期都被夜巡重新列出来，才是真的"反复出现"。
 *
 * @param key - 判断文本的前 120 字（报告里就是这么打印的）。
 * @returns 出现过它的报告期数；读不到目录时返回 0。
 */
function countReportRounds(key) {
  const needle = String(key ?? '').slice(0, 40);
  if (needle === '') return 1;
  let rounds = 0;
  try {
    const dir = join(storeDir(), 'patrol');
    const files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name));
    for (const name of files) {
      try {
        const text = readFileSync(join(dir, name), 'utf8');
        if (text.includes(needle)) rounds += 1;
      } catch {
        /* 单份读不到就跳过，不影响其它 */
      }
    }
  } catch {
    return 0;   // 连目录都读不到 → 就是没出现过，别虚报 1 期
  }
  // **如实返回 0**（2026-10-29 修，另一台电脑的鱼查出来的）：
  // 原来是 Math.max(1, …) —— "今天还没写过任何报告"也会显示「出现在 1 期」，
  // 于是"累计 3 期"实际只差两轮。判据必须能区分"从没出现过"和"出现过一次"。
  return rounds;
}

export function patrolReportPath(dateStr) {
  return join(storeDir(), 'patrol', `${dateStr}.md`);
}

/**
 * 生成报告并落盘到 `patrol/<本地日期>.md`。
 *
 * @param entries - `loadAll()` 的 entries。
 * @param options - 透传给 `buildPatrolReport`。
 * @returns `{ path, counts, markdown }`
 */
export function writePatrolReport(entries, options = {}) {
  const { markdown, counts } = buildPatrolReport(entries, options);
  const dir = join(storeDir(), 'patrol');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = patrolReportPath(localYmd());
  writeFileSync(path, markdown, 'utf8');
  // **旁车文件**（2026-10-29）：覆盖检查要读"这份报告覆盖了多少条"，
  // 读 markdown 正则太脆（格式一改就静默返回 0，然后夜巡天天重跑）。
  // 这里写一份只有数字的 JSON，读它就没有解析风险。
  try {
    writeFileSync(
      path.replace(/\.md$/, '.meta.json'),
      JSON.stringify({
        version: 1,
        date: localYmd(),
        total: Number(counts?.total) || 0,
        generatedAt: new Date().toISOString(),
        counts,
      }, null, 2) + '\n',
      'utf8',
    );
  } catch {
    // 旁车写不出来不影响报告本身
  }
  return { path, counts, markdown };
}
