---
name: memory-triage-dispatch
description: dsh-chain 海马体碎片归类时使用。用 subagent 当外接分类器（不占主会话上下文、不需要 API key），含 prompt 生成、六条结构校验、落库顺序与五个实测坑。
---

# 海马体归类 · 用子代理分流

## 什么时候用

夜巡报告 §④「海马体待整理」里的**原始片段 > 0 条**时。

**触发点**：`chain_patrol` 的返回，或 `~/.dsh/memories/.chain-<会话前缀>/patrol/<日期>.md` 里那一节。

## 为什么用子代理，而不是自己逐条判

| 做法 | 主会话代价 |
|---|---|
| 自己读 160 条碎片 | 一轮塞十几万 tokens |
| 每条并入 = 一次工具调用 | 每次工具调用都要**重发整份上下文**（实测 ~550k）→ 一天 ≈9.4M |
| **子代理分类** | 它有自己的上下文，读多少碎片都不花你的；回来只给一张表 |
| 外接 HTTP API | 也能做，但**要 key**；子代理零配置 |

> **口径**：成本 = 调用次数 × 每次上下文大小。**先砍次数，再谈别的。**

## 五步流程

### 第 1 步 · 生成 prompt（唯一真相源，别手抄）

prompt 写在 `lib/triage.js` 的 `buildTriagePrompt()`。**手抄会漂**，直接调用它：

```bash
cd ~/.dsh/plugins/dsh-chain-shared && node --input-type=module -e "
import { loadAll } from './lib/store.js';
import { buildTriagePrompt } from './lib/triage.js';
const live = (loadAll()?.entries || []).filter(e => e.pool === 'hippocampus' && !e.superseded);
const frags = live.map(e => ({ id: e.id, text: [e.judgement, e.conclusion, ...(e.evidence||[]), ...(e.hesitation||[])].filter(x => typeof x === 'string' && x.trim()).join('\n'), ageDays: 0, pool: 'hippocampus' }));
console.error('碎片数:', frags.length);
console.log(buildTriagePrompt(frags));
"
```

**输出就是完整 prompt**。碎片数如果是 0，说明没事可做，停。

### 第 2 步 · spawn 子代理

- 用 `subagent`，**`run_in_background: false`**（要立刻拿结果才能继续）
- prompt = 第 1 步的输出**原文** + 结尾加一句：
  `再次强调：只输出 JSON，不要任何其它字符、不要 Markdown 代码块。`
- **子代理看不到你的会话** —— 碎片必须全在 prompt 里，别写「就是上面那些」

### 第 3 步 · 结构校验（六条，缺一不可）

| # | 判据 | 不过怎么办 |
|---|---|---|
| 1 | 输出每个 id 都出现在输入里 | 有越界 id → 整组作废重跑 |
| 2 | 每个输入 id **恰好覆盖一次** | 有漏/重 → 补跑缺的 |
| 3 | `branch` ∈ append/merge/retire/keep | 非法 → 该组转 keep |
| 4 | `branch=append` 必须有 `draft`，且 `evidence` 非空 | 缺 → 该组转 keep |
| 5 | `reason` ≤60 字、`label` ≥2 字 | 超长 → 自己缩 |
| 6 | `draft.pool` 是合法池名 | 非法 → 自己定 |

### 第 4 步 · 逐条核 conclusion（**这一步不能省**）

**子代理最容易犯的错是把「两个因子」写成「集中在某一个」**。逐条读，重点核这三类句子：

| 句式 | 要核什么 |
|---|---|
| 「集中在 A 而非 B」 | 是不是 A × B 两个乘数？ |
| 「证明了 / 说明」 | 有没有反例？样本够不够？ |
| 任何数字 | 是不是从输入里抄的，还是它自己算的 |

**发现的错要自己改写，并在回报里写清改了什么** —— 别悄悄改。

### 第 5 步 · 落库（顺序不能换）

```
① chain_append       逐条写 append 的（一次一条，拿新 id）
② chain_touch        set-pool 逐条（append 没有 pool 参数，必须补）
③ chain_touch        ids:[...] outcome:'superseded' —— retire 的**一次批量退**
④ merge 的           set-pool 到目标池，或按需 tag
⑤ keep 的            留着不动（3 天自然过期）
```

## 五个坑（全踩过）

1. **`chains.jsonl` 是事件流，不是状态表。** 直接 `JSON.parse` 每一行再按 `pool === 'hippocampus'` 筛，**会拿到 0 条**（实测 1499 行里匹配 0 行）。必须 `store.loadAll()` 折叠后再筛。
2. **`chain_append` 没有 `pool` 参数。** 传了会被**静默忽略**，条目落在 hippocampus。必须 append 后再 `chain_touch set-pool`。
3. **子代理会保守。** 它宁可给 `keep`（交人）也不硬判 —— 这是**设计如此**，不是错。别为了「全自动」去压它。
4. **子代理会写错归因句。** 见第 4 步。它写的 conclusion 一个字都不许直接信。
5. **绝不让子代理写库。** prompt 里明写「只输出 JSON」；落库永远是主会话自己调工具。

## 验证

- **落库前**：`node tools/triage-dryrun.mjs --limit 10`（外接 HTTP 接口，需 `TRIAGE_BASE_URL/API_KEY/MODEL`）。没 key 时它会打印 `selected=N` 然后 exit 1 —— **`selected` 应该等于当前活着的海马体条数**，这一条就能证明选片逻辑没坏。
- **落库后**：`chain_patrol` 重跑，§④ 应为「判断 0 条 · 原始片段 0 条」。

## 一个前提（别忘）

**碎片会一直涨** —— 她每说一句话就多一条。所以这套流程是**定期清，不是一劳永逸**。想根治得改入口（她的话不默认落海马体），那是另一件事。
