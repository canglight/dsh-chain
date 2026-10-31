/**
 * Web API：把记忆链整理成"可直接画"的图，供客户端 tab 渲染。
 *
 * 只读、只暴露本插件自己的数据。挂在 `/chain-shared` 前缀下，与 memory 插件的
 * `/memory-evolve` 互不干扰。
 *
 * 设计要点：
 *   1. **服务端算好视觉参数**（透明度、半径），前端只负责按数字画。
 *      这样"遗忘"和"权重"的定义只有一处，改参数不用动前端。
 *   2. **边分两类**：`evidence`（真实因果，谁砸出了谁）和 `time`（仅仅因为
 *      相邻）。前端可以只画 evidence，避免把并列的东西画成发展链。
 *   3. 一次返回全部节点。当前体量（几十条）不需要分页；真到几千条再加。
 *
 * @module dsh-chain-shared/api
 */

import { loadAll } from './store.js';
import { POOLS, poolDef, poolOf, classifySkill } from './pools.js';
// 三层（感知 / 决策 / 元记忆）的状态面板要用到它们（2026-10-30）。
import { readPerceiveLog } from './perceive.js';
import { edgeStats } from './edges.js';
import { metaFacts } from './meta.js';
// 上一轮联想到了谁（进程内，前端动画用）。
import { readPulse } from './pulse.js';
// 夜巡状态（只读）：让「跑没跑」在 UI 上可见（2026-10-30）。
import { readPatrolStatus } from './patrol-status.js';
import { visibleMood } from './mood.js';
import {
  DEFAULT_TARGET_SESSIONS,
  SETTINGS_DEFAULTS,
  WEIGHT_DECAY_GRACE_DAYS,
  WEIGHT_DECAY_HALF_LIFE_DAYS,
  applyConfig,
  getConfig,
  mergeSettings,
  settingsPath,
  writeSettingsFile,
} from './config.js';

/**
 * 视觉衰减的半衰期（天）。
 *
 * **必须等于 store.js 里算有效权重用的那个值**（`WEIGHT_DECAY_HALF_LIFE_DAYS`）：
 * 图上"变淡"和权重"变轻"如果不是同一条曲线，就会自相矛盾 ——
 * 用户会看到一颗点明明还亮着、但它已经不参与检索了，反之亦然。
 * 统一成一处参数，改一个就两边一起变。
 */
export const HALF_LIFE_DAYS = WEIGHT_DECAY_HALF_LIFE_DAYS;

/** 节点半径范围（像素）。 */
const R_MIN = 6;
const R_MAX = 18;

/**
 * 记忆的生命周期四态。
 *
 * 这是从"档案型"转向"代谢型"的核心：记忆不是「有 / 无」两种状态，
 * 而是一路退化的过程 —— 完整 → 摘要 → 只剩关键词 → 归档。
 *
 * 对照参考视频（短视频示例）的设定：
 *   「细节会淡，重要的反而沉得更深」+「200 天内再次提起会复苏」
 * 我们没照抄它的画面，而是把这条**语义**做成了可审计的状态机。
 */
export const LIFECYCLE = Object.freeze({
  ACTIVE: { key: 'active', label: '活跃', maxDays: 30, opacityFloor: 0.55 },
  SETTLING: { key: 'settling', label: '沉淀', maxDays: 120, opacityFloor: 0.32 },
  ECHO: { key: 'echo', label: '残响', maxDays: 200, opacityFloor: 0.14 },
  ARCHIVED: { key: 'archived', label: '归档', maxDays: Number.POSITIVE_INFINITY, opacityFloor: 0 },
});

/** 状态的展示顺序（越靠前越"记得清楚"）。 */
export const LIFECYCLE_ORDER = ['active', 'settling', 'echo', 'archived'];

/**
 * 判定一条记忆此刻处于哪个生命周期状态。
 *
 * **分档之后，存活期由所属池子决定**（见 pools.js）：
 *   核心 core   → 永远 active（不衰减、不归档）
 *   事实 fact   → 1095 天归档
 *   技能 skill  → 730 天归档
 *   日常 daily  → 90 天归档
 *
 * 四档视觉状态不再用固定天数，而是**按该池归档线的比例**切：
 *   ≤25% 活跃 · ≤60% 沉淀 · <100% 残响 · ≥100% 归档（不上图、不进注入）
 *
 * 这样换池参数时，画面自己跟着变，不用两处对着改。
 *
 * @param ageDays - 距上次活跃的天数。
 * @param pool - 所属池子 key（`core` / `fact` / `skill` / `daily`）。
 * @returns 状态 key：`active` / `settling` / `echo` / `archived`。
 */
