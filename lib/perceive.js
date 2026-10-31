/**
 * 感知层：每轮给用户这句话打几个数（**只记录，不改行为**）。
 *
 * 由来（2026-10-30）：她说现在最缺的就是感知层 ——
 *   现在所有话走同一条路（进海马体、等夜巡），
 *   于是「这句很急」和「这句只是随口」待遇一样。
 *
 * 所以这一层的产物先只落盘，不参与注入、不改池、不影响任何判断。
 * 跑几天看数据准不准，再决定拿它当谁的依据（工作记忆？池？注入顺序？）。
 *
 * **纯函数 + 纯词表，不调模型**（成本：0；延迟：微秒级）。
 *
 * @module dsh-chain-shared/perceive
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeDir } from './config.js';

/** 感知层日志文件名（在 store 目录下，独立于 chains.jsonl）。 */
const LOG_NAME = 'perceive.jsonl';
/** 日志滚动上限：超过就只留最后 N 行（这是观察数据，不是记忆，不需要历史全留）。 */
const LOG_MAX_LINES = 2000;

/* ════════════ 生活词典（lib/lexicon/daily.zh.txt） ════════════ */

/**
 * 从文件加载生活词典（2026-10-30，她提的"主题太少、也没网络用语"）。
 *
 * 为什么手写会被嫌少、通用词库又会被嫌不准：
 *   · 手写词表覆盖不到网络用语和生活主题；
 *   · 通用大词表会把「菜鸟」「开门」也算日常，误判更多。
 * 所以做成**可编辑的分类词表**：14 个生活主题 + 网语三类极性，一个文件就能扩。
 *
 * **文件缺失时自动退回手写词表** —— 词表是可增强项，不是启动前提。
 */
function loadLexicon() {
  const sets = { life: new Set(), neg: new Set(), pos: new Set() };
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const txt = readFileSync(join(here, 'lexicon', 'daily.zh.txt'), 'utf8');
    let count = 0;
    for (const rawLine of txt.split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const m = line.match(/^([^:]+):([-+0])\s+(.+)$/);
      if (!m) continue;
      const polarity = m[2];
      for (const word of m[3].split(/\s+/)) {
        const w = word.trim();
        if (w.length < 2) continue;
        if (polarity === '-') sets.neg.add(w);
        else if (polarity === '+') sets.pos.add(w);
        else sets.life.add(w);
        count += 1;
      }
    }
    return { life: sets.life, neg: sets.neg, pos: sets.pos, ok: true, count };
  } catch {
    return { life: sets.life, neg: sets.neg, pos: sets.pos, ok: false, count: 0 };
  }
}

const LEXICON = loadLexicon();

/** 把一组词编译成一个正则（长的优先，避免「菜」抢先匹配「菜有点咸」）。 */
function toRegex(set) {
  const words = [...set].filter((w) => w.length >= 2).sort((a, b) => b.length - a.length);
  if (words.length === 0) return null;
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(esc.join('|'), 'g');
}

export function __lexDebug() { return { ok: LEXICON.ok, count: LEXICON.count, life: LEXICON.life.size, neg: LEXICON.neg.size, pos: LEXICON.pos.size }; }

const LIFE_RE = toRegex(LEXICON.life);
const NEG_RE = toRegex(LEXICON.neg);
const POS_RE = toRegex(LEXICON.pos);

/**
 * **技术词抑制**：出现这些词时，"日常"要打折。
 * 技术讨论里也会出现「装」「修」「跑」「重启」这类生活动词，
 * 不打折的话一场排障会被记成一串日常。
 */
const TECH_SUPPRESS = /报错|依赖|编译|安装|接口|函数|代码|插件|回调|配置|部署|重构|日志|端口|进程|请求|字段|参数|仓库|提交|合并|用例/;

/** 用词典数命中，返回 { life, neg, pos, tech } 四个计数。 */
function lexiconHits(text) {
  const s = String(text ?? '');
  const n = (re) => (re === null ? 0 : (s.match(re) || []).length);
  return { life: n(LIFE_RE), neg: n(NEG_RE), pos: n(POS_RE), tech: TECH_SUPPRESS.test(s) ? 1 : 0 };
}

