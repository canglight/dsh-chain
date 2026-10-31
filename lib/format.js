/**
 * 渲染层：把记录变成两种东西——
 *   1. 注入进 system prompt 的短文本（严格限长）；
 *   2. Mermaid 图（给人看轨迹）。
 *
 * 两个渲染函数都必须是**纯函数**：同样的输入永远同样的输出。
 * 注入段会因为渲染结果不稳定而破坏系统提示的缓存前缀，
 * 那是实打实的钱。
 *
 * @module dsh-chain-shared/format
 */

import {
  INJECT_MAX_CHARS,
  INJECT_RECENT,
  INJECT_TOP,
  TOP_WEIGHT_MIN,
  configNumber,
} from './config.js';
// 索引检索（jieba + 通用 IDF）。**可选依赖**：没就绪时 format 自动走旧逻辑。
import { rankEntries, retrievalReady, rankEntriesRRF } from './retrieval.js';
// 决策层：从命中走一跳（2026-10-30）。纯函数、不写盘。
import { trace } from './trace.js';
// 分档池子：不同池不同宽限/半衰期/归档线/全量注入窗口。
import { injectPhaseOf, poolDef, poolOf } from './pools.js';
// 我的当前情绪（唯一性的一块状态牌，不是记忆条目）。
import { humanAge, visibleMood } from './mood.js';

/**
 * **「最近她说过的话」这一节的上限**（2026-10-30）。
 *
 * 海马体是原料缓冲区，默认永不注入；但里面装的是**她的原话**，
 * 一点不给就会变成"只剩技能"的机器味。所以开一扇很小的窗：
 * 只取最近 4 条、每条 80 字 —— 约 300 字符，是"在场感"的价格，不是全量账本。
 */
const HIPPOCAMPUS_INJECT_MAX = 4;
/** 原料的新鲜窗口（天）：比 poolDef 的 archiveDays 短得多，只捞"这两天的她"。 */
const HIPPOCAMPUS_FRESH_DAYS = 2;

/**
 * 这条原料够不够新，值得出现在「最近她说过的话」里。
 *
 * 判据刻意简单：按 ts 算年龄 ≤ HIPPOCAMPUS_FRESH_DAYS。
 * 不用权重 —— 权重是给"判断"用的，原料的权重没有意义（夜巡⑤也不该动它）。
 *
 * @param entry - 海马体条目。
 * @param ageDays - 调用方算好的年龄（天）。
 * @returns 是否够新。
 */
function isFreshHippocampus(entry, ageDays) {
  if (entry?.superseded === true) return false;
  if (poolOf(entry) !== 'hippocampus') return false;
  if (!Number.isFinite(ageDays) || ageDays > HIPPOCAMPUS_FRESH_DAYS) return false;
  // **空正文一律不算**（2026-10-30 修，其他代理审出来的）：
  // 头部计数用的是"过滤后剩几条"，而循环体里还有一句 `if (text === '') continue`。
  // 两把尺子一旦不一致，就会出现「header 说 4 条、实际只打出 1 行」——
  // 而事件记录（touch / retag / supersede）的 judgement 就是空串。
  // 判据统一挪到这里：**能进这一节，就必须有字可打。**
  const text = String(entry.judgement || '').replace(/^片段：/, '').trim();
  if (text.length < 2) return false;
  // **只收她说的**：鱼对鱼的消息（`【其他代理 → 目标会话…】`）会以"用户消息"身份写进海马体，
  // 但它不是她的话。这一节叫「最近她说过的话」，混进鱼群消息就变味了。
  if (/^【[^】]*号鱼/.test(text) || /→\s*[^ ]*号鱼/.test(text)) return false;
  return true;
}

/**
 * 注入段的字符上限。
 *
 * 2026-10-29：改成**可从设置页调**（`injectMaxChars`）。默认 24000 字符 ≈ 8k token，
 * 那是权衡过的值 —— 太小就把记忆挤成"外挂硬盘"，太大则每轮都在为旧判断付钱。
 * 夹 2000 的下限，防止有人手滑填 1 把整段注入干掉。
 */
