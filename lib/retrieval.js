/**
 * 索引检索：jieba 分词 + **通用 IDF** + 记忆自身权重。
 *
 * ## 为什么需要这个
 *
 * 原来靠"滑窗切 2–10 字子串 + 全文 includes"匹配，实测两个硬伤：
 *   ① 长句切出上百个二字词，「记得」「优先」「今天」都能命中；
 *   ② 按时间取最新 3 条 —— 结果恒等于"最近写的东西"，不是"相关的"。
 *
 * ## 方法来源（MIT，已按要求注明）
 *
 * 思路蒸馏自 `dsh-living-memory`（作者 暖暖 / NuanNuan，MIT，Copyright (c) 2026 nuannuan）：
 * 它的做法是 jieba 分词 + 停用词 + 停用词外的实词 + BM25/FTS5。我们只借**算法**，
 * 不借它的名字、人格、内部治理词汇或任何提示词层（那些它明确保留，不在 MIT 授权内）。
 *
 * 差异：它用 SQLite FTS5 的 BM25；我们只有 99 条文档，直接在内存里算就够了，不引 SQLite。
 *
 * ## 核心判据（实测出来的）
 *
 * `@node-rs/jieba` 自带 idf.txt（27 万条，通用语料的逆文档频率）。实测这条线非常干净：
 *
 *   通用虚词  今天 4.99 / 为什么 5.29 / 严重 5.33 / 看看 5.41 / 最近 5.77 / 是不是 5.85
 *   技术名词  函数 7.08 / 记忆 7.46 / 人格 8.28
 *   领域词    变现 9.12 / 玲珑 9.37 / 空转 10.77 / 报错 12.51
 *   我们的专名 项目甲、项目乙 **不在表里** → 按中位数 11.95 算
 *
 * 于是「取命中词里最高的 IDF，再乘记忆权重」就能把噪声压下去：
 * **阈值 9 时，7 个问法全部判对（0 误报）**。
 *
 * @module dsh-chain-shared/retrieval
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** IDF 中位数：不在词典里的词（我们的专名）按这个算，等于"非常罕见"。 */
const FALLBACK_IDF = 11.95;

/** 判"相关"的最低分。低于它宁可不注入 —— 噪声比没有更糟。 */
export const HIT_THRESHOLD = 9;

/** 最多想起几条。 */
export const HIT_MAX = 3;

/** 模块状态：加载成功才有值；拿不到 jieba 就永远 null，调用方降级。 */
let state = null;
/** 加载失败的原文，供日志与排查（只记一次）。 */
let loadError = '';

/**
 * 异步初始化：加载 jieba（原生模块，约 1.2 MB，无需编译器）+ 通用 IDF 表。
 *
 * **失败不抛错**：拿不到就保持未就绪，检索层自动回退到旧的滑窗匹配。
 * 这条是有代价换来的 —— 插件绝不能因为一个可选依赖没装好就整个挂掉。
 *
 * @param pluginRoot - 插件根目录（用来定位 node_modules 与 idf.txt）。
 * @returns 是否就绪。
 */
export async function initRetrieval(pluginRoot) {
  if (state !== null) return true;
  try {
    const require = createRequire(join(pluginRoot, 'lib', 'retrieval.js'));
    const modUrl = require.resolve('@node-rs/jieba');
    const dictUrl = require.resolve('@node-rs/jieba/dict.js');
    const idfPath = join(require.resolve('@node-rs/jieba'), '..', 'idf.txt');

    const mod = await import(`file:///${modUrl.replace(/\\/g, '/')}`);
    const dict = await import(`file:///${dictUrl.replace(/\\/g, '/')}`);
    const { Jieba } = mod;
    if (typeof Jieba?.withDict !== 'function') throw new Error('Jieba.withDict 不存在');

    const jieba = Jieba.withDict(dict.dict);
    const idfMap = new Map();
    for (const line of readFileSync(idfPath, 'utf8').split('\n')) {
      const i = line.lastIndexOf(' ');
      if (i > 0) {
        const v = Number(line.slice(i + 1));
        if (Number.isFinite(v)) idfMap.set(line.slice(0, i), v);
      }
    }
    if (idfMap.size === 0) throw new Error('idf.txt 读出来是空的');

    // 自定义词：每轮从库里挖到的专名（见 mineCustomWords），先留空。
    state = { jieba, idfMap, custom: new Set() };
    return true;
  } catch (error) {
    loadError = error?.message ?? String(error);
    return false;
  }
}

/** 检索层是否可用（不可用就走旧逻辑）。 */
export function retrievalReady() {
  return state !== null;
}

/** 上一次初始化失败的原因（就绪后为空串）。 */
export function retrievalError() {
  return state === null ? loadError : '';
}

/**
 * 把一个词换成通用 IDF（不在表里 = 我们的专名 = 按中位数算）。
 * @param word - 词。
 * @returns IDF 值。
 */
function idfOf(word) {
  if (state === null) return FALLBACK_IDF;
  const v = state.idfMap.get(word);
  return v === undefined ? FALLBACK_IDF : v;
}