/* ════════════ 词表（全部可调，没有黑箱） ════════════ */

/** 任务/指令类：她要我做事。 */
const TASK_WORDS = /帮我|给我|改|修|做|写|跑|装|查|看下|看看|试|整理|合并|删|加|补|准备|提交|推送|重启|验证|测|对比|分析|实现|移植|接上|接线/;
/** 决定/结论类：定下来的事，值得记。 */
const DECISION_WORDS = /就这|定了|决定|以后|从今|规则|规矩|原则|不要|禁止|必须|改成|换成/;
/** **生活细节**（2026-10-30 她点出来的）：吃饭、天气、宿舍、课程这些。
 *  它们不是噪声 —— 它们正是「日常」该记的东西。我原来拿「今天食堂的菜有点咸」当
 *  "无关查询"的样本，那个框本身就是错的：**检索上无关 ≠ 生活上无关**。 */
const LIFE_WORDS = /食堂|外卖|好吃|难吃|菜有点|有点咸|有点辣|排队|宿舍|室友|教室|上课|下课|下雨|天气|期末|放假|回家|洗澡|空调/;
/** 提问类。 */
const QUESTION_WORDS = /吗|呢|？|\?|怎么|为什么|为啥|能不能|可不可以|是不是|有没有|哪|如何/;
/** 情绪：负。 */
const NEG_WORDS = /烦|累|困|难过|委屈|气|崩|麻|糟|痛|怕|焦虑|乱|不想|算了|失败了|错了|不行|难受|无语|心累/;
/** 情绪：正。 */
const POS_WORDS = /好耶|太好了|开心|舒服|不错|厉害|牛|漂亮|喜欢|爱|谢|哈哈|嘿嘿|搞定|成了|稳|可以|满意/;
/** 时效：此刻/立刻。 */
const NOW_WORDS = /现在|马上|立刻|赶紧|急|马上要|待会|等会|一会儿/;
/** 时效：未来/长期。 */
const LATER_WORDS = /明天|后天|下周|以后|将来|过几天|月底|长期|最终/;
/** **她自己的项目词汇** —— 出现这些词，说明这句在讲正事（哪怕全是名词）。 */
const CONCEPT_WORDS = /感知|决策|元记忆|记忆|检索|节点|连线|联想|注入|池|夜巡|压缩|人格|设定|插件|记忆球|工作记忆|长期|情绪|星云|可视化|分诊|生命周期/;
/** 列举/结构：一句里有 2 个以上分隔符，多半是在列东西（这种句子信息密度高）。 */
const ENUM_SPLIT = /[，、;；]/g;
/** 祈使：开头就是动词，说明她在派活。 */
const IMPERATIVE = /^(直接|先|别|不要|给我|帮|去|把|继续|马上|赶紧|停|改|做|看|查|跑|装|写)/;

/** 语气尾巴（她的习惯：zwz / zwx / xwx / 嗷 / 嘛）—— 只算“随口”，不算内容。 */
const TONE_TAIL = /(zwz|zwx|xwx|=w=|TAT|嗷|嘛|呀|吧|哦|嗯|诶|嘿)\s*$/i;

/** 计数：命中几个不同模式。 */
function hits(text, re) {
  const m = String(text ?? '').match(new RegExp(re.source, 'g'));
  return m ? m.length : 0;
}

/**
 * 给一句话打四个数。**纯函数**：同样输入永远同样输出，不读磁盘、不看时间。
 *
 * @param text - 用户这一轮说的话（原文）。
 * @param context - 可选上下文：`{ prevKind }`（上一轮的类型，用于「连续提问」之类）。
 * @returns 四个数 + 命中的证据（便于回头看「它凭什么这么判」）。
 */
