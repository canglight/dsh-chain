/**
 * 决策层（走线）：从检索命中出发，走一跳，把「由 1 想到 2」做出来。
 *
 * ## 为什么需要这个
 *
 * 检索层回答的是「这句话让我想起哪几条」。但记忆不是孤岛 ——
 * 想起 A 的时候，往往 B 也该跟着亮（它们共享同一个罕见的细节）。
 *
 * 实测缺这条的后果：注入永远是"命中那条 + 它的邻居全靠人肉翻"，
 * 而人肉翻这件事，agent 自己不会做。
 *
 * ## 为什么只走一跳
 *
 * 走两跳会扩散成噪声：A 连 B、B 连 C，但 A 和 C 可能毫无关系。
 * **这是用户 定的规矩（2026-10-30）：跳数放开 = 噪声，别自作主张。**
 *
 * ## 边从哪来
 *
 * 现在库里没有 `related` 边，所以用**临时边**：
 * 两条记忆共享「罕见词」（文档频率 df ≤ 2），且那个词经得起词形检查。
 *
 * 思路复用 `patrol.js` 的稀有词配对（那套词形过滤是踩过坑的：
 * 2–8 字滑窗会切出「的鱼审出来的六条」这种"稀有但不像词"的碎片）。
 *
 * ## 边界（写死在实现里）
 *
 * - **纯函数**：不读盘、不写盘、不调模型、不 import 宿主
 * - **不改权重**：只出结果，权重归 store 层管
 * - **每条新增节点必须带 why**：这一行会直接进注入给人看，
 *   所以 why 要写成「共享「xxx」」，不是「相似度 0.83」
 *
 * @module dsh-chain-shared/trace
 */

/** 常见虚词 —— 与 patrol.js 同源，不当作"关键词"。 */
const STOP = new Set([
  '这个', '那个', '这些', '那些', '不是', '就是', '可以', '应该', '一个', '什么',
  '怎么', '因为', '所以', '但是', '而且', '如果', '已经', '还有', '没有', '我们',
  '你们', '他们', '自己', '时候', '现在', '之前', '之后', '东西', '事情', '问题',
  '的话', '一样', '这样', '那样', '知道', '觉得', '需要', '直接', '还是', '一下',
  '这里', '那里', '以及', '对于', '关于', '不会', '不能', '不要', '一定', '其实',
]);

/**
 * 虚字 —— 词的首尾出现即判"不像词"。
 *
 * 与 patrol.js 的 EDGE_STOP 同源。那边注释写得很清楚：
 * 「df≤2 只按频次筛，挡不住这些 —— 它们确实稀有，但不像词」。
 */
const EDGE_STOP = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '很', '我', '你', '他', '她', '它',
  '后', '前', '上', '下', '里', '外', '中', '时', '要', '把', '被', '给', '让', '这', '那',
  '有', '没', '不', '会', '能', '想', '说', '做', '看', '再', '又', '还', '而', '但', '吗',
  '呢', '吧', '啊', '呀', '么', '个', '些', '过', '着', '得', '地', '一', '两', '几',
  // ⚠️ 2026-10-30 实测补的：下面这些漏了，于是「之间」「才真」这类碎片
  //    在真库上被当成"桥"，why 写出来是「共享「之间」」—— 给人看是废的。
  '之', '才', '真', '更', '最', '太', '挺', '非', '啥', '怎', '何', '若', '则', '且', '或',
  '及', '等', '同', '所', '以', '为', '着', '于', '由', '从', '向', '对', '当', '想', '像',
]);

/**
 * 切出候选词：2–8 字滑窗，去停用词。
 *
 * 与 patrol.js 的 wordsOf 逐行一致 —— 刻意重复而不是 import，
 * 因为决策层要能**单独被测**（patrol 那套带着文件 IO，import 进来就不纯了）。
 *
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
 * 一个"滑窗片段"像不像词。
 *
 * @param w - 候选词。
 * @returns 像不像。
 */
function isWordShaped(w) {
  const s = String(w ?? '');
  if (s.length < 2) return false;
  if (EDGE_STOP.has(s[0]) || EDGE_STOP.has(s[s.length - 1])) return false;
  // 整条都是虚字 → 不像词（如「的就是」「也就」）
  if ([...s].every((ch) => EDGE_STOP.has(ch))) return false;
  return true;
}

/**
 * 只保留**极大词**：任何是别人子串的都丢掉。
 *
 * 滑窗会把「不等于能启动」拆成「不等于能启」「等于能启动」等一堆子串，
 * 于是同一件事显示四遍。这条也是从 patrol.js 抄的。
 *
 * @param words - 词集合（数组或 Set）。
 * @returns 极大词数组，长的在前。
 */