export function lifecycleState(ageDays, pool) {
  const def = poolDef(pool);
  // 核心永不归档 —— 性格不该因为"几个月没被提起"就从我身上消失。
  if (!Number.isFinite(def.archiveDays)) return LIFECYCLE.ACTIVE.key;
  const days = Number.isFinite(Number(ageDays)) ? Number(ageDays) : 0;
  const span = def.archiveDays;
  const grace = Number.isFinite(def.graceDays) ? def.graceDays : 0;
  // "活跃"的上界取**宽限期与 25% 归档线的较大者**：
  // 宽限期没到就不该显示成"沉淀"（那时权重一动没动）；但光用宽限期又会让
  // 长寿命的池子过早失去"活跃"这个视觉信号，所以再兜一个 25%。
  const activeBound = Math.max(grace, span * 0.25);
  if (days <= activeBound) return LIFECYCLE.ACTIVE.key;
  if (days <= span * 0.6) return LIFECYCLE.SETTLING.key;
  if (days < span) return LIFECYCLE.ECHO.key;
  return LIFECYCLE.ARCHIVED.key;
}

/**
 * 把一段判断压成"只剩关键词"的样子。
 *
 * 残响态只保留最少的字：去掉序号圈（①②…）、去掉冒号后的解释、
 * 再去掉标点，剩下的前几个词就是这条记忆在快被忘掉时还挂着的东西。
 *
 * @param label - 原始判断文本。
 * @param maxChars - 最多保留几个字，默认 8。
 * @returns 关键词串。
 */