export function perceive(text, context = {}) {
  const raw = String(text ?? '').trim();
  const evidence = [];

  if (raw === '') {
    return {
      kind: 'empty', importance: 0, mood: 0, urgency: 0, length: 0, evidence: ['空输入'],
    };
  }

  const task = hits(raw, TASK_WORDS);
  const decision = hits(raw, DECISION_WORDS);
  const question = hits(raw, QUESTION_WORDS);
  const neg = hits(raw, NEG_WORDS);
  const pos = hits(raw, POS_WORDS);
  const now = hits(raw, NOW_WORDS);
  const later = hits(raw, LATER_WORDS);
  const tone = TONE_TAIL.test(raw) ? 1 : 0;
  const concept = hits(raw, CONCEPT_WORDS);
  const enumCount = (raw.match(ENUM_SPLIT) || []).length;
  const imperative = IMPERATIVE.test(raw) ? 1 : 0;
  // 她的语气词是"状态"的主要载体：huh / emmm / 哎 / 嗯 / 呜 / 诶 —— 这些不是内容，是温度
  const sigh = (raw.match(/huh|emmm|哎|唉|嗯+|呜|诶|额|哦豁|草/gi) || []).length;
  // **鱼群消息不是她说的**：`【其他代理 → 目标会话 …】` 这种要单独标出来，不能算她的分
  const fromFish = /^【[^】]*→/.test(raw) || /^【[^】]*号鱼/.test(raw);
  if (fromFish) {
    return { kind: 'fish', importance: 0, mood: 0, urgency: 0, length: raw.length, evidence: ['鱼群消息，不是她说的'] };
  }

  // ---- kind：谁占上风就是谁；都占就 mixed ----
  // 词典命中（14 个生活主题 + 网语极性），与手写词表取并集。
  const lex = lexiconHits(raw);
  const lifeRaw = Math.max(hits(raw, LIFE_WORDS) > 0 ? 1 : 0, lex.life > 0 ? lex.life : 0);
  const negAll = neg + lex.neg;
  const posAll = pos + lex.pos;
  // 技术词抑制：出现了技术词，一场排障不该被记成日常。
  const life = lex.tech === 1 ? 0 : lifeRaw;
  const scores = { task, decision, question, emotion: negAll + posAll, daily: life };
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  let kind;
  if (top[1] === 0) kind = 'chat';
  else {
    const tied = Object.values(scores).filter((v) => v === top[1]).length;
    kind = tied > 1 ? 'mixed' : top[0];
  }
  if (kind !== 'chat') evidence.push(`kind=${kind}(${top[0]}×${top[1]})`);

  // ---- importance：决定 > 任务 > 情绪 > 闲聊 ----
  // 用"有上限的累加"而不是直接加权求和，避免长句靠词多混过去。
  let importance = 0;
  const addImp = (n, why) => { if (n > 0) { importance += Math.min(0.35, 0.15 * n); evidence.push(`+${Math.min(0.35, 0.15 * n).toFixed(2)} ${why}`); } };
  addImp(decision, '决定词');
  addImp(task, '任务词');
  if (kind === 'emotion') addImp(1, '情绪句');
  if (kind === 'daily') { importance += 0.2; evidence.push('+0.20 生活句'); }
  if (concept > 0) { const v = Math.min(0.3, 0.1 * concept); importance += v; evidence.push('+' + v.toFixed(2) + ' 概念词×' + concept); }
  if (enumCount >= 2) { importance += 0.15; evidence.push('+0.15 列举结构'); }
  if (imperative === 1) { importance += 0.1; evidence.push('+0.10 祈使开头'); }
  if (raw.length >= 40) { importance += 0.1; evidence.push('+0.10 长句'); }
  if (tone === 1 && raw.length < 12) { importance -= 0.1; evidence.push('-0.10 短语气句'); }
  importance = Math.max(0, Math.min(1, Number(importance.toFixed(2))));

  // ---- mood：-1..1，负向优先（宁可判低，不要判错成开心） ----
  let mood = 0;
  let intensity = 0;
  if (negAll === 0 && posAll === 0 && sigh > 0) {
    // 只叹气、没有明确情绪词 —— 给一个"浅负"，不是 0（她一半的状态都在这种句子里）
    intensity = Number(Math.min(0.5, 0.15 * sigh).toFixed(2));
    mood = Number((-(1) * intensity).toFixed(2));
    evidence.push('浅负(叹气×' + sigh + ')');
  } else if (negAll > 0 || posAll > 0) {
    const polarity = (posAll - negAll) / Math.max(1, posAll + negAll);
    intensity = Number(Math.min(1, (posAll + negAll) / 3).toFixed(2));
    mood = Number((polarity * intensity).toFixed(2));
    evidence.push(`mood(${posAll}正/${negAll}负 · 强度${intensity})`);
  }

  // ---- urgency：此刻/立刻才高；未来词会压低 ----
  let urgency = 0;
  if (now > 0) { urgency += Math.min(0.6, 0.3 * now); evidence.push(`此刻×${now}`); }
  if (later > 0 && now === 0) { urgency -= 0.15; evidence.push('未来词'); }
  if (question > 0) { urgency += 0.1; evidence.push('提问'); }
  if (imperative === 1) { urgency += 0.3; evidence.push('祈使'); }
  urgency = Math.max(0, Math.min(1, Number(urgency.toFixed(2))));

  void context;
  return { kind, importance, mood, intensity, urgency, length: raw.length, evidence };
}