function maximalWords(words) {
  const sorted = [...words].sort((x, y) => y.length - x.length || x.localeCompare(y));
  const out = [];
  for (const w of sorted) {
    if (!out.some((kept) => kept.includes(w))) out.push(w);
  }
  return out;
}

/**
 * 这条记忆的可读文本（判词 + 结论）。
 *
 * @param entry - 记忆条目。
 * @returns 拼好的文本。
 */
function textOf(entry) {
  return `${entry?.judgement ?? ''} ${entry?.conclusion ?? ''}`.trim();
}

/**
 * 从检索命中出发走线。
 *
 * @param hits - 检索命中，`Array<{ entry, score?, bestWord? }>`。
 *   **只读 `hit.entry`**，其余字段不参与决策（那是检索层的排序依据）。
 * @param entries - 全库记忆（用来查"这一跳能连到谁"）。
 *   `Array<{ id, judgement, conclusion, superseded? }>`
 * @param opts - `{ maxHop = 1, maxNodes = 6, minShared = 0 }`
 *
 *   `minShared`：hits 里**任何一个**命中的二元组重合数达到它才走线，
 *   否则返回 `stopped: 'noEdge'`。默认 0 = 不启用。
 *
 *   ⚠️ **为什么不用 `score` 当门槛（2026-10-30 实测，这条要留住）：**
 *   我第一版写的是 `minScore`，拿 `hit.score` 判"够不够相关"。跑真库发现
 *   **三个查询（原话 / 换说法 / 完全无关）的 topScore 全是 0.0328** —— 因为
 *   RRF 分数是 `1/(60+名次)` 的累加，**第一名恒等于这个值**，它表达的是
 *   "排第几"，不是"有多相关"。拿它当阈值 = 拿排名当相关性 = 类别错误。
 *
 *   `shared`（查询的字符二元组有多少落在这条记忆里）才是词面证据量，
 *   这个数才会随"真相关 / 碰巧撞词"而变化。
 * @returns `{ nodes, edges, stopped }`
 *   - `nodes: Array<{ id, hop, why }>` — hop 0 = 直接命中，1 = 走一跳
 *   - `edges: Array<{ from, to, via }>` — via 是连起来的词
 *   - `stopped` — `'maxHop' | 'noEdge' | 'budget' | 'empty'`
 *
 * @example
 * trace(rankEntriesRRF(list, '空转'), list)
 * // → { nodes: [{ id: 'c_abc', hop: 0, why: '直接命中' }, ...],
 * //      edges: [{ from: 'c_abc', to: 'c_xyz', via: '空转' }],
 * //      stopped: 'noEdge' }
 */
/**
 * ⚡ **词表与 df 的缓存**（2026-10-30，她审出来的性能问题）。
 *
 * 原来每轮注入都要对全库条目做 2–8 字滑窗 + 统计一遍 df，
 * 复杂度 O(n × 长度²) —— 几百条还行，上千条就会拖慢每一轮对话。
 *
 * 缓存键用**内容签名**而不是数组引用：entries 每轮都是新数组，
 * 但库没变时签名相同，就能复用。签名 = 条数 + 首/中/尾三条的 id。
 */
let DF_CACHE = null;

function dfSignature(entries) {
  const n = entries.length;
  if (n === 0) return '0';
  const mid = entries[Math.floor(n / 2)]?.id ?? '';
  return n + '|' + (entries[0]?.id ?? '') + '|' + mid + '|' + (entries[n - 1]?.id ?? '');
}

