/**
 * 记忆分档（池子）：不同种类的东西，活该有不同的寿命。
 *
 * ## 为什么分档
 *
 * 原来所有条目共用一套参数（宽限 15 天、半衰期 90 天、200 天归档）——
 * 那是"统一期限"，对核心太短、对一次性进展又太长：
 *   · 「不许提换会话」要是按 80 天删，我在 12 月就会把它忘掉；
 *   · 「今天清了两条污染」撑 200 天纯属占地方。
 *
 * 分档之后，**宽限 / 半衰期 / 归档线 / 全量注入窗口**全部由"这条属于什么"决定。
 *
 * ## 五个池（2026-10-28 作者 定稿，含两次收紧）
 *
 *   core          核心     原则 / 人格 / 边界 —— **永不衰减**，那是"你是谁"
 *   fact          事实     关于用户与角色的设定 —— 会变，但慢
 *   skill         技能     教训 / 工具 / 排障 / 出图 —— **可能被推翻，也可能只用一次**
 *   dailyCore     核心日常 被反复提起的日常 —— 值得留，但不必永久
 *   dailyPartial  片面日常 一次性进展 / 元讨论 —— 速朽
 *
 * 技能为什么从 180 收紧到 90：一条"经验"有两种死法 ——
 * **被更好的结论推翻**，或者**只在那一件事上用过一次**。两种都不该占半年位置。
 *
 * 日常为什么拆两档：日常里混着两种东西 —— "今天改了什么"（看完就没用）
 * 和"我们怎么相处的"（值得留）。**靠被提起次数自动区分**，不靠人工标。
 *
 * @module dsh-chain/pools
 */

// 设置页可覆盖的池参数（见 config.js 的 Config schema）。
// 注意方向：pools → config 是单向的，config 不认识 pools，不会循环引用。
import { configNumber, poolOverride } from './config.js';

/** 池子的定义与参数。`Infinity` 表示永不衰减 / 永不归档。 */
export const POOLS = Object.freeze({
  core: {
    key: 'core',
    label: '核心',
    desc: '原则 / 人格 / 边界 —— 你是谁',
    graceDays: Number.POSITIVE_INFINITY,
    halfLifeDays: Number.POSITIVE_INFINITY,
    archiveDays: Number.POSITIVE_INFINITY,
    injectFullDays: Number.POSITIVE_INFINITY,
  },
  fact: {
    key: 'fact',
    label: '事实',
    desc: '关于用户与角色的设定 —— 会变，但慢',
    graceDays: 15,
    halfLifeDays: 365,
    archiveDays: 1095,
    injectFullDays: 365,
  },
  skill: {
    key: 'skill',
    label: '技能',
    desc: '教训 / 工具 / 排障 / 出图',
    graceDays: 15,
    halfLifeDays: 90,
    archiveDays: 365,
    // 60 天内给全文（判断+依据+犹豫），之后只留一行判断。
    injectFullDays: 60,
  },
  // **技能拆成两个池**（2026-10-30 作者 定）：
  //   · skillRule 铁律 —— 漏一条就是"你交代过的事我没记住"，**常驻、全量**
  //   · skillExp  经验 —— 只在用得上时才拉，**按需**
  // 为什么不迁移数据：分类由文本派生（见 classifySkill），改分类规则就整体变，
  // 反悔只需删掉这两条定义 —— 不需要一条条 retag。
  skillRule: {
    key: 'skillRule',
    label: '铁律',
    desc: '必须 / 不许 / 绝不 —— 漏一条就是失约',
    graceDays: 120,
    halfLifeDays: 730,
    archiveDays: 3650,
    injectFullDays: Number.POSITIVE_INFINITY,
  },
  skillExp: {
    key: 'skillExp',
    label: '经验',
    desc: '排障 / 工具 / 出图 —— 用得上才拉出来',
    graceDays: 15,
    halfLifeDays: 60,
    archiveDays: 365,
    injectFullDays: 30,
  },
  dailyCore: {
    key: 'dailyCore',
    label: '核心日常',
    desc: '被反复提起的日常 —— 值得留，不必永久',
    // 2026-10-30 按作者授权改：原 10/10/20/20。
    // 由来：用户原话「你现在只记技能，后果是随着压缩机器味会越来越重」——
    // 日常半衰 10 天 vs 技能 90 天，结构上必然只剩技能。
    graceDays: 20,
    halfLifeDays: 60,
    archiveDays: 180,
    injectFullDays: 60,
  },
  dailyPartial: {
    key: 'dailyPartial',
    label: '片面日常',
    desc: '一次性进展 / 元讨论 —— 速朽',
    // 2026-10-30 按作者授权改：原 2/5/7/7。
    graceDays: 5,
    halfLifeDays: 20,
    archiveDays: 45,
    injectFullDays: 30,
  },
  emotion: {
    key: 'emotion',
    label: '情绪',
    desc: '**我自己的**当前状态 —— 一块牌，不是一本账',
    // 2026-10-28 作者 定：**半衰期 1 天、3 小时就开始忘**。
    //
    // 而且情绪**不走这条记忆流水线**：它是唯一性的一块状态牌，
    // 存在单独的 mood.json 里、新状态直接覆盖旧的（见 mood.js）。
    // 这里的参数只用于"过期判定"，不进 chains.jsonl 的池子统计。
    graceDays: 3 / 24,      // 3 小时
    halfLifeDays: 1,        // 1 天
    archiveDays: 3,         // 3 天后彻底过去（强度早低于阈值了）
    injectFullDays: 0,      // 不给全文，只以一行状态注入
  },
  hippocampus: {
    key: 'hippocampus',
    label: '海马体',
    desc: '最近几天的原始对话片段 —— 尚未成条，等夜巡整理',
    // 它天生是缓冲：不是"该淡"，而是"该被加工掉"。
    graceDays: 0,
    halfLifeDays: 1,
    // 2026-10-30 按作者授权改：原 3 天。原料留两周再交给夜巡加工。
    archiveDays: 14,
    // **永不进注入** —— 它是原料，不是记忆。用 -1 表示"从不给全文"，
    // 配合 injectPhaseOf 里的特判直接返回 none。
    injectFullDays: -1,
  },
});