/** 感知日志的路径。 */
export function perceivePath() {
  return join(storeDir(), LOG_NAME);
}

/**
 * 把一次感知结果追加进日志（**只写不读**，且不阻塞）。
 *
 * 滚动规则：文件超过 LOG_MAX_LINES 行就重写成最后一半 —— 这是观察数据，
 * 不是记忆，不需要留历史；但也不能无限涨。
 *
 * @param sessionId - 会话 id（只存前 8 位，够区分鱼，不多占）。
 * @param text - 用户原话（截断 80 字）。
 * @param point - `perceive()` 的返回值。
 * @returns 写入的行数（1=写了，0=没写）。
 */
/** 去重窗口：注入段一轮里可能被渲染多次（实测同一句记了 4 遍，2026-10-30）。 */
const RECENT_LOGGED = new Map();
const RECENT_WINDOW_MS = 120 * 1000;

export function logPerceive(sessionId, text, point) {
  try {
    const dir = storeDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, LOG_NAME);
    // 同一句话 2 分钟内只记一次 —— 回调被重复调用时不该产生重复行。
    const dedupeKey = String(text ?? '').replace(/\s+/g, ' ').slice(0, 80);
    const nowMs = Date.now();
    const lastAt = RECENT_LOGGED.get(dedupeKey);
    if (lastAt !== undefined && nowMs - lastAt < RECENT_WINDOW_MS) return 0;
    RECENT_LOGGED.set(dedupeKey, nowMs);
    if (RECENT_LOGGED.size > 200) {
      for (const [k, ts] of RECENT_LOGGED) {
        if (nowMs - ts > RECENT_WINDOW_MS) RECENT_LOGGED.delete(k);
      }
    }
    const row = {
      ts: new Date().toISOString(),
      sid: String(sessionId ?? '').replace(/^session-/, '').slice(0, 8),
      text: String(text ?? '').replace(/\s+/g, ' ').slice(0, 80),
      kind: point.kind,
      importance: point.importance,
      mood: point.mood,
      urgency: point.urgency,
      length: point.length,
    };
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
    // 滚动（低频：只在偶数行时检查一次，省 IO）
    try {
      const size = statSync(path).size;
      if (size > 512 * 1024) {
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
        if (lines.length > LOG_MAX_LINES) {
          writeFileSync(path, lines.slice(-Math.floor(LOG_MAX_LINES / 2)).join('\n') + '\n', 'utf8');
        }
      }
    } catch { /* 滚动失败不影响主流程 */ }
    return 1;
  } catch {
    return 0;
  }
}

/**
 * 读最近 N 条感知日志（给工具/调试用）。
 *
 * @param limit - 最多几条（默认 30）。
 * @returns 最新在前的数组。
 */
export function readPerceiveLog(limit = 30) {
  try {
    const path = perceivePath();
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, limit)).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/* ════════════ 按「单条」感知，不按合并文本（2026-10-30） ════════════ */