/**
 * 分词并过滤：只留 ≥2 字、非纯数字、含中文的词。
 * @param text - 任意文本。
 * @returns 去重后的词数组。
 */
export function queryTokens(text) {
  if (state === null) return [];
  const raw = state.jieba.cut(String(text ?? ''), true);
  const out = [];
  const seen = new Set();
  for (const token of raw) {
    const w = String(token).trim();
    if (w.length < 2) continue;
    if (/^\d+$/.test(w)) continue;
    if (!/[\u4e00-\u9fa5]/.test(w)) continue;
    if (state.custom.has(w)) { /* 自定义词照样参与，只是不特殊对待 */ }
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  // **中文子串兜底**（2026-10-30 实测抓到的 bug）：
  // jieba 会把「机器味重」切成「机器 / 味重」，于是查询「机器味」在原词匹配上 0 条命中。
  // 这不是同义词问题，是**切词把词切没了**。把查询里的中文连续段再补 2–4 字滑窗（长的优先、去重、封顶）。
  const runs = String(text ?? '').match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of runs) {
    for (let wlen = 4; wlen >= 2; wlen -= 1) {
      for (let i = 0; i + wlen <= run.length; i += 1) {
        const sub = run.slice(i, i + wlen);
        if (seen.has(sub)) continue;
        seen.add(sub);
        out.push(sub);
        if (out.length >= 48) return out;
      }
    }
  }
  return out;
}

/**
 * 一条记忆的可检索正文（原样拼接，**再分词**）。
 *
 * ⚠️ 只把分词结果当索引用会漏词：实测「选有暖气的项目甲而不是更好看的项目丙」里，
 * jieba 把「项目甲」切成了单字（它不在通用词典里，HMM 按上下文猜），
 * 于是查询里的「项目甲」对不上这条记忆 —— 而它正是我们要找的那条。
 *
 * 所以命中判定用**原文子串**，分词只用来给**查询**选词。这样自造专名不必进词典也认得。
 *
 * @param entry - 记忆记录。
 * @returns 可检索正文。
 */
export function searchableTextOf(entry) {
  const parts = [
    entry.judgement,
    entry.conclusion,
    ...(Array.isArray(entry.evidence) ? entry.evidence : []),
    ...(Array.isArray(entry.hesitation) ? entry.hesitation : []),
  ];
  return parts.filter((x) => typeof x === 'string').join(' ');
}

/**
 * 给一条记忆算"和这句话的相关分"。
 *
 * 分数 = **命中词里最高的通用 IDF**（不乘记忆权重）。
 *
 * 为什么取最高而不是求和：求和会让长句靠一堆虚词累出高分（实测「记得人格…」那种长句
 * 求和能到 22 分，比真命中还高）；取最高等于"只要有一个真正罕见的词对上了就算相关"。
 *
 * 为什么不乘权重：**试过了，反而更差**。乘 (0.5+0.5×weight) 之后「组件甲」从 9.4
 * 掉到 8.5，被阈值挡掉 —— 而它本来是真命中。相关性该是纯词面的；
 * "被取代的不该出现"用 `superseded` 直接排除，不用权重打折。
 *
 * @param entry - 记忆记录。
 * @param tokens - 已分好的查询词。
 * @param entryText - 预先取好的可检索正文（可选，批量时复用）。
 * @returns `{ score, bestWord, matched }`
 */
/**
 * 把查询里的时间词翻成一个时间窗（2026-10-30 加的）。
 *
 * 为什么必须单独做：实测「昨天我们改了什么」5 条里只有 1 条相关、「刚才那个决定」0 条 ——
 * 因为「昨天」「刚才」被当成普通关键词去匹配正文，而正文里当然没有这两个字。
 * 用户说时间词时，她要的是**按时间筛**，不是按时间两个字匹配。
 *
 * @param text - 用户原话。
 * @param now - 当前时间（便于测试注入）。
 * @returns `{ from, to, label }` 或 null。
 */
export function parseTimeHint(text, now = Date.now()) {
  const s2 = String(text ?? '');
  const dayStart = (offsetDays) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    return d.getTime();
  };
  if (/前天/.test(s2)) return { from: dayStart(-2), to: dayStart(-1), label: '前天' };
  if (/昨天|昨日/.test(s2)) return { from: dayStart(-1), to: dayStart(0), label: '昨天' };
  if (/今天|今日/.test(s2)) return { from: dayStart(0), to: now + 1, label: '今天' };
  if (/刚才|刚刚|这会儿/.test(s2)) return { from: now - 2 * 3600 * 1000, to: now + 1, label: '刚才' };
  const m = s2.match(/最近\s*(\d+)\s*天/);
  if (m) return { from: now - Number(m[1]) * 86400000, to: now + 1, label: '最近' + m[1] + '天' };
  if (/这周|本周|这几天/.test(s2)) return { from: dayStart(-6), to: now + 1, label: '这几天' };
  return null;
}