/** 注入顺序：核心在最前，最速朽的在最后。海马体永不注入，所以不在这个列表里。 */
export const POOL_ORDER = Object.freeze(['core', 'fact', 'skillRule', 'skillExp', 'dailyCore', 'dailyPartial', 'emotion']);

/**
 * 被想起多少次，就够从"片面日常"升进"核心日常"。
 *
 * 作者 的原话是「**多次提起就放进核心日常**」。取 2 而不是 3：
 * 一条日常内容在两天里被想到两次，已经说明它不是一次性的；
 * 门槛越高，速朽的东西越容易在升级前就被删掉。
 */
export const RECALL_PROMOTE = 2;

/**
 * 标签 → 池子的映射规则，**按顺序匹配，先命中先得**。
 *
 * ⚠️ 2026-10-28 第一次归池的教训：core 原来还认 `行为` / `判据` / `诚实`，
 *    结果 6 条教训（如「没调 present 就等于没交付」）被当成核心 —— 它们的标签里
 *    恰好都有 `行为`。**核心只认真正不会变的东西**：原则与人格。
 */
const POOL_RULES = [
  // 情绪与海马体必须在最前：它们靠标签一票决定，不该被别的标签抢走。
  ['emotion', ['情绪']],
  ['hippocampus', ['海马体']],
  // **core 冻结点（2026-10-29 用户定）**：核心层不再增加，只保留"我是谁"那 32 条。
  // 新写的判断不许落 core —— chain_append 会直接拒绝（见 index.js 的守卫）。
  ['core', ['原则', '人格']],
  // 「怎么对用户」的相处规矩 → 核心日常（排在 fact 前面：带了「关系/对用户/相处」就归这里，
  // 哪怕同时带了「用户」标签 —— 它讲的不是"用户是谁"，是"我该怎么对用户"）。
  ['dailyCore', ['对用户', '相处', '关系']],
  ['fact', ['用户', '角色']],
  ['skill', ['教训', '工具', '排障', '出图', '训练', '协作', '验证', '查证', '算账', '对照',
    '清理', '侦察', '认错', '工程', '架构', '判据', '诚实', '顶嘴', '行为', '遗忘机制']],
  ['dailyPartial', ['记忆', '设计', '插件', 'dsh-chain', '风险', '决策', '日常']],
];