function injectCap() {
  return Math.max(2000, configNumber('injectMaxChars', INJECT_MAX_CHARS));
}

/**
 * 把 ISO 时间戳裁成 `MM-DD`。
 * @param ts - ISO 时间字符串。
 * @returns `MM-DD`；无法解析时返回 `??-??`。
 */
function shortDate(ts) {
  const parsed = Date.parse(String(ts ?? ''));
  if (!Number.isFinite(parsed)) return '??-??';
  const d = new Date(parsed);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

/**
 * 取记录的主标题：优先 judgement，没有就退回 conclusion。
 * @param entry - 记录。
 * @returns 单行标题。
 */
function titleOf(entry) {
  const judgement = typeof entry.judgement === 'string' ? entry.judgement.trim() : '';
  if (judgement !== '') return judgement;
  const conclusion = typeof entry.conclusion === 'string' ? entry.conclusion.trim() : '';
  return conclusion !== '' ? conclusion : '(无标题)';
}

/**
 * 把一条记录渲染成注入用的若干行。
 * @param entry - 记录。
 * @param detailed - 是否带上依据与犹豫。
 * @returns 行数组。
 */
function entryLines(entry, detailed) {
  const lines = [`- [${shortDate(entry.ts)}] ${titleOf(entry)}`];
  if (detailed) {
    const evidence = Array.isArray(entry.evidence) ? entry.evidence.filter((x) => typeof x === 'string' && x.trim() !== '') : [];
    if (evidence.length > 0) lines.push(`  依据: ${evidence.slice(0, 3).join(' / ')}`);
    const hesitation = Array.isArray(entry.hesitation) ? entry.hesitation.filter((x) => typeof x === 'string' && x.trim() !== '') : [];
    if (hesitation.length > 0) lines.push(`  犹豫: ${hesitation.slice(0, 2).join(' / ')}`);
  }
  const conclusion = typeof entry.conclusion === 'string' ? entry.conclusion.trim() : '';
  if (conclusion !== '') lines.push(`  结论: ${conclusion}`);
  return lines;
}

/**
 * 判断一条记录是不是"原则"（构成我的东西）。
 * @param entry - 记录。
 * @returns 是否带 `原则` 标签。
 */
function isPrinciple(entry) {
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  return tags.some((tag) => typeof tag === 'string' && tag.includes('原则'));
}

/**
 * 渲染注入段的正文。
 *
 * **预算分配是先原则、后最近**——这个顺序不能再反了：
 * 原则是我"不假思索就那么做"的那几条，它们不该因为时间久而被挤掉；
 * 而流水记录的价值本来就随时间掉。
 *
 * 结构：
 *   1. 【原则】只给标题行（一行一条，最省），它们是骨架，不需要每次复述依据；
 *   2. 【最近】带依据/犹豫/结论，占用剩下的预算。
 *
 * 超预算时从**最近组的尾部**砍，原则组不动。
 *
 * @param entries - 全部记录（不要求有序）。
 * @param options - 选项。
 * @param options.userText - 用户最近说的话。给了它就启用**索引延申**：
 *   用户提到的词若命中某条记忆，就把那条的**细节**（判断+结论+依据）插到注入里 ——
 *   平时只记「判断」一行，被提起时才想起细节。这正是人记东西的方式。
 * @returns 注入文本；没有记录时返回**空串**（调用方据此不注入）。
 */
export function renderInjection(entries, options = {}) {
  if (!Array.isArray(entries)) return '';
  const userText = typeof options.userText === 'string' ? options.userText : '';
  const nowMs = Date.now();

  // ⚠️ 库是空的时候也要能显示情绪 —— 2026-10-28 实测：原来这里直接 return ''，
  //    结果「我现在」跟着记忆一起消失了。**情绪不依赖记忆有没有内容**：
  //    一条记忆都没有的鱼，照样会挫败、会担心。
  if (entries.length === 0) {
    const only = visibleMood(nowMs);
    if (!only) return '';
    const lines = ['## 我的思维链（只对我可见）', '',
      `我现在：${only.mood}（${humanAge(only.ageHours)}·强度 ${only.strength.toFixed(2)}）`];
    if (only.why !== '') lines.push(`因为：${only.why}`);
    return lines.join('\n');
  }

  const sorted = [...entries].sort((a, b) => {
    const ta = Date.parse(String(a.ts ?? ''));
    const tb = Date.parse(String(b.ts ?? ''));
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return 0;
  });

  // ⚠️ **已被取代（superseded）的条目一律不进注入。**
  // 2026-10-28 实测发现的毛病：取代只把权重压到 0.1，正文照样一行一行注入 ——
  // 于是新旧两条判断同时出现在我脑子里，而旧的那条是**错的**（例：那条推荐
  // "给每条记忆配 keywords" 的结论，在改用 jieba+IDF 之后就作废了）。
  // 取代的语义是"我不再这么想"，那就该从脑子里撤掉；数据仍留在 JSONL 可审计。
  //
  // 注意顺序：`live` 必须在 principles/rest 之前算出来（const 有 TDZ，写反了直接崩）。
  const live = sorted.filter((entry) => entry.superseded !== true);

  const principles = live.filter(isPrinciple);
  const rest = live.filter((entry) => !isPrinciple(entry));

  // 归档态（超过 200 天没被碰过）**不再进系统提示** —— 这是"代谢"和"档案"的分界：
  // 数据还完整留在 JSONL 里可审计，但它不该再占我每轮的预算。
  // 一旦被 chain_recall / chain_touch 重新想起，lastTouched 更新、age 归零，自动回到活跃。
  // 注意：`nowMs` 在函数开头已声明（情绪段要先用它），这里不能再声明一次。
  const agingOf = (entry) => {
    const from = Date.parse(String(entry.lastTouched || entry.ts || ''));
    return Number.isFinite(from) ? (nowMs - from) / 86_400_000 : 0;
  };

  const head = ['## 我的思维链（只对我可见）'];

  // 池子分组（2026-10-28 分档，共七档）：不同种类的东西活该有不同寿命。
  //   core          核心     永不衰减，全量常驻
  //   fact          事实     关于她与角色的设定
  //   skill         技能     教训 / 工具 / 排障 / 出图（半衰期 90，60 天内全量）
  //   dailyCore     核心日常 被反复提起的日常（20 天制）
  //   dailyPartial  片面日常 一次性进展 / 元讨论（7 天制）
  //   emotion       情绪     **我自己的**状态 —— 单独走「我现在」段
  //   hippocampus   海马体   原始片段，**永不进注入**，等夜巡加工
  const groups = {
    core: [], fact: [], skillRule: [], skillExp: [], dailyCore: [], dailyPartial: [],
    emotion: [], hippocampus: [],
  };
  for (const entry of live) {
    const key = entry.pool && groups[entry.pool] ? entry.pool : poolOf(entry);
    if (!groups[key]) continue; // 未知池一律不进注入，宁可少一条
    groups[key].push(entry);
  }

  // ⓪ **我现在**：我的情绪状态（不是记忆，是此刻语气的来源）。
  //
  // 用户 定的规则：情绪是**我自己**的当前状态，**一块牌不是一本账** ——
  // 唯一性、可覆盖写、3 小时开始忘、半衰期 1 天（见 mood.js）。
  // 强度掉到阈值以下就当作过去了，这里一个字都不显示。
  const mood = visibleMood(nowMs);
  if (mood) {
    head.push('', `我现在：${mood.mood}（${humanAge(mood.ageHours)}·强度 ${mood.strength.toFixed(2)}）`);
    if (mood.why !== '') head.push(`因为：${mood.why}`);
  }

  // ② **最近她说过的话**（2026-10-30 加，其他代理诊断 + 她原话驱动）。
  //
  // 为什么要有这一节：海马体装的是**她的话**，而它的 `injectFullDays = -1`（永不注入），
  // 于是"她说的话、我俩的日常"既进不了注入、又本来 3 天就过期 —— 能讲的只剩技能。
  // 她的话原文是「只记技能的那叫机器」「随着压缩机器味会越来越重」。
  //
  // 三条设计约束：
  //   · **只给原文片段**，不做摘要（摘要会把她的话变成我的措辞，那就又丢了）；
  //   · **只取最近 4 条**，每条截 80 字 —— 这一节是"在场感"，不是"全量账本"；
  //   · 单独一节，**不进池循环**（hippocampus 不在 sectionOrder / POOL_ORDER 里）。
  if (groups.hippocampus.length > 0) {
    const recent = [...groups.hippocampus]
      .filter((entry) => isFreshHippocampus(entry, agingOf(entry)))
      .sort((a, b) => (Date.parse(String(b.ts || '')) || 0) - (Date.parse(String(a.ts || '')) || 0))
      .slice(0, HIPPOCAMPUS_INJECT_MAX);
    if (recent.length > 0) {
      head.push('', `最近她说过的话（原文 ${recent.length} 条 · 还没加工）：`);
      for (const entry of recent) {
        const text = String(entry.judgement || '').replace(/^片段：/, '').trim();
        if (text === '') continue;
        head.push(`- ${text.length > 80 ? text.slice(0, 80) + '…' : text}`);
      }
    }
  }

  // ③ 核心：一行一条，永不收敛。
  if (groups.core.length > 0) {
    head.push('', `核心（${groups.core.length} 条 · 不随时间淡）：`);
    for (const entry of groups.core) head.push(`- ${titleOf(entry)}`);
  }

  // ④ **联想注入**（2026-10-30，她定的方向）：这次对话 = 从这句话联想出来的一撮。
  //
  // 和"全量注入"的区别：以前事实/技能/日常四个池每轮全贴（4,600+ 字符）；
  // 现在只贴「被这句话联想到的」，其余靠 `chain_recall` 按需查。
  // 常驻的只剩三样：情绪（此刻语气）、核心（我是谁）、她说过的话（在场感）。
  //
  // **三条回退规则**（弱结果不如不联想）：
  //   · 联想节点 < 3 条 → 不算联想，退回全量注入；
  //   · 没有 userText（开机/静默轮）→ 同样退回；
  //   · 联想过程抛错 → index.js 传 null → 退回。
  const assoc = options?.association;
  const assocNodes = Array.isArray(assoc?.nodes) ? assoc.nodes : [];
  const useAssoc = assocNodes.length >= 3 && String(options?.userText ?? '').trim() !== '';
  if (useAssoc) {
    const byId = new Map(live.map((e) => [String(e.id), e]));
    const shown = [];
    let used = 0;
    for (const node of assocNodes) {
      const entry = byId.get(String(node.id));
      if (!entry) continue;
      const line = `- ${titleOf(entry)}`;
      if (used + line.length > 2400) break;          // 联想段自己的小预算
      shown.push({ entry, node, line });
      used += line.length + 1;
    }
    if (shown.length >= 3) {
      head.push('', `这次联想到的（${shown.length} 条 · 从这句话出发）：`);
      for (const s of shown) {
        const tag = s.node.hop === 0 ? '' : `（${s.node.why}）`;
        head.push(`${s.line}${tag}`);
      }
      // 只给**最像的那 2 条**展开细节 —— 细节段一直是注入里最胖的一块。
      const detail = shown.slice(0, 2).map((s) => s.entry);
      if (detail.length > 0) {
        head.push('', '其中值得细看的：');
        for (const entry of detail) head.push(...entryLines(entry, true));
      }
      // 记账：联想出来的也算"被想起"（否则衰减统计会漏掉这一半）。
      if (typeof options.onHit === 'function') {
        for (const s of shown) options.onHit(String(s.entry.id));
      }
    }
  }

  // 用了联想就不再全量贴：四个池清空，剩下的常驻只有 核心 / 情绪 / 她说过的话。
  if (useAssoc) {
    groups.fact.length = 0;
    groups.skillExp.length = 0;
    groups.dailyCore.length = 0;
    groups.dailyPartial.length = 0;
  }

  // ② 其余四档：一行一条，但进门条件由各自池子决定（见 pools.js）。
  //   **全部记忆都进来**（不是只取最近 N 条）—— 用户原话：
  //   「思维链应该是你脑子里绝对拥有的东西，不应该是要你去找」。
  //   例外只有速朽的两档日常：到期就不再占每轮预算，但仍留在库里可检索。
  const brief = [];
  const sectionTitles = {
    fact: '事实',
    skillRule: '铁律（失约过的才知道）',
    skillExp: '经验',
    dailyCore: '核心日常',
    dailyPartial: '片面日常',
  };
  // **装箱 v2：全局统一预算**（2026-10-29）
  // v1 是"一段一段吃预算"，实测不公平：段序在前的池先吃饱，权重更高的却被后面挤掉。
  // 现在四个池的候选合成一个池，按权重全局排序逐条装，装完再按原段顺序分组显示。
  const sectionOrder = ['fact', 'skillRule', 'skillExp', 'dailyCore', 'dailyPartial'];
  const candidates = [];
  for (const key of sectionOrder) {
    for (const entry of groups[key]) {
      if (injectPhaseOf(entry, agingOf(entry)) === 'none') continue;
      candidates.push({ key, entry });
    }
  }
  candidates.sort((a, b) => {
    const wa = Number(a.entry.weight) || 0;
    const wb = Number(b.entry.weight) || 0;
    if (wb !== wa) return wb - wa;
    const ta = Date.parse(String(a.entry.ts ?? ''));
    const tb = Date.parse(String(b.entry.ts ?? ''));
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  const usedChars = head.join('\n').length + brief.join('\n').length;
  const picked = [];
  const skippedOf = new Map();   // key → 装不下的条数（必须写出来，不许静默丢）
  let running = usedChars;
  for (const item of candidates) {
    const line = `- [${shortDate(item.entry.ts)}] ${titleOf(item.entry)}`;
    // 装不下就跳过这条、继续试下一条更短的（不是整段停）
    if (running + line.length + 40 > injectCap()) {
      skippedOf.set(item.key, (skippedOf.get(item.key) || 0) + 1);
      continue;
    }
    picked.push({ key: item.key, line });
    running += line.length + 1;
  }

  for (const key of sectionOrder) {
    let rows = picked.filter((p) => p.key === key).map((p) => p.line);
    let skipped = skippedOf.get(key) || 0;

    // **经验按需**（2026-10-30 用户 定的）：技能拆成「铁律 / 经验」之后，
    // 铁律（26 条）永远全量 -- 漏一条就是失约；经验（36 条）**无条件只给 3 条**。
    // 为什么无条件：短句常常联想不起来（实测「现在功能做到哪步了」会回退全量），
    // 一旦回退就把 36 条经验全贴回来了 —— 那拆了等于没拆。
    // 挑哪 3 条：权重高的优先（被用过、被确认过的在前）。
    if (key === 'skillExp' && rows.length > 3) {
      skipped += rows.length - 3;
      rows = rows.slice(0, 3);
    }

    if (rows.length === 0) {
      if (skipped > 0) {
        brief.push('', `${sectionTitles[key]}：本轮预算不足，${skipped} 条未展开（用 chain_recall 查）`);
      }
      continue;
    }
    const suffix = key === 'skillExp'
      ? ` · 库里另有 ${skipped} 条，需要时 chain_recall 查`
      : (skipped > 0 ? ` · 另有 ${skipped} 条未展开（chain_recall 可查）` : '');
    brief.push('', `${sectionTitles[key]}（${rows.length} 条${suffix}）：`, ...rows);
  }
  if (brief.length > 0) head.push(...brief);

  // ③ 最近几条给全文（依据/犹豫），因为刚发生的事最可能需要细节。
  //    片面日常不展开 —— 速朽的东西不占详细位。
  // 只给"正经记忆"展开细节：片面日常太速朽、情绪已单独成段、
  // 海马体是原料（还没成条，展开没有意义）。
  const detailed = rest.filter((entry) => {
    const key = poolOf(entry);
    return key !== 'dailyPartial' && key !== 'emotion' && key !== 'hippocampus';
  });
  const usedNow = head.join('\n').length;
  let budget = injectCap() - usedNow - 24;
  const recentLines = [];
  let placed = 0;
  for (const entry of detailed) {
    if (placed >= INJECT_RECENT) break;
    if (agingOf(entry) > 200) continue;
    const lines = entryLines(entry, true);
    const cost = lines.join('\n').length + 1;
    if (cost > budget) break;
    recentLines.push(...lines);
    budget -= cost;
    placed += 1;
  }
  if (recentLines.length > 0) {
    head.push('', '最近这几条的细节：', ...recentLines);
  }

  // ④ **索引延申**：你刚说的话如果提到了某条记忆里的词，就把那条的细节想起来。
  //
  // 这是 2026-10-28 用户点出的机制：「不用完全记住细节，应该以这个词被提起做索引
  // 延申出细节」。平时注入里只有「判断」一行，**细节是按需被一句话唤醒的** ——
  // 跟人记东西一样：不记得全部，但一个词能勾出来。
  //
  // ⚠️ 第一版踩了两个坑（实测）：
  //   ① 只遍历非原则 → 「项目甲」那条在原则里，永远勾不出来；
  //   ② 匹配词长度只要求 2 字 → 「为什么」「可以」这种常用词把不相干的条目全勾进来。
  // 所以现在：**遍历全部** + **最短 3 字** + **停用词表**。
  if (userText !== '') {
    const STOP = new Set([
      '为什么', '什么', '怎么', '可以', '不是', '这个', '那个', '我们', '你们', '他们',
      '现在', '然后', '因为', '所以', '如果', '但是', '而且', '就是', '还是', '已经',
      '一下', '一些', '这样', '那样', '一个', '没有', '知道', '觉得', '应该', '需要',
      '记忆', '判断', '结论', '依据', '问题', '东西', '时候', '地方', '自己', '别人',
      '帮我', '看看', '一下', '今天', '明天', '现在', '怎么', '多少', '哪里', '是不是',
      '能不能', '要不要', '有没有', '写一', '这个', '那个', '什么', '我的', '你的',
    ]);

    /**
     * 从一段文本里切出所有 **2-10 字的中文候选词**（滑动窗口）。
     *
     * ⚠️ 不能再用 `text.match(/[\u4e00-\u9fa5]{2,10}/g)`：正则是**贪婪且不重叠**的，
     * 遇到「选有暖气的项目甲而不是更好看的项目丙」它会整段吃掉，
     * **永远不会单独产出「项目甲」这个词** —— 实测「项目甲」命中 0 条就是这个原因。
     *
     * 现在用滑窗：把非中文当分隔符切开，每段内枚举所有长度 2-10 的子串。
     * 只在**用户消息**上做（短，词少），再拿这些词去查记忆，成本可控。
     *
     * @param text - 待切分的文本。
     * @returns 候选词数组（长的在前，短的在后面兜底）。
     */
    const extractWords = (text) => {
      const out = [];
      const clean = String(text ?? '').replace(/[^\u4e00-\u9fa5]+/g, '\u0000');
      for (const seg of clean.split('\u0000')) {
        if (seg.length < 2) continue;
        // 长词优先：专有名词（项目甲、组件甲）比通用二字词更有区分度
        for (let len = Math.min(10, seg.length); len >= 2; len -= 1) {
          for (let i = 0; i + len <= seg.length; i += 1) {
            const w = seg.slice(i, i + len);
            if (!STOP.has(w)) out.push(w);
          }
        }
      }
      return out;
    };

    // 从用户这句话里切词（一次），再拿词去比每条记忆
    const userWords = extractWords(userText);

    /** 一条记忆可比的全部文本。 */
    const haystackOf = (entry) => [
      String(entry.judgement ?? ''),
      String(entry.conclusion ?? ''),
      ...(Array.isArray(entry.evidence) ? entry.evidence.map(String) : []),
    ].join(' ');

    // 命中规则
    // ========
    // **首选：jieba 分词 + 通用 IDF 打分**（见 retrieval.js）。
    // 实测 8 个问法全对：4 个专名问法全命中、4 个无关问法全 0 命中，
    // 99 条约 0.6 ms/次。判据是「命中词里最高的通用 IDF ≥ 9」——
    // 通用虚词（今天 5.0 / 为什么 5.3 / 是不是 5.9）根本够不到那条线。
    //
    // **降级：** 检索层没就绪（jieba 没装上 / 加载失败）时走旧的滑窗匹配。
    // 旧逻辑已知会夹噪声，但**绝不因为它差就不注入** —— 少一段记忆比多两条噪声更糟。
    let hit = [];
    let hitWhy = '';
    // **块级作用域的坑**（2026-10-30 踩）：`ranked` 是在下面 if 里用 const 声明的，
    // 出了那个块就看不见 —— 我第一版直接在外面用它，ReferenceError 又被 catch 吞了，
    // 表现是「走线段永远不出现」。所以在这里留一个外层变量接住它。
    let rankedForTrace = [];
    // **海马体不参与检索**：它是原料不是记忆，不该被"想起"。
    // 2026-10-28 实测踩过 —— 刚写进去的片段立刻被索引延伸命中，
    // 注入里出现「你这句话让我想起来（打错字 11.9）」，等于拿垃圾当回忆。
    const rankable = sorted.filter((entry) => entry.superseded !== true && poolOf(entry) !== 'hippocampus');
    if (retrievalReady() && userText !== '') {
      // 注入段也用 RRF（2026-10-29 评估集实测：R@5 29% → 64%）。
      // 保留 rankEntries 的 import：万一 RRF 出岔子，仍可一行切回去。
      const ranked = rankEntriesRRF(rankable, userText, { max: 3 });
      rankedForTrace = ranked;
      hit = ranked.map((item) => item.entry);
      if (ranked.length > 0) {
        // ⚠️ 这里**不能**再按 IDF 的写法显示 `词(分数)`：RRF 的 score 是融合分（0.03 量级），
        // toFixed(1) 会全变成 (0.0)，看着像没命中。只显示命中词，分数只进调试。
        const words = ranked.map((item) => item.bestWord).filter((w) => typeof w === 'string' && w !== '');
        hitWhy = words.length > 0 ? [...new Set(words)].slice(0, 4).join(' ') : '';
      }
    } else {
      // ---- 旧逻辑（降级路径）----
      // 2026-10-28 试过"最长命中词 + 稀有度加权"的打分排序，回退了：
      // 长词优先会奖励偶然凑出的长串，把「空转」这种 2 字目标挤掉。
      if (userWords.length > 0) {
        for (const entry of rankable) {
          if (hit.length >= 3) break;
          if (agingOf(entry) > 200) continue;
          const hay = haystackOf(entry);
          if (userWords.some((w) => hay.includes(w))) hit.push(entry);
        }
      }
    }
    if (!useAssoc && hit.length > 0) {
      head.push('', hitWhy === '' ? '你这句话让我想起来：' : `你这句话让我想起来（${hitWhy}）：`);
      for (const entry of hit) {
        head.push(...entryLines(entry, true));
      }
      // **决策层走线**（2026-10-30）：从命中出发走一跳，把「由 1 想到 2」露出来。
      //
      // 三条边上规矩：
      //   · 只走一跳（跳数放开会扩散成噪声）；
      //   · 门槛用 shared ≥ 4，**不用 RRF 分数** —— 那个分是排名分，第一名恒为 0.0328，
      //     拿它当相关性判断是类别错误（实测原话 16 / 换说法 10 / 无关 1，分得很开）；
      //   · 只露 2 条、每条一句，占几十字符。
      try {
        const walked = trace(rankedForTrace, rankable, { maxHop: 1, maxNodes: 4, minShared: 4 });
        const hops = (walked?.nodes ?? []).filter((n) => n.hop === 1).slice(0, 2);
        if (hops.length > 0) {
          const byId = new Map(rankable.map((e) => [String(e.id), e]));
          const bits = [];
          for (const node of hops) {
            const target = byId.get(String(node.id));
            if (!target) continue;
            // why 现在有两种形态：`共享「X」` 和 `共享「X」（从第 N 条出发）`。
            // 原来用 `replace(/^共享「|」$/)` 剥，第二种会剩下一半括号 ——
            // 注入里就出现 `由「适配」（从第 1 条出发）」想到…` 这种多一个 」 的怪东西（2026-10-30 实测）。
            // 改成**直接抓括号里的内容**，两种形态都能取干净。
            const whyText = String(node.why || '');
            const viaMatch = whyText.match(/^共享「([^」]+)」/);
            const via = viaMatch ? viaMatch[1] : whyText.trim();
            bits.push('由「' + via + '」想到：' + String(titleOf(target)).slice(0, 24));
          }
          if (bits.length > 0) head.push('- ' + bits.join('；'));
        }
      } catch {
        /* 走线失败不影响注入 —— 它只是锦上添花 */
      }

      // **回执**：把"这一轮真的想起了哪几条"交回给调用方（index.js），
      // 由它去写 touch 事件。渲染层自己不写盘 —— 它必须保持纯粹，
      // 而且写盘时机该由宿主决定。
      // 这就是遗忘机制的入口：被想起 → 记一笔 → 衰减变慢；没人提 → 照常淡。
      if (typeof options.onHit === 'function') {
        for (const entry of hit) {
          try {
            options.onHit(String(entry.id ?? ''), entry);
          } catch {
            /* 回执失败不该影响注入本身 */
          }
        }
      }
    }
  }

  // ⑤ 兜底：万一原则本身就超了（条目太多），仍然要截断，否则会把 prompt 撑爆。
  let text = head.join('\n').trim();
  if (text.length > injectCap()) {
    text = `${text.slice(0, injectCap() - 1).trimEnd()}…`;
  }
  return text;
}

/**
 * 把 Mermaid 标签里的特殊字符换掉。
 *
 * Mermaid 的节点标签用双引号包起来时，双引号自身与换行必须转义，
 * 否则整张图渲染失败——那比不显示更糟，因为她会以为记录丢了。
 *
 * @param value - 原始文本。
 * @returns 可安全放进 `["..."]` 的文本。
 */
function mermaidLabel(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .trim()
    .slice(0, 40);
}

/**
 * 渲染 Mermaid 流程图。
 *
 * 节点 = 一条判断链；边 = 依据（指向一个证据节点）或时间顺序（指向上一条）。
 * 依据太多会让图变成毛线球，所以每条记录最多画两条依据边。
 *
 * @param entries - 已过滤、按时间倒序的记录。
 * @param limit - 最多画多少个判断节点。
 * @returns `{ nodes, edges, mermaid }`。
 */
export function renderMermaid(entries, limit) {
  const picks = (Array.isArray(entries) ? entries : []).slice(0, Math.max(1, Number(limit) || 30));
  if (picks.length === 0) return { nodes: 0, edges: 0, mermaid: '' };

  const lines = ['graph LR'];
  const nodeIds = [];
  let edgeCount = 0;

  picks.forEach((entry, index) => {
    const id = `N${index}`;
    nodeIds.push(id);
    lines.push(`  ${id}["${mermaidLabel(`[${shortDate(entry.ts)}] ${titleOf(entry)}`)}"]`);
  });

  // 时间顺序边：新的指向旧的（读起来是"从这条追到上一条"）
  for (let i = 1; i < nodeIds.length; i += 1) {
    lines.push(`  ${nodeIds[i]} --> ${nodeIds[i - 1]}`);
    edgeCount += 1;
  }

  // 依据边
  picks.forEach((entry, index) => {
    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    evidence.slice(0, 2).forEach((item, evIndex) => {
      if (typeof item !== 'string' || item.trim() === '') return;
      const evId = `E${index}_${evIndex}`;
      lines.push(`  ${evId}["${mermaidLabel(item)}"]`);
      lines.push(`  ${nodeIds[index]} -.->|依据| ${evId}`);
      edgeCount += 2;
    });
  });

  return { nodes: nodeIds.length, edges: edgeCount, mermaid: lines.join('\n') };
}