export function trace(hits, entries, opts = {}) {
  const maxHop = Number.isFinite(Number(opts?.maxHop)) ? Number(opts.maxHop) : 1;
  // maxHop 目前只支持 1（跳数放开会扩散成噪声，这是她定的规矩）。
  // 传更大的值不报错，但**每个返回点都带上 truncated 标记**，别让人以为它生效了。
  const truncatedFlag = maxHop > 1 ? { truncated: true } : {};
  const maxNodes = Math.max(1, Number.isFinite(Number(opts?.maxNodes)) ? Number(opts.maxNodes) : 6);
  const minShared = Number.isFinite(Number(opts?.minShared)) ? Number(opts.minShared) : 0;

  const nodes = [];
  const edges = [];
  const seen = new Set();

  // ── 词面证据闸门：任何一条命中的二元组重合数够格才走线 ──────
  //
  // 只在调用方显式传了 minShared > 0 时生效。默认 0 表示"检索层说命中就算命中"，
  // 决策层不替检索层判断相关性（那是它的地盘，见文件头）。
  //
  // 注意这里用 **any** 而不是 max-of-score：score 是排名分（第一名恒 0.0328），
  // 用它判相关性是类别错误 —— 这条是 2026-10-30 在真库上撞出来的。
  const hitList = Array.isArray(hits) ? hits : [];
  if (minShared > 0 && hitList.length > 0) {
    const ok = hitList.some((hit) => Number(hit?.shared) >= minShared);
    if (!ok) {
      return { nodes: [], edges: [], stopped: 'noEdge' };
    }
  }

  // ── 种子：检索命中，hop 0 ──────────────────────────────
  //
  // ⚠️ **2026-10-30 修（目标会话复核）**：原来这里一满 maxNodes 就 `return 'budget'`。
  // 命中 8 条、maxNodes=6 时，**6 个名额全被 hop-0 吃光，走线一次都没跑** ——
  // 表现是 nodes=6 / edges=0 / stopped='budget'，三个查询全中，我复现不到"3 条边"。
  // 现在**种子最多占 maxNodes-1，且不超过 3**：名额必须先留给"自己走出来的那一跳"，
  // 否则这一层名字叫决策层，实际只做了个截断。
  const seedCap = Math.max(1, Math.min(3, maxNodes - 1));
  const seeds = [];
  for (const hit of hitList) {
    const entry = hit?.entry;
    if (!entry || entry.id == null) continue;
    const id = String(entry.id);
    if (seen.has(id)) continue;
    if (entry.superseded === true) continue; // 被取代的不再参与走线
    seen.add(id);
    seeds.push(entry);
    nodes.push({ id, hop: 0, why: '直接命中' });
    if (seeds.length >= seedCap) break;
  }

  // 一条都没命中 → 不是"连不上"，是"没起点"
  if (seeds.length === 0) {
    return { nodes, edges, stopped: 'empty', ...truncatedFlag };
  }

  // 只走一跳（这是规矩，不是配置 —— maxHop 大于 1 也只走一跳并明确记录）
  if (maxHop < 1) {
    return { nodes, edges, stopped: 'maxHop', ...truncatedFlag };
  }

  // ── 建词表与 df ───────────────────────────────────────
  const pool = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && e.id != null && e.superseded !== true,
  );
  const byId = new Map(pool.map((e) => [String(e.id), e]));

  // 缓存命中就用旧的 wordsById / df，否则重算一遍并存起来。
  const sig = dfSignature(pool);
  if (DF_CACHE === null || DF_CACHE.sig !== sig) {
    const wordsById = new Map();
    for (const entry of pool) {
      wordsById.set(String(entry.id), new Set(wordsOf(textOf(entry))));
    }
    const df = new Map();
    for (const ws of wordsById.values()) {
      for (const w of ws) df.set(w, (df.get(w) || 0) + 1);
    }
    DF_CACHE = { sig, wordsById, df };
  }
  const { wordsById, df } = DF_CACHE;

  /**
   * 这条记忆的"能当桥"的词集。
   *
   * ⚠️ 2026-10-30 实测修正：**df 必须恰好落在 2~3，不是 df ≤ 2。**
   *
   * 这是第一版写错的地方，值得留在这里说明：
   * 真库 343 条、词表 29153 个，其中 **df=1 的有 27746 个（95.2%）**、
   * df=2 的只有 931 个。因为 `wordsOf` 是 2–8 字滑窗，几乎每个长片段都只
   * 出现在它自己那一条里 —— **df=1 的词在别的条目里根本不存在，永远连不上**。
   *
   * 把 df ≤ 2 当"稀有"，等于把「永远连不上」和「恰好两条共享」混成一堆，
   * 实测三个查询全都 `edges = 0`。**能当桥的只有 df ∈ [2, 3] 的词。**
   *
   * @param id - 条目 id。
   * @returns 可当桥的词集合。
   */
  const rareOf = (id) => {
    const ws = wordsById.get(id);
    if (!ws) return new Set();
    return new Set(
      [...ws].filter((w) => {
        const d = df.get(w) || 0;
        // 只出现在一条里的词连不上任何东西；出现太多的词不叫"桥"。
        if (d < 2 || d > 3) return false;
        if (!isWordShaped(w)) return false;
        return w.length >= 3 || d === 2;
      }),
    );
  };

  // ── 走一跳：**每个种子都参与**，名额轮转分配 ────────────────
  //
  // ⚠️ 2026-10-30 她审出来的第二条：原来只用 seeds[0] 走线，
  // 后面命中的种子完全不参与 —— 如果第一条只是弱相关，走出来的邻居会全错。
  // 现在：每个种子各自找候选，再**轮流**分配 hop-1 名额；
  // 多个种子时 why 里标明「从第 N 条出发」，让人看得出这条线是谁牵的。
  const multiSeed = seeds.length > 1;
  /** 每个种子的候选：{ seedId, seedIndex, entry, id, words } */
  const candidates = [];
  const seedIds = seeds.map((s) => String(s.id));

  // ⚠️ **性能回归修复**（2026-10-30 她审出来的）：
  // 加多种子时我把 `rareOf(id)` 写进了「种子 × 全库」的双层循环里 ——
  // 于是它被调用 M×N 次，每次还要重新 filter 一遍整份滑窗词集，复杂度从 O(N) 变 O(M×N)。
  // 现在**先把每条的稀有词集算一遍存进 Map**，循环里只做 O(1) 取用。
  // 这一层每轮注入都在跑，量级增长会直接拖慢对话。
  const rareById = new Map();
  for (const entry of pool) {
    const id = String(entry.id);
    rareById.set(id, rareOf(id));
  }
  // seedIds.includes 在循环里也是 O(M)，换成 Set。
  const seedIdSet = new Set(seedIds);

  for (let si = 0; si < seedIds.length; si += 1) {
    const sid = seedIds[si];
    const seedRare = rareById.get(sid) ?? new Set();
    if (seedRare.size === 0) continue;
    for (const entry of pool) {
      const id = String(entry.id);
      if (seen.has(id)) continue;
      if (seedIdSet.has(id)) continue;   // 种子之间不互相连

      const otherRare = rareById.get(id) ?? new Set();
      const shared = [];
      for (const w of seedRare) {
        if (otherRare.has(w)) shared.push(w);
      }
      if (shared.length === 0) continue;

      // 只留极大词 —— 否则「空转」和「空转的」会同时冒出来
      const words = maximalWords(shared);
      if (words.length === 0) continue;

      candidates.push({ seedId: sid, seedIndex: si, entry, id, words });
    }
  }

  if (candidates.length === 0) {
    return { nodes, edges, stopped: 'noEdge', ...truncatedFlag };
  }

  // 排序：共享词越长越优先；同长时该条权重高的优先（但**只影响顺序，不改权重**）
  candidates.sort((a, b) => {
    const la = a.words.join('').length;
    const lb = b.words.join('').length;
    if (lb !== la) return lb - la;
    const wa = Number(a.entry.weight) || 0;
    const wb = Number(b.entry.weight) || 0;
    return wb - wa;
  });

  // ── 组装：名额按种子**轮转**分配 ────────────────────────
  // 不轮转的话，排在前面那条种子的邻居会把名额吃光，第二条种子等于没参与。
  const ordered = [];
  const usedBy = new Set();
  let progressed = true;
  while (ordered.length < candidates.length && progressed) {
    progressed = false;
    for (let si = 0; si < seedIds.length; si += 1) {
      for (const cand of candidates) {
        if (cand.seedIndex !== si) continue;
        if (usedBy.has(cand.seedId + '|' + cand.id)) continue;
        usedBy.add(cand.seedId + '|' + cand.id);
        ordered.push(cand);
        progressed = true;
        break;   // 每个种子每轮只取一条
      }
    }
  }

  for (const cand of ordered) {
    if (nodes.length >= maxNodes) {
      return { nodes, edges, stopped: 'budget', ...truncatedFlag };
    }
    seen.add(cand.id);
    const via = cand.words[0];
    const why = multiSeed ? `共享「${via}」（从第 ${cand.seedIndex + 1} 条出发）` : `共享「${via}」`;
    nodes.push({ id: cand.id, hop: 1, why });
    edges.push({ from: cand.seedId, to: cand.id, via });
  }

  // 走到这里说明候选走完了。**三种收尾要分开**（2026-10-30 她提的）：
  //   · budget —— 名额用满，还有候选没走
  //   · done   —— 想走的都走了，正常结束
  //   · noEdge —— 一条边都没走出来
  // 原来后两种都叫 noEdge，读日志时分不清"没有邻居"和"走完了"。
  let stopped = 'noEdge';
  if (nodes.length >= maxNodes) stopped = 'budget';
  else if (edges.length > 0) stopped = 'done';

  // maxHop 目前只支持 1（跳数放开会扩散成噪声，这是她定的规矩）。
  // 传了更大的值不报错，但**明确标出来**被截断了，别让人以为它生效了。
  return { nodes, edges, stopped, ...truncatedFlag };
}

/**
 * 把一个 trace 结果压成注入用的短句。
 *
 * **只读不改** —— 这个函数是给 format 层调用方便，不承担格式决策
 * （注入长什么样由 format.js 定，那是接线方的地盘）。
 *
 * @param result - `trace()` 的返回值。
 * @returns 形如 `由「空转」想到：c_abc`；无走线时返回空串。
 */
export function traceHint(result) {
  const edges = Array.isArray(result?.edges) ? result.edges : [];
  if (edges.length === 0) return '';
  return edges.map((e) => `由「${e.via}」想到 \`${e.to}\``).join('；');
}