/**
 * 把用户这一轮的文字拆成**能单独感知的单位**。
 *
 * 为什么需要：DSH 会把她连发的几句话合并成一条消息（实测看到
 * 「试试吧 对了视频火了zw 「今天食堂的菜有点咸」这类也算日常吧zwz」挤在一行里）。
 * 拿整段去做判定，重要度和情绪都被稀释 —— 一句「重启了」会跟一句架构讨论平摊。
 *
 * 拆分规则从粗到细，**只做机械切分、不猜语义**：
 *   ① 先删运行时行（Time sampled / Security: / UNTRUSTED 等）；
 *   ② 按换行切；
 *   ③ 单行里再按句末标点（。！？…；）切；
 *   ④ 丢掉太短的碎片（< 4 字）。
 *
 * @param text - 这一轮的拼接文本。
 * @returns 单位数组（最多 6 条，保留原顺序）。
 */
export function splitPerceptionUnits(text) {
  const raw = String(text ?? '');
  if (raw === '') return [];
  const cleaned = raw
    .split('\n')
    .filter((line) => {
      const l = line.trim();
      if (l === '') return false;
      if (/^Time sampled while preparing/.test(l)) return false;
      if (/^Security: /.test(l)) return false;
      if (/^<UNTRUSTED_PAGE_CONTENT/.test(l)) return false;
      if (/^\[user-selected page text\]/.test(l)) return false;
      return true;
    })
    .join('\n');
  // **语气结尾 + 空格**也算一条的结束（2026-10-30）：
  // 她连发短句时 DSH 会把它们空格拼起来，而中文句子里通常没有空格，
  // 所以"空格前一个字是句尾语气/拉丁词"这个位置，基本就是一条消息的边界。
  const ENDS_A_MESSAGE = /([吧呢了啊嘛呀哦嗯哈哟啦]|[A-Za-z]{2,})$/;
  const lines = [];
  for (const line of cleaned.split('\n')) {
    let rest = line;
    let guard = 0;
    while (rest.length > 0 && guard < 8) {
      guard += 1;
      const m = rest.match(/\s+/);
      if (!m || m.index === undefined) { lines.push(rest); break; }
      const left = rest.slice(0, m.index);
      const right = rest.slice(m.index + m[0].length);
      if (left.trim().length >= 2 && right.trim().length >= 3 && ENDS_A_MESSAGE.test(left.trim())) {
        lines.push(left);
        rest = right;
      } else {
        // 这一处空格不是边界 —— 继续往后找下一个空格
        const tail = rest.slice(m.index + m[0].length);
        const m2 = tail.match(/\s+/);
        if (!m2 || m2.index === undefined) { lines.push(rest); break; }
        const cut = m.index + m[0].length + m2.index;
        const l2 = rest.slice(0, cut);
        const r2 = rest.slice(cut + 1);
        if (l2.trim().length >= 2 && r2.trim().length >= 3 && ENDS_A_MESSAGE.test(l2.trim())) {
          lines.push(l2); rest = r2;
        } else { lines.push(rest); break; }
      }
    }
  }

  const parts = [];
  for (const line of lines) {
    for (const seg of line.split(/(?<=[。！？…；])/)) {
      const s = seg.trim();
      if (s.length >= 3) parts.push(s);
    }
  }
  // 纯语气碎片（「zwx」「嗯」「嗷」「zwa」）不当成一条 —— 它没有信息，只会把日志撑乱。
  const TONE_ONLY = /^(zw[a-z]?|xwx|=w=|tat|嗷|嘛|呀|吧|嗯+|哦|诶|嘿|哈+|额|emmm?|huh|啊)+$/i;
  // **先剥掉首尾符号再判断**（2026-10-30 实测）：她发长文时，`---`、`**`、`，纯记忆…`
  // 这类碎片会被切出来；只看"有没有符号"会把 `--- zwa` 当成内容留下来，把统计撑脏。
  const EDGE_SYMBOLS = /^[\s\-–—_=*~`|#>+.,:;!?()（）【】「」『』\[\]"'“”‘’…·，。、；：！？]+|[\s\-–—_=*~`|#>+.,:;!?()（）【】「」『』\[\]"'“”‘’…·，。、；：！？]+$/g;
  const clean = (s) => s.replace(EDGE_SYMBOLS, '').trim();
  const hasContent = (s) => /[\u4e00-\u9fffA-Za-z0-9]/.test(s) && clean(s).length >= 2;
  return parts
    .map(clean)
    .filter((s) => s !== '' && hasContent(s) && !TONE_ONLY.test(s))
    .slice(-6);
}