export function keywordsOf(label, maxChars = 8) {
  const text = String(label ?? '')
    .replace(/^[\s①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]+/, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .split(/[：:，,。；;、]/)[0]
    .replace(/\s+/g, '')
    .trim();
  return text.slice(0, Math.max(2, maxChars));
}

/**
 * 一个自造文本摘要：沉淀态用它，比完整 judgement 短、比关键词长。
 *
 * @param label - 原始判断。
 * @param maxChars - 上限，默认 22。
 * @returns 摘要串。
 */
export function digestOf(label, maxChars = 22) {
  const text = String(label ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * 写一个 JSON 响应。
 * @param res - `http.ServerResponse`。
 * @param status - HTTP 状态码。
 * @param body - 可序列化的值。
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * 判断一条记录是不是"原则"。
 * @param entry - 记录。
 * @returns 是否带 `原则` 标签。
 */
export function isPrinciple(entry) {
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  return tags.some((tag) => typeof tag === 'string' && tag.includes('原则'));
}

/**
 * 计算一条记录的年龄（天）。
 * @param ts - ISO 时间戳。
 * @param now - 当前毫秒时间。
 * @returns 天数；无法解析时返回 0。
 */
export function ageInDays(ts, now = Date.now()) {
  const parsed = Date.parse(String(ts ?? ''));
  if (!Number.isFinite(parsed)) return 0;
  const days = (now - parsed) / 86_400_000;
  return days < 0 ? 0 : days;
}

/**
 * 计算视觉透明度。
 *
 * `idle = max(0, 距上次活跃 - GRACE)`；`opacity = weight × 0.5^(idle / HALF_LIFE)`
 *
 * 三个因子含义不同、都要保留：
 *   · weight    —— 这条记忆**本身有多重**（写入权重 + 被想起的加成）
 *   · GRACE     —— **宽限期**：刚写的东西不该立刻开始淡，那看着像故障
 *   · 指数项    —— **时间让它淡了多少**
 * 另外**原则不衰减**：性格不该因为"几周没被提起"就变淡，那是这个插件存在的理由之一。
 *
 * @param weight - 0~1 的有效权重。
 * @param ageDays - 距上次活跃的天数。
 * @param isPrinciple - 是否原则类（不衰减）。
 * @returns 0~1 的透明度。
 */
export function computeOpacity(weight, ageDays, isPrinciple = false) {
  const w = Number.isFinite(Number(weight)) ? Math.max(0, Math.min(1, Number(weight))) : 0.5;
  if (isPrinciple) return Math.max(0.12, Math.min(1, w));
  const idle = Math.max(0, (Number.isFinite(Number(ageDays)) ? Number(ageDays) : 0) - WEIGHT_DECAY_GRACE_DAYS);
  const raw = w * Math.pow(0.5, idle / HALF_LIFE_DAYS);
  // 完全透明等于看不见，那和丢了没区别 —— 给一个下限让人还能找到它。
  return Math.max(0.12, Math.min(1, raw));
}

/**
 * 权重映射到半径。
 * @param weight - 0~1。
 * @returns 像素半径。
 */
export function computeRadius(weight) {
  const w = Number.isFinite(Number(weight)) ? Math.max(0, Math.min(1, Number(weight))) : 0.5;
  return R_MIN + (R_MAX - R_MIN) * w;
}

/**
 * 按权重的**自然间隔**把记录聚成若干"层"。
 *
 * 换掉原先的固定阈值（0.9 / 0.75 / 0.6）——那四个数是拍脑袋定的，
 * 而且写死之后：加第五条第 0.95 权重的记录，它和已有的挤在同一圈把圈撑破；
 * 权重分布变成 9 档时又看不出分层。**层数应该由数据说了算。**
 *
 * 做法：按权重降序扫一遍，相邻两条的差超过 `minGap` 就切一层。
 * 所以：
 *   · 权重扎堆（0.95 0.95 0.9）→ 一层
 *   · 有断层（0.9 → 0.6）→ 切两层
 *   · 新写一条 0.97：离得够远就自成一圈，挨得近就并进最近那圈
 *
 * @param entries - 记录数组。
 * @param options - 选项。
 * @param options.minGap - 切层所需的最小权重差，默认 **0.04**。
 *   ⚠️ 第一版写的是 0.08，结果 0.95 / 0.9 / 0.85 / 0.8 全被并成一层（因为她的
 *   权重步长就是 0.05），图上看不出任何层次。**这个值必须小于常用步长。**
 * @param options.maxTiers - 最多几层，默认 8。
 * @returns 二维数组：`tiers[0]` 是最内圈（权重最高）。
 *
 * ⚠️ **gap 法只在数据稀疏时成立。** 实测：95 条记录（权重 0.61~0.95 密集分布，
 * 相邻差全都在 0.01 左右）用 gap 法切出来只有 **1 层** —— 所有点挤在一个圈上，
 * 星环直接塌成一个大圆。所以**超过 20 条就改用分位数**，让层数跟着数据量走：
 * 95 条 → √95 ≈ 10 → 取 8 层，每层 12 条左右。
 * 数据少时仍用 gap（那时"断层"是有意义的语义信息，不能被平均掉）。
 */
export function clusterByWeight(entries, options = {}) {
  const wOf = (entry) => (Number.isFinite(Number(entry?.weight)) ? Number(entry.weight) : 0.5);
  const minGap = Number.isFinite(Number(options.minGap)) ? Number(options.minGap) : 0.04;
  const maxTiers = Number.isFinite(Number(options.maxTiers))
    ? Math.max(1, Number(options.maxTiers))
    : 8;

  const list = Array.isArray(entries) ? [...entries] : [];
  if (list.length === 0) return [];
  list.sort((a, b) => wOf(b) - wOf(a));

  // 数据多 → 分位数（层数 ≈ √N，夹在 2~maxTiers 之间）
  if (list.length > 20) {
    const target = Math.max(2, Math.min(maxTiers, Math.round(Math.sqrt(list.length))));
    const per = Math.ceil(list.length / target);
    const even = [];
    for (let i = 0; i < list.length; i += per) even.push(list.slice(i, i + per));
    return even;
  }

  const tiers = [[list[0]]];
  for (let i = 1; i < list.length; i += 1) {
    const gap = wOf(list[i - 1]) - wOf(list[i]);
    if (gap > minGap) tiers.push([]);
    tiers[tiers.length - 1].push(list[i]);
  }

  // 碎成太多层 → 按数量均分，别让画面退化成散点。
  if (tiers.length > maxTiers) {
    const per = Math.ceil(list.length / maxTiers);
    const even = [];
    for (let i = 0; i < list.length; i += per) even.push(list.slice(i, i + per));
    return even;
  }
  return tiers;
}

/**
 * 把一段中文/英文混排文本切成 **2-gram 集合**，用来算相似度。
 *
 * 为什么是 2-gram 而不是分词：这里没有词典，中文也没空格可切。
 * 双字切片对中文够用（"先查证" → 先查/查证）；英文会退化成字母对，
 * 但英文只占少数，而且这批记忆的措辞重复度很高，够分辨。
 *
 * @param text - 原始文本。
 * @returns 2-gram 集合。
 */
export function bigrams(text) {
  const clean = String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

/**
 * 重叠系数（Overlap Coefficient）：`|A∩B| / min(|A|,|B|)`。
 *
 * 不用 Jaccard：它对"一条长一条短"惩罚过重，而这批记忆里短的
 * "校园跑不做外挂"和长的"记忆要分层…"本来就该按共同话题连、
 * 不该因为字数差被判定无关。
 *
 * @param a - 集合 A。
 * @param b - 集合 B。
 * @returns 0~1 的相似度。
 */
export function overlapScore(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const gram of a) if (b.has(gram)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

/**
 * 计算"相关性"连线 —— 这是用户要的「系统自动按相关性相互连线」。
 *
 * 之前只有依据边（谁写了谁）和时间边（谁挨着谁），都不是"这两条在讲同一件事"。
 *
 * **选边策略（实测调出来的）：全局按相似度降序贪心分配，每个节点最多 `maxPerNode` 条。**
 * 早期版本用"双向都进 top"做约束，结果一条都连不出来 —— 14 条记忆主题各异，
 * 两两相似度最高才 0.214，双向 top 的交集几乎必然为空。改成单向贪心后
 * 既能连上、又不会让任一节点变成蜂窝。
 *
 * 阈值 0.05 是**按实测分布定的**，不是拍的：把 91 对全排出来人工过一遍，
 * 0.06 以上基本都语义正确（"不装 context-mode ←→ 插件架构" 0.214、
 * "①先查证 ←→ ③犯错先认" 0.067），0.054 以下开始混进噪声
 * （"⑧清理现场 ←→ ⑩不硬凑" 0.054 明显无关）。所以门槛卡在噪声起点下方一档。
 *
 * ⚠️ **数据量是这套算法的根本限制**：14 条、主题分散时，能连的本来就没几条。
 * 断言"相关性很强"是假的；它现在只能说"这两条在用词上确实有重叠"。
 *
 * @param nodes - 主节点（不含依据点）。
 * @param options - 选项。
 * @param options.threshold - 相似度下限，默认 0.05。
 * @param options.maxPerNode - 每个节点最多几条，默认 2。
 * @returns 形如 `{ source, target, kind: 'related', weight }` 的边数组。
 */
export function buildRelatedLinks(nodes, options = {}) {
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.05;
  const maxPerNode = Number.isFinite(Number(options.maxPerNode)) ? Number(options.maxPerNode) : 2;

  const mains = (Array.isArray(nodes) ? nodes : []).filter((n) => n.kind !== 'evidence');
  if (mains.length < 2) return [];

  const grams = new Map();
  for (const n of mains) grams.set(n.id, bigrams(`${n.label} ${n.conclusion}`));

  const candidates = [];
  for (let i = 0; i < mains.length; i += 1) {
    for (let j = i + 1; j < mains.length; j += 1) {
      const score = overlapScore(grams.get(mains[i].id), grams.get(mains[j].id));
      if (score >= threshold) {
        candidates.push({ a: mains[i].id, b: mains[j].id, score });
      }
    }
  }
  candidates.sort((x, y) => y.score - x.score);

  const degree = new Map();
  const links = [];
  for (const c of candidates) {
    const da = degree.get(c.a) || 0;
    const db = degree.get(c.b) || 0;
    if (da >= maxPerNode || db >= maxPerNode) continue;
    degree.set(c.a, da + 1);
    degree.set(c.b, db + 1);
    links.push({
      source: c.a,
      target: c.b,
      kind: 'related',
      weight: Math.round(c.score * 1000) / 1000,
    });
  }
  return links;
}

/**
 * 把全部记录构造成图。
 *
 * @param options - 选项。
 * @param options.includeTimeLinks - 是否输出时间顺序边（默认 false：那只是相邻，不是因果）。
 * @param options.now - 当前毫秒时间（测试可注入）。
 * @returns `{ nodes, links, stats, halfLifeDays }`。
 */
export function buildGraph(options = {}) {
  const { entries } = loadAll();
  // simulateDays：把"现在"往后推 N 天，用来预览生命周期四态。
  // 没有它的话，所有记录都刚写进来（age ≈ 0），状态机永远只显示 active，等于看不见。
  const simulatedDays = Number.isFinite(Number(options.simulateDays)) ? Number(options.simulateDays) : 0;
  const base = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const now = base + simulatedDays * 86_400_000;
  const includeTimeLinks = options.includeTimeLinks === true;

  // **已被取代的条目不上图。**
  // 取代的语义是"我不再这么想"，它在注入里已经被排除（format.js 同理），
  // 图上也不该还挂着一颗占位的星 —— 2026-10-28 实测：海马体显示 6 颗，
  // 实际只有 2 条是活的，另外 4 颗是被清掉的垃圾片段，看着像记性很好。
  // 数据仍在 JSONL 里可审计，只是不进可视化。
  const living = entries.filter((entry) => entry.superseded !== true);

  const sorted = [...living].sort((a, b) => {
    const ta = Date.parse(String(a.ts ?? ''));
    const tb = Date.parse(String(b.ts ?? ''));
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return 0;
  });

  // 先按权重分层，拿到 id → tier 的映射；层数由数据决定，不写死。
  const tiers = clusterByWeight(sorted, {
    minGap: Number.isFinite(Number(options.minGap)) ? Number(options.minGap) : 0.04,
    maxTiers: Number.isFinite(Number(options.maxTiers)) ? Number(options.maxTiers) : 8,
  });
  const tierOf = new Map();
  tiers.forEach((members, index) => {
    for (const entry of members) tierOf.set(String(entry.id), index);
  });

  const mapped = sorted.map((entry) => {
    const weight = Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 0.5;
    const principle = isPrinciple(entry);
    // 分档：节点带上所属池子，前端可以按池上色/分半径带。
    // **技能要现场再分一次**（2026-10-30）：entry.pool 里存的是老的 'skill'，
  // 直接透传会让星图少一颗星、铁律和经验挤在一起。铁律/经验是按文本派生的，不迁移数据。
  let pool = entry.pool && POOLS[entry.pool] ? entry.pool : poolOf(entry);
  if (pool === 'skill') pool = classifySkill(entry);
    // 衰减起点 = 上次被想起的时间（没有就用创建时间）。
    // 前端拿到这个时间戳就能自己重算透明度，不必反复请求图数据。
    const decayFromTs = String(entry.lastTouched || entry.ts || '');
    const age = ageInDays(decayFromTs, now);
    const state = lifecycleState(age, pool);
    const judgement = String(entry.judgement ?? '(无标题)');
    return {
      id: String(entry.id),
      label: judgement,
      kind: principle ? 'principle' : 'decision',
      pool,
      poolLabel: poolDef(pool).label,
      weight,
      // **被想起次数**（2026-10-30）：元记忆小节点靠它排序 ——
      // 只读 `recallCount`（由 recall 事件累出来的真实计数），不掺 estimate。
      recalled: Number(entry.recallCount) || 0,
      rawWeight: Number.isFinite(Number(entry.rawWeight)) ? Number(entry.rawWeight) : weight,
      touchCount: Number(entry.touchCount) || 0,
      lastTouched: entry.lastTouched || null,
      superseded: entry.superseded === true,
      ts: String(entry.ts ?? ''),
      decayFromTs,
      ageDays: Math.round(age * 100) / 100,
      // 生命周期四态：决定这条记忆**还能被看到多少**，而不只是多透明。
      state,
      // 随状态逐段缩水的展示文本：完整 → 摘要 → 关键词。
      digest: digestOf(judgement),
      keywords: keywordsOf(judgement),
      opacity: Math.round(computeOpacity(weight, age, principle) * 1000) / 1000,
      radius: Math.round(computeRadius(weight) * 10) / 10,
      tier: tierOf.get(String(entry.id)) ?? 0,
      evidence: Array.isArray(entry.evidence) ? entry.evidence.map(String) : [],
      hesitation: Array.isArray(entry.hesitation) ? entry.hesitation.map(String) : [],
      conclusion: String(entry.conclusion ?? ''),
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    };
  });

  // 归档态**不上图**：它已经不参与检索、也不进注入，画出来只会让人以为它还在。
  // 原始数据仍完整留在 chains.jsonl 里（可审计、可人工翻），只是图上不再出现。
  const nodes = mapped.filter((n) => n.state !== LIFECYCLE.ARCHIVED.key);

  // 依据边：每个证据项单独成一个轻薄节点，挂到它支撑的那条判断上。
  // 这样点开一条判断时，"为什么会有这条记忆"是图上真实存在的邻居。
  const links = [];
  for (const node of nodes) {
    node.evidence.forEach((text, index) => {
      const evidenceId = `${node.id}#e${index}`;
      nodes.push({
        id: evidenceId,
        label: text,
        kind: 'evidence',
        weight: 0,
        ts: node.ts,
        ageDays: node.ageDays,
        opacity: Math.max(0.35, node.opacity),
        radius: 3.5,
        evidence: [],
        hesitation: [],
        conclusion: '',
        tags: [],
        parent: node.id,
      });
      links.push({ source: node.id, target: evidenceId, kind: 'evidence' });
    });
  }

  // **元记忆摘要小节点**（2026-10-30 她定）：把"什么事被想起几次"做成图上真实的小点，
  // 挂到元记忆区（pool='meta'，橙色）。**只统计、不新增记忆** —— 它是观察视角，不是内容。
  // 判据只用能核对的事实：被想起次数 >= 1 的，按次数取前 8 条。
  const metaSummaryNodes = [];
  try {
    const recalled = [];
    for (const node of nodes) {
      if (!node || node.kind === 'evidence') continue;
      const n = Number(node.recalled) || 0;
      if (n <= 0) continue;
      recalled.push({ node, n });
    }
    recalled.sort((a, b) => b.n - a.n);
    for (const item of recalled.slice(0, 8)) {
      const id = 'meta:' + String(item.node.id);
      nodes.push({
        id,
        label: '被想起 ' + item.n + ' 次',
        kind: 'meta',
        pool: 'meta',
        // **用来源节点的真实值**（2026-10-30 修的 bug）：原来是写死的 0.5 / 0，
        // 面板照着显示就成了「权重 0.50 · 0 天」，而真库是 0.55 / 1 天。
        weight: Number(item.node.weight) || 0.5,
        ts: item.node.ts,
        ageDays: Number(item.node.ageDays) || 0,
        opacity: 0.9,
        radius: 4,
        evidence: [],
        hesitation: [],
        conclusion: String(item.node.label || '').slice(0, 40),
        tags: [],
        parent: String(item.node.id),
        recalled: item.n,
      });
      links.push({ source: item.node.id, target: id, kind: 'meta' });
      metaSummaryNodes.push(id);
    }
  } catch {
    /* 统计失败就不画 —— 宁可少一层，不可编数 */
  }

  // **海马体内部链**（2026-10-30）：原料是按时序进来的，彼此有先后关系。
  // 这只画**同一个池内部**的相邻两条 —— 不是"联想"，所以不受"显示连线"开关控制。
  try {
    const hippo = nodes
      .filter((x) => x && x.pool === 'hippocampus' && x.kind !== 'evidence')
      .sort((x, y) => String(x.id) < String(y.id) ? -1 : 1);
    for (let hi = 1; hi < hippo.length; hi += 1) {
      links.push({ source: hippo[hi - 1].id, target: hippo[hi].id, kind: 'chain' });
    }
  } catch {
    /* 连不上就只画点 */
  }

  if (includeTimeLinks) {
    for (let i = 1; i < sorted.length; i += 1) {
      links.push({ source: String(sorted[i - 1].id), target: String(sorted[i].id), kind: 'time' });
    }
  }

  // 相关性边：系统自己算"这两条在讲同一件事"。**默认开**（用户明确要的），
  // 因为它是这三类边里唯一带语义的；依据边只回答"谁引用了谁"。
  const relatedThreshold = Number.isFinite(Number(options.relatedThreshold))
    ? Number(options.relatedThreshold)
    : 0.05;
  if (options.includeRelatedLinks !== false) {
    const mainsOnly = nodes.filter((n) => n.kind !== 'evidence');
    links.push(...buildRelatedLinks(mainsOnly, {
      threshold: relatedThreshold,
      maxPerNode: Number.isFinite(Number(options.relatedPerNode)) ? Number(options.relatedPerNode) : 3,
    }));
  }

  // 生命周期的分布：她能一眼看出"现在有多少条正在淡出"。
  const stateCount = { active: 0, settling: 0, echo: 0, archived: 0 };
  for (const n of mapped) {
    if (n.kind === 'evidence') continue;
    stateCount[n.state] = (stateCount[n.state] || 0) + 1;
  }

  return {
    nodes,
    links,
    stats: {
      total: sorted.length,
      principles: sorted.filter((entry) => isPrinciple(entry)).length,
      decisions: sorted.filter((entry) => !isPrinciple(entry)).length,
      evidences: links.filter((link) => link.kind === 'evidence').length,
      related: links.filter((link) => link.kind === 'related').length,
      states: stateCount,
      // 已归档的不上图，但告诉前端"还有多少条在档案里"，避免它以为数据丢了。
      archivedHidden: stateCount.archived,
    },
    // 分层结果一并下发：前端按 tierCount 均分半径，所以层数变化时
    // 不需要改前端代码，画面自己会重新摊开。
    tiers: tiers.map((members, index) => ({
      index,
      count: members.length,
      minWeight: Math.min(...members.map((entry) => Number(entry.weight))),
      maxWeight: Math.max(...members.map((entry) => Number(entry.weight))),
    })),
    tierCount: tiers.length,
    halfLifeDays: HALF_LIFE_DAYS,
    // 前端本地重算透明度要用到它；和 host 用同一份常量，避免两边漂移。
    graceDays: WEIGHT_DECAY_GRACE_DAYS,
    // 生命周期门限一并下发，前端按 "完整 → 摘要 → 关键词" 逐段缩水时用。
    lifecycle: {
      activeMaxDays: LIFECYCLE.ACTIVE.maxDays,
      settlingMaxDays: LIFECYCLE.SETTLING.maxDays,
      echoMaxDays: LIFECYCLE.ECHO.maxDays,
    },
    // **当前情绪**：它不在 entries 里（存 mood.json，唯一性的一块牌），
    // 但星系里要有一颗粉色的星代表它，所以单独下发。
    // 强度低于阈值时就是 null —— 那意味着"这个情绪已经过去了"，前端不该画。
    mood: (() => {
      const m = visibleMood(now);
      if (!m) return null;
      return {
        mood: m.mood,
        why: m.why,
        strength: Math.round(m.strength * 1000) / 1000,
        ageHours: Math.round(m.ageHours * 10) / 10,
      };
    })(),
    // 各池的参数也下发：前端画"大分支"时要按池上色、按池定寿命感。
    pools: Object.fromEntries(Object.entries(POOLS).map(([key, def]) => [key, {
      key,
      label: def.label,
      desc: def.desc,
      archiveDays: Number.isFinite(def.archiveDays) ? def.archiveDays : null,
    }])),
    // 调试用：请求带了 simulateDays 时，把"现在"往后推，让四态立刻可见
    // （否则所有记录都刚写进来、全是 active，状态机等于看不见）。
    simulatedDays: Number.isFinite(Number(options.simulateDays)) ? Number(options.simulateDays) : 0,
    // **目标会话 id 的唯一真相源**：客户端原来自己硬编码了一份，和 config.js
    // 的 DEFAULT_TARGET_SESSIONS 是两份重复 —— 改注入目标却漏改一份，就会
    // 「注入给了 A、界面给了 B」，而且不报错、只是悄悄不一致。
    // 现在由这里下发，前端只负责比较（见 client.js 的 isMySession / gateActive）。
    //
    // ⚠️ 这是**客户端侧的门**，不是安全边界：图数据仍然会发给任何会话的浏览器，
    // 只是别的会话不渲染。真要做物理隔断，得在 API 层按会话拒绝 —— 而本路由
    // 拿不到调用方是谁（浏览器直接 GET，没有会话身份）。
    targetSession: typeof DEFAULT_TARGET_SESSIONS[0] === 'string' ? DEFAULT_TARGET_SESSIONS[0] : '',
  };
}

/**
 * 构造 `/chain-shared` 前缀的请求处理器。
 *
 * @returns `(req, res) => Promise<void>`。
 */
/**
 * 三层状态（感知 / 决策 / 元记忆）：给画布右上角那个「三层」面板用。
 *
 * **只报能核对的事实**，不给综合分 —— 元记忆那条教训（假数包装成判断比没有更糟）。
 *
 * @returns {{perception: object, decision: object, meta: object}}
 */
export function buildLayers(options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.latest) || 5));

  // ── 感知层：最近看到的几句话 ──
  let rows = [];
  try {
    rows = readPerceiveLog(500);
  } catch {
    rows = [];
  }
  const byKind = {};
  let moodSum = 0;
  let moodN = 0;
  for (const r of rows) {
    const k = String(r.kind || '?');
    byKind[k] = (byKind[k] || 0) + 1;
    const m = Number(r.mood) || 0;
    if (m !== 0) { moodSum += m; moodN += 1; }
  }
  const perception = {
    total: rows.length,
    byKind,
    avgMood: moodN === 0 ? 0 : Number((moodSum / moodN).toFixed(2)),
    latest: rows.slice(0, limit).map((r) => ({
      ts: r.ts,
      kind: r.kind,
      mood: Number(r.mood) || 0,
      importance: Number(r.importance) || 0,
      text: String(r.text || '').slice(0, 60),
    })),
  };

  // ── 决策层：联想网络的形状 ──
  let st = { total: 0, alive: 0, nodes: 0, maxDegree: 0, avgDegree: 0 };
  try {
    st = edgeStats();
  } catch {
    /* 边读不到就报 0，不编数 */
  }
  const decision = {
    edges: st.alive,
    edgeRecords: st.total,
    nodes: st.nodes,
    maxDegree: st.maxDegree,
    avgDegree: st.avgDegree,
  };

  // ── 元记忆：只给能核对的事实 ──
  let entries = [];
  try {
    entries = loadAll().entries.filter((e) => e && e.superseded !== true);
  } catch {
    entries = [];
  }
  let recalledSum = 0;
  let neverRecalled = 0;
  let verified = 0;
  const byState = {};
  const byPool = {};
  for (const e of entries) {
    let f;
    try {
      f = metaFacts(e);
    } catch {
      continue;
    }
    recalledSum += f.recalled;
    if (f.recalled === 0) neverRecalled += 1;
    if (f.verified > 0) verified += 1;
    byState[f.state] = (byState[f.state] || 0) + 1;
    const p = e.pool && POOLS[e.pool] ? e.pool : poolOf(e);
    byPool[p] = (byPool[p] || 0) + 1;
  }
  const meta = {
    total: entries.length,
    recalledSum,
    neverRecalled,
    verified,
    byState,
    byPool,
  };

  return { perception, decision, meta };
}

export function createHandler() {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (req.method === 'GET' && (path === '/chain-shared/api/graph' || path === '/chain-shared/api/graph/')) {
        const includeTime = url.searchParams.get('time') === '1';
        // simulateDays=N：把"现在"往后推 N 天，用来预览四态（不改任何数据）。
        const simRaw = Number(url.searchParams.get('simulateDays'));
        sendJson(res, 200, buildGraph({
          includeTimeLinks: includeTime,
          simulateDays: Number.isFinite(simRaw) ? Math.max(0, Math.min(3650, simRaw)) : 0,
        }));
        return;
      }

      // **联想脉冲**（2026-10-30）：前端靠 seq 判断是不是新的一轮。
      if (req.method === 'GET' && (path === '/chain-shared/api/pulse' || path === '/chain-shared/api/pulse/')) {
        sendJson(res, 200, readPulse());
        return;
      }

      // **夜巡状态**（2026-10-30）：最近一次夜巡什么时候跑的、怎么触发的、覆盖多少条。
      // 只读。之前它只写报告文件，界面上完全看不见 —— 跑了和没跑一样。
      if (req.method === 'GET' && (path === '/chain-shared/api/patrol' || path === '/chain-shared/api/patrol/')) {
        sendJson(res, 200, readPatrolStatus());
        return;
      }

      // **三层状态**（2026-10-30）：感知 / 决策 / 元记忆各一块，给画布上的面板用。
      if (req.method === 'GET' && (path === '/chain-shared/api/layers' || path === '/chain-shared/api/layers/')) {
        sendJson(res, 200, buildLayers());
        return;
      }

      if (req.method === 'GET' && (path === '/chain-shared/api/ping' || path === '/chain-shared/api/ping/')) {
        sendJson(res, 200, { ok: true, version: 1 });
        return;
      }

      // **设置**：画布右上角那个齿轮读写的就是这里（2026-10-29 加）。
      //
      // 为什么自己开一个接口，而不是用 DSH 的设置页：
      // 那套要走 `plugins.item` 槽位 + `configForms`，接了两轮才通；
      // 而用户要的是"配置就在自己画布里"。自己开接口的好处是**写进去当场生效** ——
      // 处理器和插件在同一个进程里，直接改运行时配置即可，不必重启。
      if (path === '/chain-shared/api/settings' || path === '/chain-shared/api/settings/') {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            settings: getConfig(),
            file: settingsPath(),
            defaults: SETTINGS_DEFAULTS,
          });
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 64 * 1024) throw new Error('payload too large');
          }
          let parsed = {};
          try { parsed = body === '' ? {} : JSON.parse(body); } catch { throw new Error('invalid JSON'); }
          const merged = mergeSettings(getConfig(), parsed?.settings ?? parsed);
          writeSettingsFile(merged);
          // **当场生效**：同一个进程，直接换掉运行时配置。
          applyConfig(merged);
          sendJson(res, 200, { ok: true, settings: getConfig() });
          return;
        }
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 500, { error: error?.message ?? String(error) });
    }
  };
}