/**
 * 没命中任何规则时的兜底池。
 *
 * **2026-10-29 改（用户定的）**：原来是 `dailyPartial`（7 天速朽）——
 * 那等于「标签没写对就悄悄丢掉」。现在的规则是：
 *
 *   标签没命中任何池 → **进海马体**（原料缓冲区，3 天过期、永不注入）+ 打「未归类」标注
 *   → 下次夜巡重点列出来审
 *   → 同样的内容**重复写满 3 次** → 升级为「需人工定池」
 *
 * 理由：池子决定的是"这条记忆活多久"，猜错了代价是不对称的 ——
 * 猜成 7 天，那条就真的没了；猜成海马体，最坏也只是躺在缓冲区等一次审查。
 */

/**
 * 核心层最多几条。
 *
 * 2026-10-29：用户自己的实例已经写满 32 条，说「核心层面不再做增加」。
 * 但开源包是白板启动（core 0 条）—— 无条件冻结会让人永远立不了原则。
 * 所以这里做成**上限**：满了才拒绝新增。
 */
export const CORE_MAX = 32;

/** 数出还活着的 core 条目（原则/人格）。 */
export function coreCount(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let n = 0;
  for (const entry of list) {
    if (!entry || entry.superseded === true) continue;
    if (basePoolOf(entry) === 'core') n += 1;
  }
  return n;
}

/** 核心层满了没有（上限可被设置页覆盖）。 */
export function coreIsFull(entries, max) {
  const limit = Number.isFinite(Number(max)) ? Number(max) : configNumber('coreMax', CORE_MAX);
  const count = coreCount(entries);
  return { full: count >= limit, count, max: limit };
}
const FALLBACK_POOL = 'hippocampus';

/** 没命中规则时打的标注标签（夜巡靠它把这类挑出来）。 */
export const UNCLASSIFIED_TAG = '未归类';

/**
 * 这组标签有没有命中任何池规则。
 *
 * @param tags - 标签数组。
 * @returns 命中返回 true；空标签或全不命中返回 false。
 */
export function hasPoolRule(tags) {
  const list = Array.isArray(tags) ? tags : [];
  if (list.length === 0) return false;
  for (const [, words] of POOL_RULES) {
    for (const tag of list) {
      const text = String(tag);
      if (words.some((w) => text.includes(w))) return true;
    }
  }
  return false;
}

/**
 * 判断一条记忆**基础**属于哪个池（只看标签，不看使用次数）。
 *
 * @param entry - 记忆记录（读 `tags`）。
 * @returns 池子的 key。
 */
export function basePoolOf(entry) {
  // **人工定池优先**（2026-10-29）：夜巡报告里标了「需人工定池」之后，
  // chain_touch 的 set-pool 会写一条 retag 事件，这里直接吃它 ——
  // 人已经拍板的事，不该再被标签推导盖过去。
  const manual = String(entry?.poolOverride ?? '');
  if (manual !== '' && Object.prototype.hasOwnProperty.call(POOLS, manual)) return manual;
  const tags = Array.isArray(entry?.tags) ? entry.tags : [];
  if (tags.length === 0) return FALLBACK_POOL;
  for (const [pool, words] of POOL_RULES) {
    for (const tag of tags) {
      const text = String(tag);
      if (words.some((w) => text.includes(w))) return pool;
    }
  }
  return FALLBACK_POOL;
}

/**
 * 一条记忆**实际**属于哪个池：基础池 + 「被多次提起就升级」。
 *
 * 这是纯函数派生，不写盘、不需要额外事件 —— 因为它依赖的只有 `touchCount`，
 * 而 `touchCount` 已经由命中记账在维护。**升级是自动发生的，不需要谁批准**，
 * 这正合作者 的要求：「采用系统判断，多次提起就放进核心日常」。
 *
 * @param entry - 记忆记录（需带 `touchCount`）。
 * @returns 池子的 key。
 */