export function scoreEntry(entry, tokens, entryText) {
  if (state === null || tokens.length === 0) return { score: 0, bestWord: '', matched: 0 };
  const text = entryText ?? searchableTextOf(entry);
  let best = 0;
  let bestWord = '';
  let matched = 0;
  for (const w of tokens) {
    // 子串匹配而不是分词集合匹配 —— 见 searchableTextOf 的说明。
    if (!text.includes(w)) continue;
    matched += 1;
    const v = idfOf(w);
    if (v > best) { best = v; bestWord = w; }
  }
  return { score: best, bestWord, matched };
}

/**
 * 一条记忆的可检索词集合。建一次可复用（99 条约 8 万词位，内存可忽略）。
 * @param entry - 记忆记录。
 * @returns 词集合。
 */
export function tokenSetOf(entry) {
  const parts = [
    entry.judgement,
    entry.conclusion,
    ...(Array.isArray(entry.evidence) ? entry.evidence : []),
    ...(Array.isArray(entry.hesitation) ? entry.hesitation : []),
  ];
  return new Set(queryTokens(parts.filter((x) => typeof x === 'string').join(' ')));
}

/**
 * 把文本切成字符二元组（中文不用分词也能比"像不像"）。
 * @param text - 原文。
 * @returns 二元组集合。
 */
export function charBigrams(text) {
  const s = String(text ?? '').replace(/\s+/g, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * RRF 融合检索：两路排序（IDF 罕见词 + 字符二元组重合），按名次融合。
 *
 * 用途：给 chain_recall 与"没命中时的兜底候选"用；注入段仍可继续用 rankEntries。
 *
 * @param entries - 全部记忆。
 * @param userText - 查询文本。
 * @param options - `{ max?, k?, minShared? }`
 * @returns `Array<{ entry, score, bestWord, shared }>`，按融合分降序。
 */
export function rankEntriesRRF(entries, userText, options = {}) {
  if (state === null) return [];
  const tokens = queryTokens(userText);
  const max = Math.max(1, Number(options.max) || 8);
  const k = Number.isFinite(Number(options.k)) ? Number(options.k) : 60;
  const minShared = Number.isFinite(Number(options.minShared)) ? Number(options.minShared) : 2;
  const qGrams = charBigrams(userText);
  if (qGrams.size === 0) return [];

  const candidates = [];
  for (const entry of entries) {
    if (entry.superseded === true) continue;
    const text = searchableTextOf(entry);
    const { score, bestWord } = scoreEntry(entry, tokens, text);
    // 二元组重合：只看"查询里有多少二元组在这条记忆里出现过"
    const grams = charBigrams(text);
    let shared = 0;
    for (const g of qGrams) if (grams.has(g)) shared += 1;
    // **没有词面证据就不进候选** —— 见文件头注释第 1 条
    if (score <= 0 && shared < minShared) continue;
    candidates.push({ entry, score, bestWord, shared, ts: Date.parse(entry.ts) || 0, weight: Number(entry.weight) || 0 });
  }
  if (candidates.length === 0) return [];

  // 两路排序
  const byIdf = [...candidates].sort((a, b) => b.score - a.score || b.shared - a.shared);
  const byGram = [...candidates].sort((a, b) => b.shared - a.shared || b.score - a.score);

  const fused = new Map();
  const accumulate = (list) => {
    list.forEach((c, i) => {
      fused.set(c.entry.id, (fused.get(c.entry.id) || 0) + 1 / (k + i + 1));
    });
  };
  accumulate(byIdf);
  accumulate(byGram);

  return candidates
    .map((c) => ({ entry: c.entry, score: fused.get(c.entry.id) || 0, bestWord: c.bestWord, shared: c.shared }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // tie-breaker：新的优先，其次权重高的（只打破平局，不主导排序）
      if (b.entry.ts && a.entry.ts && a.entry.ts !== b.entry.ts) return Date.parse(b.entry.ts) - Date.parse(a.entry.ts);
      return (Number(b.entry.weight) || 0) - (Number(a.entry.weight) || 0);
    })
    .slice(0, max);
}

/**
 * 从用户这句话出发，给全部记忆打分并返回够格的几条。
 *
 * @param entries - 全部记忆。
 * @param userText - 用户最近说的话。
 * @param options - `{ threshold?, max? }`
 * @returns `Array<{ entry, score, bestWord }>`，按分数降序；未就绪时返回空数组。
 */
export function rankEntries(entries, userText, options = {}) {
  if (state === null) return [];
  const tokens = queryTokens(userText);
  if (tokens.length === 0) return [];
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : HIT_THRESHOLD;
  const max = Math.max(1, Number(options.max) || HIT_MAX);
  const scored = [];
  for (const entry of entries) {
    // 已被取代的条目不再参与索引 —— 它还在库里可审计，但"能被想起来的"
    // 只该是活的那些。
    if (entry.superseded === true) continue;
    const { score, bestWord } = scoreEntry(entry, tokens);
    if (score >= threshold) scored.push({ entry, score, bestWord });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}