export function poolOf(entry) {
  const base = basePoolOf(entry);
  // 技能运行时再分一次：铁律 vs 经验（桩数据不动，纯派生）
  if (base === 'skill') return classifySkill(entry);
  if (base !== 'dailyPartial') return base;
  const touched = Number(entry?.touchCount) || 0;
  return touched >= RECALL_PROMOTE ? 'dailyCore' : 'dailyPartial';
}

/**
 * 技能再分类：铁律 / 经验。
 *
 * **判据是文本里有没有"硬约束"口气** —— 带 必须/不许/绝不/永远/红线/禁止/千万 的，
 * 是"我答应过用户不再犯"的那类，漏掉代价最大，必须常驻；其余都是可以按需翻出来的经验。
 *
 * @param entry - 记忆记录。
 * @returns 'skillRule' | 'skillExp'
 */
const RULE_SIGNAL = /必须|不许|绝不|永远|红线|禁止|千万|一定要|铁律|只能|不能|别把|别再/;

export function classifySkill(entry) {
  const tags = Array.isArray(entry?.tags) ? entry.tags : [];
  if (tags.some((t) => String(t).includes('铁律'))) return 'skillRule';
  const text = String(entry?.judgement ?? '') + ' ' + String(entry?.conclusion ?? '');
  return RULE_SIGNAL.test(text) ? 'skillRule' : 'skillExp';
}

/**
 * 取池子的参数。
 *
 * **设置页里改了天数/半衰期就以设置为准**（2026-10-29 加）：
 * 默认值仍写在 `POOLS` 里，`poolOverride()` 只覆盖它认识的三个字段，
 * 所以用户调坏一个值不会把整只池子搞没。
 *
 * @param key - 池子 key。
 * @returns 池子定义（未知 key 退回兜底池）。
 */
export function poolDef(key) {
  const base = POOLS[key] ?? POOLS[FALLBACK_POOL];
  const override = poolOverride(key);
  return Object.keys(override).length > 0 ? { ...base, ...override } : base;
}

/**
 * 这条记忆此刻该以什么粒度进注入。
 *
 * @param entry - 记忆记录（需带 `touchCount`）。
 * @param ageDays - 距最后一次被碰的天数。
 * @returns `'full'`（判断+依据+犹豫）| `'brief'`（只一行）| `'none'`（不进注入）。
 */
export function injectPhaseOf(entry, ageDays) {
  const def = poolDef(poolOf(entry));
  // 海马体是原料不是记忆 —— **无条件不进注入**，哪怕刚写下来一秒。
  if (def.injectFullDays < 0) return 'none';
  // 情绪走单独的「我现在」段（见 format.js），不混进记忆列表里。
  if (def.key === 'emotion') return 'none';
  const age = Number(ageDays) || 0;
  if (age >= def.archiveDays) return 'none';
  return age <= def.injectFullDays ? 'full' : 'brief';
}

/**
 * 取最近还"有余温"的情绪条目（给自己注入「我现在」那一行用）。
 *
 * @param entries - 全部记忆（需已带 `pool` / `ageDays` 或时间戳）。
 * @param now - 当前时间毫秒。
 * @param limit - 最多几条，默认 2。
 * @returns `{ latest, recent }`：最新一条与最近若干条（都已排除过期的）。
 */
export function recentEmotions(entries, now = Date.now(), limit = 2) {
  const def = POOLS.emotion;
  const rows = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.superseded !== true)
    .map((entry) => {
      const from = Date.parse(String(entry.lastTouched || entry.ts || ''));
      return { entry, ageDays: Number.isFinite(from) ? (now - from) / 86_400_000 : Infinity };
    })
    .filter((row) => row.entry.pool === 'emotion' || basePoolOf(row.entry) === 'emotion')
    .filter((row) => row.ageDays < def.archiveDays)
    .sort((a, b) => a.ageDays - b.ageDays);
  return { latest: rows[0] ?? null, recent: rows.slice(0, Math.max(1, limit)) };
}
