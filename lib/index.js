/**
 * dsh-chain —— 思维链记忆。
 *
 * 第一版只做工具（chain_append / chain_recall / chain_graph）。
 * **注入段刻意不在这一版里**：它一旦抛错会拖垮整次 prompt 组装，
 * 所以等工具跑通、数据格式定下来之后再单独加、单独验。
 *
 * @module dsh-chain
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process';
import {
  DEFAULT_TARGET_SESSIONS,
  GRAPH_DEFAULT,
  GRAPH_MAX,
  RECALL_DEFAULT,
  RECALL_MAX,
  SECTION_NAME,
  SECTION_ORDER,
  applyConfig,
  configNumber,
  mergeSettings,
  readSettingsFile,
  isTargetSession,
  storePath,
} from './config.js';
import { createHandler } from './api.js';
import { hasPoolRule, coreIsFull, UNCLASSIFIED_TAG, POOLS, poolDef, poolOf } from './pools.js';
import { buildPatrolReport, writePatrolReport, applyRebalance, localYmd, patrolReportPath, planDailyPromotion } from './patrol.js';
import { initRetrieval, retrievalError, rankEntriesRRF } from './retrieval.js';
import { readWorking, writeWorking, updateWorking, buildWorkingBlock } from './working.js';
import { humanAge, moodStrength, visibleMood, writeMood } from './mood.js';
import { renderInjection, renderMermaid } from './format.js';
import {
  appendChain,
  appendChainEvent,
  cleanList,
  cleanText,
  filterChains,
  loadAll,
} from './store.js';

export const name = 'chain';

/**
 * 依赖的宿主服务。
 *
 * `tools` 用来注册工具；`systemPrompt` 用来注册那段"只对我可见"的注入。
 * 两者在 base 组合里都存在（`--dump-config` 里能看到 `id: system-prompt`，
 * 源码里 `super(ctx, "systemPrompt")`）。**声明一个不存在 provide 的服务会让
 * fiber 停在 PENDING 并拖住整棵插件树**，所以这个列表只放确定存在的。
 */
export const inject = ['tools', 'systemPrompt'];

/**
 * **设置页里能改的参数**（2026-10-29 加）。
 *
 * DSH 的 `dsh-settings` 是 schema 驱动的：插件导出 `Config`，宿主自动生成设置表单
 * （校验 / 修订号 / 密文脱敏都由宿主负责），不用自己写读写文件的代码。
 *
 * 定义在 `config.js` 里（那边的 `applyConfig()` 会把值放进模块级变量，
 * `pools.js` / `format.js` 从那里读覆盖值）。
 */
export { Config } from './config.js';

/** 工具名常量，测试与文档共用一份。 */
export const TOOL_APPEND = 'chain_append';
export const TOOL_RECALL = 'chain_recall';
export const TOOL_GRAPH = 'chain_graph';
export const TOOL_TOUCH = 'chain_touch';
export const TOOL_PATROL = 'chain_patrol';
export const TOOL_MOOD = 'chain_mood';

/**
 * 注册工具与注入段。
 *
 * @param ctx - 宿主上下文（含 tools 与 systemPrompt 服务）。
 * @param config - 插件配置；`targetSessionIds` 可覆盖默认的注入目标。
 */
export function apply(ctx, config) {
  // **先把设置装进运行时**：池寿命 / 注入预算 / 核心上限 / 夜巡时间都从这里读。
  //
  // 三层来源，后者覆盖前者：
  //   ① 代码里的默认值（config.js 的常量）
  //   ② `cordis.patch.yml` 里的 `config:`（部署级）
  //   ③ 用户设置文件 `settings.json`（画布右上角那个齿轮写的）
  //
  // 必须在注册工具与注入段之前调，否则第一轮就用到旧值。
  applyConfig(mergeSettings(config || {}, readSettingsFile()));
  const targets = resolveTargets(config);
  const disposers = [];

  // 索引检索层：**异步加载** jieba（原生模块，约 1.2 MB）+ 通用 IDF 表。
  //
  // 三条硬规矩：
  //   ① **不阻塞 apply** —— 加载要几十到几百毫秒，apply 期间不能等；
  //   ② **失败不抛错** —— 少一个可选依赖不该让插件挂掉（那会连注入一起没了）；
  //   ③ 没就绪时 `format.js` 自动走旧的滑窗匹配。
  try {
    const libDir = dirname(fileURLToPath(import.meta.url));
    const pluginRoot = dirname(libDir);
    initRetrieval(pluginRoot)
      .then((ok) => {
        if (typeof ctx.logger?.info === 'function') {
          ctx.logger.info(ok
            ? '[dsh-chain-shared] retrieval ready (jieba + general idf)'
            : `[dsh-chain-shared] retrieval unavailable, fallback to sliding window: ${retrievalError()}`);
        }
      })
      .catch(() => { /* 连日志都失败就算了，别让这里成为新故障点 */ });
  } catch {
    /* 路径解析失败同样不该影响注册 */
  }

  disposers.push(ctx.tools.register(defineAppendTool({ ctx })));
  disposers.push(ctx.tools.register(defineRecallTool({ ctx })));
  disposers.push(ctx.tools.register(defineGraphTool({ ctx })));
  disposers.push(ctx.tools.register(defineTouchTool({ ctx })));
  disposers.push(ctx.tools.register(definePatrolTool({ ctx })));
  disposers.push(ctx.tools.register(defineMoodTool({ ctx })));

  // 夜巡定时：**每天跑一次，只写报告文件，不改任何记录**。
  //
  // ⚠️ 2026-10-28 12:21 踩过：写 `typeof ctx.setInterval === 'function'` 就会抛
  //    `cannot get property "timer" without inject` —— **连"判断它在不在"这一步都抛**，
  //    于是插件在 apply 阶段直接死掉（5 个工具与注入段全没）。
  //    教训：服务类属性必须先声明才能读，探测也不行。
  //
  // 正解与当初 webServer 那次相同：**局部注入**。
  //   · 服务存在 → 回调里正常注册定时器；
  //   · 服务不存在 → 回调不执行，静默跳过，其它功能一个都不受影响。
  // 不写进插件级 `inject`（服务缺失时会让 fiber 卡 PENDING，拖垮整棵插件树）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['timer'], (timerCtx) => {
      try {
        // **每天 18:00 之后开始总结**（2026-10-28 用户 定）。
        //
        // 原实现是 `setInterval(24h)` —— 从**宿主启动那一刻**开始数，
        // 而用户经常重启电脑/DSH，于是永远到不了 24 小时，夜巡实际上从没跑过（
        // 磁盘上唯一一份报告是手动跑的）。
        //
        // 现在改成「每 10 分钟检查一次'今天该不该跑'」：
        //   · 现在 ≥ 18:00 且今天的报告文件还不存在 → 跑
        //   · 已存在 → 跳过（一天只跑一次，重启也不会重复）
        // 这样重启、休眠、改系统时间都不丢；开机时若已过 18:00，也会立刻补跑。
        const CHECK_EVERY_MS = 10 * 60 * 1000;

        /**
         * 今天该不该跑夜巡。
         *
         * **两个 2026-10-29 修掉的坑**（都是用户审出来的）：
         *   · 原来把 `patrolHour` 在 apply 时就读成闭包常量 → 画布上改完，定时器还拿旧值。
         *     现在**每次检查现读**，改完最多 10 分钟就按新时间走。
         *   · 原来只判断"报告文件在不在" → **一份残缺报告会锁死一整天**（哪怕只有两条记录）。
         *     现在读报告里的「记录总数」，跟链上现有条数比：少太多就补跑一次。
         *     阈值不能用"差一条就重跑"—— 每轮对话都会往海马体写片段，那会变成每 10 分钟跑一次。
         */
        function reportCovered(p) {
          // **优先读机器可读的旁车文件**（2026-10-29）：
          // 原来靠 markdown 正则 /记录总数 \| (\d+)/，报告格式一改就静默失效 ——
          // 那种"静默失效"最难查。现在 patrol 会在报告旁边写 <date>.meta.json，
          // 这里读它；读不到（老版本生成的报告）才退回老正则。
          try {
            const metaPath = p.replace(/\.md$/, '.meta.json');
            if (existsSync(metaPath)) {
              const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
              const total = Number(meta?.total);
              if (Number.isFinite(total)) return total;
            }
          } catch {
            /* 旁车坏了就退回老办法 */
          }
          try {
            const text = readFileSync(p, 'utf8');
            const m = text.match(/记录总数\s*\|\s*(\d+)/);
            return m ? Number(m[1]) : 0;
          } catch {
            return 0;
          }
        }

        function dueToday() {
          const now = new Date();
          const hour = configNumber('patrolHour', 18);   // 现读：设置面板改完立刻生效
          if (now.getHours() < hour) return false;       // 还没到点
          const path = patrolReportPath(localYmd(now));
          try {
            if (!existsSync(path)) return true;          // 今天还没跑过
            const covered = reportCovered(path);
            const total = loadAll().entries.filter((e) => !e.superseded).length;
            const ageMs = now.getTime() - statSync(path).mtimeMs;
            // 覆盖太少（少 20 条以上）且离上次生成已过 2 小时 → 补跑。
            // 加时间闸是为了防止"边跑边写片段"导致的自我循环。
            if (total > covered + 20 && ageMs > 2 * 60 * 60 * 1000) return true;
            return false;
          } catch {
            return false;
          }
        }

        function runPatrol() {
          if (!dueToday()) return;
          try {
            const { entries } = loadAll();
            // **自动归整**：先按规则调权重（只写 rebalance 事件，正文不动），再出报告。
            // 这是整个系统里唯一自己改记忆参数的地方，边界全写在 patrol.js 顶部：
            // 单次 ±0.05、累计 [-0.15, +0.10]、原则上不碰、被取代不碰。
            const { written } = applyRebalance(entries, { maxActions: 20 });

            // **海马体 → 日常**（2026-10-30）：把用户说过的话转进日常池，别让它们到期消失。
            // 判据是词面（patrol.js 的 planDailyPromotion），不调模型；
            // 用 retag 事件原地改池 —— **正文一个字不动**。
            let promoted = 0;
            try {
              const plan = planDailyPromotion(loadAll().entries, { maxPromote: 12 });
              for (const item of plan.promote) {
                try {
                  appendChainEvent({ id: item.id, type: 'retag', pool: item.pool });
                  promoted += 1;
                } catch {
                  /* 单条转池失败不影响其它 */
                }
              }
            } catch {
              /* 计划失败就当这轮没加工 */
            }
            const out = writePatrolReport(loadAll().entries, {});
            if (typeof ctx.logger?.info === 'function') {
              ctx.logger.info(`[dsh-chain-shared] patrol done (rebalanced ${written}, promoted ${promoted}) → ${out.path}`);
            }
            wakeOwner(out.path);
          } catch (error) {
            if (typeof ctx.logger?.warn === 'function') {
              ctx.logger.warn(`[dsh-chain-shared] patrol failed: ${error?.message ?? String(error)}`);
            }
          }
        }

        /**
         * **自动唤醒 —— 叫醒「最近说话的那个会话」**（全会话版，2026-10-29 定）。
         *
         * 与隔离版（私有版）的区别：
         *   · 本版是「整个 DSH 共用一条链」→ 报告属于**所有**会话 → 唤醒**最近说话的**那个
         *     （报告落到谁头上，就看谁最后说话）；
         *   · 隔离版是「一条鱼一套记忆」→ 报告只属于那一条 → 必须叫醒它本人，
         *     绝不能回落到「最近活跃的会话」，否则会叫醒别的鱼去读别人的报告。
         *
         * ⚠️ **本文件曾经在这里犯了错**（用户 2026-10-29 审出来）：把隔离版的实现
         * 一起打了进来 —— `DEFAULT_TARGET_SESSIONS[0]` 在本包恒为 `undefined`
         * （列表是空的），于是 `if (!target) return;` 让这段变成**永远不会执行的代码**，
         * 而 README 还写着"默认唤醒最近说话的会话"。现在改为**不传会话 id**，
         * 由 wake.mjs 自己挑最近的；目标正忙时它会在忙的那个排队/跳过。
         *
         * 为什么 spawn 独立进程：长任务要脱离 DSH 的进程树，否则宿主一重启就被连带杀掉。
         */
        function wakeOwner(reportPath) {
          try {
            // **本包是全会话版：不指定会话**，让 wake.mjs 自己挑「最近说话的那个」。
            // 2026-10-29 修（用户审出来的）：这里原来是隔离版的实现 ——
            // 空列表下 DEFAULT_TARGET_SESSIONS[0] 恒为 undefined → 直接 return，
            // **整段唤醒是永远不会执行的代码**（README 却写着"默认唤醒最近说话的会话"）。
            const script = join(dirname(fileURLToPath(import.meta.url)), 'wake.mjs');
            if (!existsSync(script)) return;
            const message = [
              '夜巡（自动唤醒）：今天的报告已生成 —— ' + reportPath,
              '请**审核**它：「海马体待整理」那节逐条判断 —— 哪些该变成记忆、哪些是一次性的该丢。',
              '把该留的写成候选判断（判断 / 依据 / 犹豫 / 结论），**先列出来等用户点头，不要自己写进链**。',
              '结论压成三行放在回复末尾。',
            ].join('\n');
            const child = spawn(process.execPath, [script, 'prompt'], {
              detached: true,
              stdio: 'ignore',
              env: { ...process.env, WAKE_MESSAGE: message },
              windowsHide: true,
            });
            child.unref();
            if (typeof ctx.logger?.info === 'function') {
              ctx.logger.info('[dsh-chain-shared] patrol wake dispatched (most-recent session)');
            }
          } catch (error) {
            if (typeof ctx.logger?.warn === 'function') {
              ctx.logger.warn(`[dsh-chain-shared] patrol wake failed: ${error?.message ?? String(error)}`);
            }
          }
        }

        // 开机先探一次（给宿主一点启动时间，60 秒后检查；已过 18:00 就补跑）
        if (typeof timerCtx.setTimeout === 'function') {
          const kick = timerCtx.setTimeout(runPatrol, 60 * 1000);
          if (typeof kick === 'function') disposers.push(kick);
        }
        const dispose = timerCtx.setInterval(runPatrol, CHECK_EVERY_MS);
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch {
        /* 定时器注册失败不影响工具与注入 */
      }
    });
  }

  // 注入段：这是整个插件里唯一"会影响每轮请求"的部分，因此在注册处就把闸门设死——
  // 非目标会话返回空串（等于这段不存在），任何异常也返回空串（宁可少一段，
  // 也不让一次读取失败把整轮 prompt 组装打掉）。
  disposers.push(ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: ({ scope }) => {
      try {
        // 海马体：把这一轮的原话丢进缓冲（同一句只写一次；失败不影响注入）。
        // 放在注入之前 —— 万一这里挂了，下一次请求还能补上。
        // ⚠️ **必须先判目标会话，再写缓冲区**（2026-10-29 修）：
        // 原来这一行在 buildInjection 之前无条件执行，而目标会话的判断在后者内部 ——
        // 于是**任何会话的对话都会写进同一个缓冲区**。
        // 单会话版：只有目标会话才写；全会话版：isTargetSession 恒真，行为不变。
        if (isTargetSession(scope?.id, targets)) writeHippocampusFragment(scope);

        // **工作记忆块**（2026-10-29 加）：从她这句话里认出"还没做完的事"。
        // 硬约束：不调用模型（纯正则，每轮都跑）；最多注入 3 条；会过期也会被收尾词删。
        // 它不属于记忆池 —— 存 working.json，不进 chains.jsonl（否则会污染夜巡统计）。
        const said = recentUserText(scope);
        let workingBlock = '';
        try {
          // 写路径必须每个都守卫：不是目标会话就不许改这份工作记忆。
          if (!isTargetSession(scope?.id, targets)) throw new Error('skip:not-target');
          const before = readWorking();
          const after = updateWorking(before, said);
          if (JSON.stringify(after) !== JSON.stringify(before)) writeWorking(after);
          workingBlock = buildWorkingBlock(after);
        } catch (error) {
          if (typeof ctx.logger?.warn === 'function') {
            ctx.logger.warn(`[dsh-chain] working memory failed: ${error?.message ?? String(error)}`);
          }
        }

        const body = buildInjection(scope?.id, targets, said);
        if (body === '') return '';
        return workingBlock === '' ? body : `${workingBlock}\n\n${body}`;
      } catch (error) {
        // 静默失败是最坏的一种：注入没了，而外面没有任何痕迹。
        // 2026-10-28 就是因为这里只 return ''，我查了一小时才发现
        // "根本没法知道它到底在不在" —— 失败必须留声。
        if (typeof ctx.logger?.warn === 'function') {
          ctx.logger.warn(`[dsh-chain-shared] section failed: ${error?.message ?? String(error)}`);
        }
        return '';
      }
    },
  }));

  // Web API：给客户端 tab 提供"可直接画"的图数据。
  //
  // 用 **`ctx.inject(['webServer'], cb)` 局部注入**，三种写法里只有它对：
  //   · 写进插件级 `inject` → 服务不存在时整条 fiber 停在 PENDING，拖住插件树；
  //   · `ctx.get('webServer')` → 实测在 apply 阶段返回 undefined（服务名确实
  //     叫 "webServer"，是时机/作用域问题），第一版就是这么 404 的；
  //   · 局部注入 → 有就回调、没有就不回调，工具与注入照常工作。
  // 写法照 dsh-memory-evolve（它同样要兼容 headless 组合）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        disposers.push(webCtx.webServer.register({ kind: 'prefix', path: '/chain-shared', handler: createHandler() }));
        if (typeof ctx.logger?.info === 'function') ctx.logger.info('[dsh-chain-shared] web api mounted at /chain');
      } catch {
        /* 注册失败不影响工具与注入 */
      }
    });
  }

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 卸载期清理失败不该再抛出去 */
        }
      }
    });
  }

  // 一行启动信息：注入是"看不见"的功能，出问题时这行能确定插件到底装上没有。
  if (typeof ctx.logger?.info === 'function') {
    ctx.logger.info(
      `[dsh-chain-shared] ready; tools=4; section=${SECTION_NAME}@${SECTION_ORDER}; `
      + `targets=${targets.join(',') || '(默认)'}; store=${storePath()}`,
    );
  }
}

/**
 * 把一个字符串包成模型可见的内容块。
 *
 * `output.render` 是**必填**的——缺了会在注册时直接抛
 * `tool "..." must declare output { schema, render, presentationMeta? }`，
 * 整棵插件树随之失效（这个坑第一版踩过，日志里能查到）。工具实际返回值仍是
 * 经过 `schema` 校验的裸对象，这里只负责把它翻译成人能读的那几行。
 *
 * @param text - 要呈现的文本。
 * @returns 单块内容数组。
 */
function textBlock(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

/**
 * 把 ISO 时间裁成 `MM-DD HH:mm`（本地时区），给人看。
 * @param ts - ISO 时间戳。
 * @returns 短时间串。
 */
function shortTime(ts) {
  const parsed = Date.parse(String(ts ?? ''));
  if (!Number.isFinite(parsed)) return '??-?? ??:??';
  const d = new Date(parsed);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 解析配置里的目标会话列表。
 * @param config - 插件配置。
 * @returns 目标会话 id 列表（空数组表示用默认值）。
 */
function resolveTargets(config) {
  const raw = config?.targetSessionIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => typeof item === 'string' && item.trim() !== '');
}

/**
 * `chain_append`：写一条思维链。
 *
 * @param deps - 依赖。
 * @returns 工具定义。
 */
function defineAppendTool(deps) {
  void deps;
  return {
    name: TOOL_APPEND,
    description:
      'Record one thinking-chain entry: the judgement you made, the evidence behind it, ' +
      'what you hesitated about, and why you settled on the conclusion. ' +
      'Use it when a decision actually mattered — not for routine steps. ' +
      'The entry is stored in a private file that only this session can read.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        judgement: {
          type: 'string',
          description: 'The decision itself, one line. What you decided to do.',
        },
        conclusion: {
          type: 'string',
          description: 'Why this option won. Name the tradeoff, not just the outcome.',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Facts that pushed the decision: what she said, what a check showed.',
        },
        hesitation: {
          type: 'array',
          items: { type: 'string' },
          description: 'Alternatives you considered and why you did not take them.',
        },
        weight: {
          type: 'number',
          description: 'How load-bearing this decision is, 0 to 1. Defaults to 0.5. '
            + 'Use 0.8+ for things that should still matter weeks from now.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short labels for later filtering.',
        },
      },
      required: ['judgement', 'conclusion'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          ts: { type: 'string' },
          total: { type: 'integer' },
          storePath: { type: 'string' },
          // 这次写入顺带退役了几条海马体原料（吸收即退役）。
          // ⚠️ 加返回值字段就必须在这里声明 —— 这是第三次栽同一个坑
          //    （rebalance / unclassified / 现在这个），schema 是 additionalProperties:false。
          absorbed: { type: 'integer' },
        },
        required: ['id', 'ts', 'total', 'storePath', 'absorbed'],
      },
      render: (_args, value) => textBlock(
        `已记 <id>${value.id}</id>  [${shortTime(value.ts)}]  共 ${value.total} 条\n`
        + (value.absorbed > 0 ? `顺带退役 ${value.absorbed} 条已吸收的原料\n` : '')
        + `<store>${value.storePath}</store>`,
      ),
    },
    execute: async (args) => {
      const judgement = cleanText(args?.judgement);
      const conclusion = cleanText(args?.conclusion);
      if (judgement === '') throw new Error('judgement must be a non-empty single line');
      if (conclusion === '') throw new Error('conclusion must be a non-empty single line');

      // **核心上限守卫**（2026-10-29）。
      //
      // 用户的原话是「核心层面不再做增加，只保留最主要的"你"」——
      // 但那是针对**用户这份已经写满的**实例说的。**不能无条件锁死**：
      // 别人刚装是白板 DSH，core 是 0 条，一刀切冻结等于永远长不出性格。
      //
      // 所以改成「有上限」：core 到达 CORE_MAX 条之后才拒绝新增。
      //   · 用户的实例：32 条 = 正好满 → 效果等同冻结
      //   · 新装的包：0 条 → 可以一路长到 32 条再停
      // ⚠️ 原来这里**无条件**抛错：core 一满，连"记一条技能教训"都写不进去。
      // 2026-10-29 实测：她这份库 core 32/32 → chain_append 全废，报错还是"要记教训请用教训标签"，
      // 自相矛盾。改成：**只有新条目真的会落进 core 时才拦**。
      const coreFull = coreIsFull(loadAll().entries);
      // 只看"这条会不会落进 core"。未归类条目（标签没命中任何池）落的是**海马体**，
      // 不是 core —— 把它算进来会让 core 满时连带拒绝未归类条目（2026-10-29 修）。
      const wouldBeCore = poolOf({ tags: cleanList(args?.tags) }) === 'core';
      if (coreFull.full && wouldBeCore) {
        throw new Error(
          'core 池已满（' + coreFull.count + '/' + coreFull.max + '）：核心层是"我是谁"，满了就不再增加。'
          + '要立新规矩 → 写进 AGENTS.md（每轮注入、压不掉）；'
          + '要记教训 → tags 用「教训/验证/排障」；要记相处方式 → tags 用「关系/对用户」。',
        );
      }

      // **未归类的要打标注**（2026-10-29 用户定的规则）。
      //
      // 池子决定"这条活多久"，猜错代价不对称：猜成片面日常（7 天）就是真丢；
      // 挂上「未归类」后它落进海马体（原料缓冲区，3 天、永不注入），
      // 由夜巡重点列出来审；同样的内容重复写满 3 次 → 升级「需人工定池」。
      const tags = cleanList(args?.tags);
      if (!hasPoolRule(tags) && !tags.includes(UNCLASSIFIED_TAG)) tags.push(UNCLASSIFIED_TAG);

      const record = appendChain({
        judgement,
        conclusion,
        evidence: cleanList(args?.evidence),
        hesitation: cleanList(args?.hesitation),
        weight: args?.weight,
        tags,
      });
      // **吸收即退役**：这条判断如果覆盖了某条海马体原料，那条原料就没用了。
      // 这解决"重复提交流程"—— 不是禁止重复写，是写完原料自己让位。
      const absorbed = absorbFragments(judgement);
      const total = loadAll().entries.length;

      return { id: record.id, ts: record.ts, total, storePath: storePath(), absorbed };
    },
  };
}

/**
 * `chain_recall`：检索思维链。
 *
 * @param deps - 依赖。
 * @returns 工具定义。
 */
function defineRecallTool(deps) {
  void deps;
  return {
    name: TOOL_RECALL,
    description:
      'Search recorded thinking-chain entries by keyword, start date, or minimum weight. ' +
      'Returns the newest first. Use it when you need to check how you reasoned about ' +
      'something before, instead of reconstructing it from memory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring matched against judgement, conclusion, evidence, hesitation and tags.',
        },
        since: {
          type: 'string',
          description: 'Earliest date to include, YYYY-MM-DD.',
        },
        minWeight: {
          type: 'number',
          description: 'Only entries at or above this weight.',
        },
        limit: {
          type: 'integer',
          description: `Maximum entries to return. Defaults to ${RECALL_DEFAULT}, capped at ${RECALL_MAX}.`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          skippedLines: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                ts: { type: 'string' },
                judgement: { type: 'string' },
                conclusion: { type: 'string' },
                evidence: { type: 'array', items: { type: 'string' } },
                hesitation: { type: 'array', items: { type: 'string' } },
                weight: { type: 'number' },
                tags: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'ts', 'judgement', 'conclusion', 'evidence', 'hesitation', 'weight', 'tags'],
            },
          },
        },
        required: ['count', 'skippedLines', 'entries'],
      },
      render: (_args, value) => {
        const lines = [`<result count="${value.count}" skipped="${value.skippedLines}">`];
        for (const entry of value.entries) {
          lines.push(`- [${shortTime(entry.ts)}] w=${entry.weight} <id>${entry.id}</id> ${entry.judgement}`);
          if (entry.evidence.length > 0) lines.push(`    依据: ${entry.evidence.join(' / ')}`);
          if (entry.hesitation.length > 0) lines.push(`    犹豫: ${entry.hesitation.join(' / ')}`);
          if (entry.conclusion !== '') lines.push(`    结论: ${entry.conclusion}`);
          if (entry.tags.length > 0) lines.push(`    标签: ${entry.tags.join(',')}`);
        }
        lines.push('</result>');
        return textBlock(lines.join('\n'));
      },
    },
    execute: async (args) => {
      const { entries, skipped } = loadAll();
      const limitRaw = Number(args?.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), RECALL_MAX)
        : RECALL_DEFAULT;
      // **排除海马体片段**（2026-10-29）：它们是"待整理的原料"，不是记忆。
      // 不排除的话搜「验证」会命中「再验证bug」这种原话片段，把检索结果淹掉。
      // **按标签排除，不按池**（2026-10-29 修）：池是"活多久"，不是"是不是原料"。
      // 用 poolOf 排除会连带把「待归类判断」（标签没命中任何池 → 落海马体）也排掉，
      // 于是搜关键词搜不到那些判断。只有自动捕获写进来的原话片段带「海马体」标签。
      const recallable = entries.filter((entry) => {
        const tags = Array.isArray(entry?.tags) ? entry.tags : [];
        return !tags.some((tag) => String(tag).includes('海马体'));
      });
      // **RRF 融合检索**（2026-10-29 改）：原来这里是把整句话当子串去搜，
      // 实测 14 条评估查询 Recall@5 = 0% —— 只要不是原话就永远搜不到。
      // 现在：先按日期/权重过滤，再用 RRF 排序；真的排不出东西才退回旧子串逻辑
      // （retrieval 没初始化时，不能把检索整个搞坏）。
      const queryText = typeof args?.query === 'string' ? args.query.trim() : '';
      const ranged = filterChains(recallable, {
        since: args?.since,
        minWeight: args?.minWeight,
      });
      let hits;
      if (queryText === '') {
        hits = ranged.slice(0, limit);
      } else {
        const ranked = rankEntriesRRF(ranged, queryText, { max: limit });
        hits = ranked.length > 0
          ? ranked.map((item) => item.entry)
          : filterChains(ranged, { query: queryText }).slice(0, limit);
      }

      // 被检索到本身不等于「想起了每一条」——判别条件见下面几行。
      // **只有「真的在检索」才算想起**（2026-10-28 外部 review 指出后修）。
      //
      // 原来这行是无条件的：chain_recall({}) 这种「翻目录」会把整库都记成
      // 「被想起过一次」—— touchCount 拉伸半衰期，到 2 次还把「片面日常」
      // 升进「核心日常」（细节窗口 7 天 → 20 天）。读一遍目录就改了记忆结构，那是错的。
      //
      // 现在：① 必须带检索条件（query / since / minWeight）；② delta 用 0
      // —— 被想起只计次数、不涨权重（与索引延伸那条 recordHits 口径一致）。
      const hasQuery = typeof args?.query === 'string' && args.query.trim() !== '';
      const hasSince = typeof args?.since === 'string' && args.since.trim() !== '';
      const hasWeight = Number.isFinite(Number(args?.minWeight));
      if (hasQuery || hasSince || hasWeight) {
        for (const hit of hits) appendChainEvent({ id: hit.id, type: 'touch', delta: 0 });
      }

      return {
        count: hits.length,
        skippedLines: skipped,
        entries: hits.map((entry) => ({
          id: String(entry.id),
          ts: String(entry.ts ?? ''),
          judgement: String(entry.judgement ?? ''),
          conclusion: String(entry.conclusion ?? ''),
          evidence: Array.isArray(entry.evidence) ? entry.evidence.map(String) : [],
          hesitation: Array.isArray(entry.hesitation) ? entry.hesitation.map(String) : [],
          weight: Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 0.5,
          tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
        })),
      };
    },
  };
}

/** `chain_touch`：让模型在用户明确肯定、反驳或更新一条旧记忆后留下可审计的事件。 */
function defineTouchTool(deps) {
  void deps;
  return {
    name: TOOL_TOUCH,
    description:
      'Update a recalled chain entry after user feedback. Use confirmed when the user reinforces it; '
      + 'superseded when a later record replaces it; set-pool to pin which pool (lifetime) an unclassified '
      + 'entry belongs to — that is the human review step of the patrol report. Never use this for a guess.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The chain entry id (single-entry mode).' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Batch mode: retire several entries at once (typically hippocampus fragments that a '
            + 'written judgement already represents). Ignored when id is also given.',
        },
        outcome: {
          type: 'string',
          enum: ['confirmed', 'superseded', 'set-pool'],
          description: 'confirmed adds 0.05; superseded lowers it to the archive floor; '
            + 'set-pool pins the pool (requires pool) and never touches the weight.',
        },
        pool: {
          type: 'string',
          description: 'With set-pool only: which pool the entry belongs to '
            + '(core / fact / skill / dailyCore / dailyPartial / emotion / hippocampus).',
        },
      }, required: ['outcome'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' }, outcome: { type: 'string' }, ts: { type: 'string' },
        // set-pool 时回填实际生效的池名（空串 = 这个动作不涉及池）
        pool: { type: 'string' },
        // 批量模式实际退役了多少条（单条模式恒为 0 或 1）
        retired: { type: 'integer' },
      }, required: ['id', 'outcome', 'ts', 'pool', 'retired'] },
      render: (_args, value) => (value.pool
        ? textBlock(`已把 <id>${value.id}</id> 定到池「${value.pool}」`)
        : value.retired > 1
          ? textBlock(`已批量退役 <n>${value.retired}</n> 条`)
          : textBlock(`已更新 <id>${value.id}</id>：${value.outcome}`)),
    },
    execute: async (args) => {
      // **批量退役**（人工去噪用）：把 N 条原料一次性标 superseded。
      // 只追加事件，原文永远留在 chains.jsonl —— 误退役可以靠改文件回滚。
      const batch = Array.isArray(args?.ids) ? args.ids.map((x) => cleanText(x)).filter(Boolean) : [];
      if (batch.length > 0 && cleanText(args?.id) === '') {
        const known = new Set(loadAll().entries.map((entry) => entry.id));
        const unknown = batch.filter((x) => !known.has(x));
        if (unknown.length > 0) throw new Error('unknown chain entry id(s): ' + unknown.join(', '));
        let retired = 0;
        let ts = new Date().toISOString();
        for (const target of batch) {
          const event = appendChainEvent({ id: target, type: 'supersede' });
          ts = event.ts;
          retired += 1;
        }
        return { id: batch[0], outcome: 'superseded', ts, pool: '', retired };
      }

      const id = cleanText(args?.id);
      if (id === '' || !loadAll().entries.some((entry) => entry.id === id)) throw new Error('unknown chain entry id');

      // **人工定池**：只改归属，不动权重（定池不是"确认"，别顺手加分）
      if (args?.outcome === 'set-pool') {
        const pool = cleanText(args?.pool);
        if (!Object.prototype.hasOwnProperty.call(POOLS, pool)) {
          throw new Error('unknown pool "' + pool + '"; use one of: ' + Object.keys(POOLS).join(', '));
        }
        const event = appendChainEvent({ id, type: 'retag', pool });
        return { id, outcome: 'set-pool', ts: event.ts, pool, retired: 0 };
      }

      const outcome = args?.outcome === 'superseded' ? 'superseded' : 'confirmed';
      const event = appendChainEvent({ id, type: outcome === 'superseded' ? 'supersede' : 'touch', delta: 0.05 });
      return { id, outcome, ts: event.ts, pool: '', retired: outcome === 'superseded' ? 1 : 0 };
    },
  };
}

/**
 * `chain_graph`：把思维链导出成 Mermaid 图，用来"看见轨迹"。
 *
 * 不返回图片：渲染成位图需要额外依赖，而 Mermaid 文本可以直接贴进任何
 * 支持它的 Markdown 渲染器，既省事又是可复制的产物。
 *
 * @param deps - 依赖。
 * @returns 工具定义。
 */
function defineGraphTool(deps) {
  void deps;
  return {
    name: TOOL_GRAPH,
    description:
      'Export the thinking-chain graph as Mermaid source. Each node is one judgement; ' +
      'solid arrows chain older entries forward in time, dotted arrows point at the ' +
      'evidence behind a judgement. Paste the returned `mermaid` into any renderer to see it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        since: {
          type: 'string',
          description: 'Earliest date to include, YYYY-MM-DD.',
        },
        minWeight: {
          type: 'number',
          description: 'Only entries at or above this weight.',
        },
        limit: {
          type: 'integer',
          description: `Maximum judgement nodes. Defaults to ${GRAPH_DEFAULT}, capped at ${GRAPH_MAX}.`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nodes: { type: 'integer' },
          edges: { type: 'integer' },
          mermaid: { type: 'string' },
        },
        required: ['nodes', 'edges', 'mermaid'],
      },
      render: (_args, value) => {
        if (value.nodes === 0) {
          return textBlock('还没有任何思维链记录；先用 chain_append 写几条再来画。');
        }
        return textBlock(
          `<graph nodes="${value.nodes}" edges="${value.edges}">\n`
          + '```mermaid\n'
          + `${value.mermaid}\n`
          + '```\n'
          + '</graph>',
        );
      },
    },
    execute: async (args) => {
      const { entries } = loadAll();
      const limitRaw = Number(args?.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), GRAPH_MAX)
        : GRAPH_DEFAULT;
      const hits = filterChains(entries, {
        since: args?.since,
        minWeight: args?.minWeight,
      });
      return renderMermaid(hits, limit);
    },
  };
}

/* ------------------------------------------------------------------------- */
/* 下面这些导出只服务于测试与下一版的注入段，不参与注册。                      */
/* ------------------------------------------------------------------------- */

/**
 * 从 agent 的 session 里取最近几条**用户消息**的文本。
 *
 * 用途是「索引延申」：注入里平时只有判断一行，等用户提到某个词，
 * 再把对应那条的细节想起来。要判断"用户提到了什么"，就得先能读到他说的话。
 *
 * 入口是 `session.deriveMessages()`（Session 的公开方法，返回本轮可见的全部消息）。
 * 整个函数**全程容错**：任何一个环节拿不到都返回空串 —— 没有它注入照常，
 * 只是不做延申，不能因为读消息失败把整轮 prompt 搞掉。
 *
 * @param scope - `AssembleContext.scope`（就是 agent 对象）。
 * @param limit - 取最近几条用户消息，默认 2。
 * @returns 拼好的用户文本，最大 4000 字符。
 */
function recentUserText(scope, limit = 2) {
  try {
    const session = scope?.session;
    if (!session || typeof session.deriveMessages !== 'function') return '';
    const messages = session.deriveMessages();
    if (!Array.isArray(messages)) return '';
    const picked = [];
    for (let i = messages.length - 1; i >= 0 && picked.length < limit; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      // 必须剥掉运行时元信息：否则索引延伸会拿「Time sampled while preparing turn…」
      // 这种字样去匹配记忆，命中一堆莫名其妙的东西（2026-10-28 实测）。
      const text = stripRuntimePreamble(textOfMessage(m));
      if (text !== '') picked.unshift(text);
    }
    return picked.join('\n').slice(0, 4000);
  } catch {
    return '';
  }
}

/**
 * 从一条 Message 里抽出纯文本（结构随版本变，按多个候选路径试）。
 * @param m - 消息对象。
 * @returns 文本；抽不到返回空串。
 */
function textOfMessage(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        // ⚠️ 2026-10-28 实测踩过：assistant 消息的 content 里**同时有意识流和正文**，
        //    一律拼进来会把「我的思考过程」当成「我说的话」存进海马体。
        //    只收正文块，思考块一律跳过。
        const kind = String(part.type ?? '');
        if (kind === 'reasoning' || kind === 'thinking' || kind === 'analysis' || kind === 'redacted') return '';
        if (typeof part.text === 'string') return part.text;
        return '';
      })
      .filter((x) => x !== '')
      .join('\n');
  }
  if (typeof m.text === 'string') return m.text;
  return '';
}

/**
 * 剥掉 user 消息里的**运行时元信息**，只留用户真正打的字。
 *
 * ⚠️ 2026-10-28 实测：`deriveMessages()` 的 user 消息前面挂着一串 harness 注入的
 * 上下文（`Time sampled while preparing turn …` / `Browser time zone …` /
 * `Elapsed since the preceding …`）。这些是**给模型看的运行时事实**，不是用户说的话。
 *
 * 第一次写海马体时没剥，结果存下来的是这串元信息，而用户真正的「重启了，鱼你打错字了」
 * 被 400 字截断挤出去了 —— 原料全是垃圾，后面的整理也就无从谈起。
 *
 * @param text - 原始 user 文本。
 * @returns 只剩用户说的话。
 */

/** 去掉标点空白，用于比较"这条判断是不是把那条原料吸收了"。 */
function normForMatch(text) {
  return String(text ?? '').replace(/\s+/g, '').replace(/[，。、；：""''（）()【】\[\]!？?…—\-.,]/g, '');
}

/** 二元组相似度（0~1）：中文短句上比编辑距离稳，也够快。 */
function bigramSim(a, b) {
  const s1 = normForMatch(a);
  const s2 = normForMatch(b);
  if (s1 === '' || s2 === '') return 0;
  if (s1 === s2) return 1;
  const grams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const g1 = grams(s1);
  const g2 = grams(s2);
  let inter = 0;
  let total = 0;
  for (const [g, c] of g1) { total += c; if (g2.has(g)) inter += Math.min(c, g2.get(g)); }
  for (const [, c] of g2) total += c;
  return (2 * inter) / (total || 1);
}

/**
 * 找出「已经被这条新判断吸收」的海马体原料，把它们退役。
 *
 * 判据（任一）：
 *   · 新判断的正文明含了原料的原话（双向包含）；
 *   · 二元组相似度 ≥ 0.55（跟夜巡的重复判据同一档）。
 *
 * 为什么可以自动：原料是缓冲，**它的全部价值就是"某天被写成判断"**。
 * 一旦写成了，留着它只会让 ④ 越来越长、检索越来越脏。
 *
 * @param judgement - 新写入的判断文本。
 * @returns 退役了几条。
 */
function absorbFragments(judgement) {
  let retired = 0;
  try {
    const target = normForMatch(judgement);
    // 短句也要能吸收（"差不多了"这种三字片段很常见）——
    // 但不能让"嗯""OK"被任何判断顺带吞掉：**短原料只认完全相等**，见下面的 covered。
    if (target.length < 2) return 0;
    const { entries } = loadAll();
    for (const entry of entries) {
      if (!entry || entry.superseded === true) continue;
      if (poolOf(entry) !== 'hippocampus') continue;
      const tags = Array.isArray(entry.tags) ? entry.tags : [];
      if (!tags.some((tag) => String(tag).includes('海马体'))) continue;
      const said = String(entry.judgement ?? '').replace(/^片段[：:]/, '');
      if (said === '') continue;
      const saidNorm = normForMatch(said);
      const covered = saidNorm.length >= 6
        ? (target.includes(saidNorm) || saidNorm.includes(target))
        // 短原料（<6 字）不做包含判断：太容易误伤，只认完全相等
        : (target === saidNorm);
      if (!covered && bigramSim(judgement, said) < 0.55) continue;
      try {
        appendChainEvent({ id: entry.id, type: 'supersede' });
        retired += 1;
      } catch {
        /* 单条失败不影响别的 */
      }
    }
  } catch {
    /* 吸收失败不能连累写入本身 */
  }
  return retired;
}

function stripRuntimePreamble(text) {
  let out = String(text ?? '');
  // ⚠️ **不能要求匹配后面跟换行**：实测见过 `Elapsed since the preceding step context:
  //    unavailable.` 这种整条消息只有元信息、末尾也可能没有换行的形态（2026-10-28 第四次踩）。
  //    统一按"从匹配起点吃到行尾（或字符串结尾）"处理。
  const markers = [
    /Time sampled while preparing[^\n]*/gi,
    /Browser time zone for this request:[^\n]*/gi,
    /Elapsed since the preceding[^\n]*/gi,
  ];
  let cut = 0;
  for (const re of markers) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(out)) !== null) {
      const end = m.index + m[0].length;
      if (end > cut) cut = end;
    }
  }
  if (cut > 0) out = out.slice(cut);
  // **整块丢弃**，不是只剥标签：标签里的内容是系统提醒的正文，
  // 剥了标签等于把系统的话当成她说的（用户 2026-10-29 审出来的）。
  // 先处理成对的；再处理"只有开头没有结尾"的残缺形态（截断消息里见过）。
  out = out.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, ' ');
  out = out.replace(/<system-reminder\b[^>]*>[\s\S]*$/i, ' ');
  out = out.replace(/<\/?system-reminder\b[^>]*>/gi, ' ').trim();
  // 兜底：截完仍然是元信息开头（或几乎没有内容）→ 当作用户没有说话。
  if (out === '') return '';
  if (/^(Time sampled|Browser time zone|Elapsed since)/i.test(out)) return '';
  // ⚠️ 2026-10-28 第五次：宿主还会把**系统提醒**当成一条 user 消息投进来，
  //    比如技能目录变更、runtime context 快照。它们不是用户说的话，
  //    之前漏了这两类，海马体里就多出「The available skill catalog changed…」这种片段。
  if (/^(The available skill catalog changed|Current runtime context\.)/i.test(out)) return '';
  // ⚠️ 2026-10-29 补：宿主还会投递这两类系统提醒，之前它们被当成"用户说的话"存进海马体。
  //    技能目录变更提醒 / 审批策略变更提醒 —— 都不是她说的话。
  if (/^(A skill is a reusable|The approval policy changed)/i.test(out)) return '';
  if (out.length < 2) return '';
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * 取最近一轮「用户说的 + 我说的」原文（给海马体用）。
 *
 * @param scope - `AssembleContext.scope`（agent 对象）。
 * @returns `{ user, assistant }` 或 null。
 */
function latestExchange(scope) {
  try {
    const session = scope?.session;
    if (!session || typeof session.deriveMessages !== 'function') return null;
    const messages = session.deriveMessages();
    if (!Array.isArray(messages)) return null;
    // **成对取**（2026-10-29 重写）：先定位最后一条 assistant，再取**它前面**那条 user。
    //
    // 原来分别取「最后一条 user」和「最后一条 assistant」—— 但写这段的时候，
    // 最新那条 user 还没有回复，于是配上去的是**上一轮**的回复，永远差一拍；
    // 而且两半是独立取值，所以错位不一定是一拍（另一台电脑的鱼实测到隔两轮）。
    let assistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'assistant') continue;
      if (textOfMessage(m).trim() !== '') { assistantIdx = i; break; }
    }
    if (assistantIdx < 0) {
      // 还没有任何回复：只记「她说了什么」，assistant 留空（不要乱配上一轮的）
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        const said = stripRuntimePreamble(textOfMessage(m).trim());
        if (said !== '') return { user: said, assistant: '' };
      }
      return null;
    }
    const assistant = textOfMessage(messages[assistantIdx]).trim();
    let user = '';
    for (let i = assistantIdx - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      const said = stripRuntimePreamble(textOfMessage(m).trim());
      if (said !== '') { user = said; break; }
    }
    if (user === '') return null;
    return { user, assistant };
  } catch {
    return null;
  }
}

/** 上一次写进海马体的那句话（进程内指纹），防止同一句被写很多次。 */
let lastHippocampusKey = '';

/**
 * 把最近一轮对话**原样**丢进海马体。
 *
 * ## 为什么这一步不需要模型
 *
 * 「每轮自动记忆」最容易想到的做法是每轮调一次小模型去抽取"这轮有什么值得记的"，
 * 但那是每分钟都在花钱，而且**多数轮次本来就没什么值得记的**。
 *
 * 所以这一步只做最笨也最便宜的事：**把原始片段存在那里**，三天内由夜巡去加工。
 * 海马体本来就是缓冲，不是判断 —— 真正的判断留给后面的整理环节。
 *
 * 三道限制：
 *   1. **同一句只写一次**（按用户消息前 200 字做指纹，进程内比对）；
 *   2. 长度截断，单条不超 FIELD_MAX；
 *   3. 任何异常都吞掉 —— 记不下来也不能影响注入。
 *
 * @param scope - agent 对象。
 * @returns 是否写入。
 */
function writeHippocampusFragment(scope) {
  const exchange = latestExchange(scope);
  if (!exchange) return false;
  const key = exchange.user.slice(0, 200);
  if (key === lastHippocampusKey) return false;

  // **落盘去重**（2026-10-29）：原来只靠进程内指纹，DSH 一重启指纹就没了，
  // 同一句又被写一条（实测：04:24 和 04:40 各一条，内容完全一样）。
  // 改成去链里查——海马体里已经有同样原话的，就不再写；
  // 时间窗口用海马体自己的归档期（过期了才允许重新记，这是刻意的）。
  try {
    const days = Number(poolDef('hippocampus').archiveDays) || 3;
    const since = Date.now() - days * 86_400_000;
    const duplicate = loadAll().entries.some((entry) => {
      if (!entry || entry.superseded === true) return false;
      if (poolOf(entry) !== 'hippocampus') return false;
      const ts = Date.parse(String(entry.ts ?? ''));
      if (Number.isFinite(ts) && ts < since) return false;
      const first = Array.isArray(entry.evidence) && entry.evidence.length > 0
        ? String(entry.evidence[0]) : '';
      // **两种前缀都认**（2026-10-29 修）：私有版写字面「她说：」，
      // 对外版那份做过人称中性化、写的是「用户说：」。判据硬写一种就永远漏一种，
      // 症状是"每次重启都给同一句重写一条"。按匹配长度切片，别写死 3。
      const m = /^(?:她说|用户说)[:：]/.exec(first);
      return m !== null && first.slice(m[0].length, m[0].length + 200) === key;
    });
    if (duplicate) {
      lastHippocampusKey = key;   // 记到内存里，省下后面的重复查询
      return false;
    }
  } catch {
    // **失败姿态必须是"别写"，不能是"照写"**（2026-10-29 实锤：重启瞬间查询抛错，
    // 于是同一句话跨重启写了两条一字不差的片段）。原料丢一条三天就过期、无感；
    // 重复堆进来会污染夜巡的 ④，还会被当成"反复出现"升格成需人工定池的条目。
    // 先重试一次（启动瞬间的错多半是瞬时的），仍失败就跳过。
    try {
      const days = Number(poolDef('hippocampus').archiveDays) || 3;
      const since = Date.now() - days * 86_400_000;
      const retry = loadAll().entries.some((entry) => {
        if (!entry || entry.superseded === true) return false;
        if (poolOf(entry) !== 'hippocampus') return false;
        const ts = Date.parse(String(entry.ts ?? ''));
        if (Number.isFinite(ts) && ts < since) return false;
        const first = Array.isArray(entry.evidence) && entry.evidence.length > 0
          ? String(entry.evidence[0]) : '';
        const m = /^(?:她说|用户说)[:：]/.exec(first);
        return m !== null && first.slice(m[0].length, m[0].length + 200) === key;
      });
      if (retry) {
        lastHippocampusKey = key;
        return false;
      }
    } catch {
      // 两次都查不动：跳过这一条，别赌
      return false;
    }
  }
  lastHippocampusKey = key;
  try {
    appendChain({
      judgement: `片段：${exchange.user.replace(/\s+/g, ' ').slice(0, 70)}`,
      conclusion: '',
      evidence: [
        `用户说：${exchange.user.slice(0, 400)}`,
        ...(exchange.assistant === '' ? [] : [`我回：${exchange.assistant.slice(0, 400)}`]),
      ],
      weight: 0.5,
      tags: ['海马体'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 记一次"被想起"。
 *
 * **这是遗忘机制的输入**：被检索命中的记忆写一条 `touch` 事件（delta=0，
 * 只计次数与最后接触时间，不涨权重），衰减再按次数放慢半衰期。
 * 没人提的条目则照常按时间淡下去 —— "检索得少就慢慢淡忘"落在这里。
 *
 * 三道限制，避免事件刷爆：
 *   1. **同一条每天最多记一次**（用条目自带的 `lastTouched` 判断，不额外维护状态，
 *      进程重启也不会重复记）；
 *   2. 原则不记 —— 它们永不衰减，计数对它们没有意义；
 *   3. 已归档（>200 天）不记 —— 它已经不在图上了。
 *
 * @param entries - 本次注入用到的全部条目（用来查 lastTouched）。
 * @param ids - 本轮命中的条目 id。
 * @returns 实际写了几条。
 */
function recordHits(entries, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const today = new Date().toDateString();
  const byId = new Map();
  for (const entry of entries) byId.set(String(entry.id ?? ''), entry);
  let written = 0;
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry === undefined) continue;
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    if (tags.some((tag) => typeof tag === 'string' && tag.includes('原则'))) continue;
    const last = Date.parse(String(entry.lastTouched ?? ''));
    if (Number.isFinite(last) && new Date(last).toDateString() === today) continue;
    try {
      appendChainEvent({ id, type: 'touch', delta: 0 });
      written += 1;
    } catch {
      /* 记账失败不该影响注入 */
    }
  }
  return written;
}

/**
 * 渲染"只对一个会话可见"的注入文本。
 *
 * @param scopeId - `AssembleContext.scope?.id`。
 * @param targets - 目标会话列表；空数组表示用默认值。
 * @param userText - 用户最近说的话（可选）。给了就启用索引延申。
 * @returns 注入文本；非目标会话或无数据时返回**空串**。
 */
export function buildInjection(scopeId, targets = [], userText = '') {
  if (!isTargetSession(scopeId, targets.length > 0 ? targets : undefined)) return '';
  const { entries } = loadAll();
  const hitIds = [];
  const text = renderInjection(entries, {
    userText,
    // 索引延申命中即记账 —— 但绝不因为记账失败而少一段注入。
    onHit: (id) => {
      if (typeof id === 'string' && id !== '') hitIds.push(id);
    },
  });
  if (hitIds.length > 0) recordHits(entries, hitIds);
  return text;
}

/**
 * `chain_patrol`：跑一次夜巡，生成"该合并 / 该遗忘 / 该连线"的清单。
 *
 * **只出报告，不改数据** —— 合并会改写"我记得什么"，合错了原始区分找不回来。
 *
 * @param deps - 依赖。
 * @returns 工具定义。
 */
function definePatrolTool(deps) {
  void deps;
  return {
    name: TOOL_PATROL,
    description:
      'Run an overnight-style patrol over the thinking chain and produce a REVIEW-ONLY report: '
      + 'entries that have not been recalled for a while (forgetting candidates), pairs whose '
      + 'judgement lines look duplicated (merge candidates), and pairs that share rare keywords '
      + 'but have no link (connection candidates). '
      + 'It also proposes weight-only rebalances (see `apply`) — it NEVER edits judgement, '
      + 'conclusion or evidence text; merging is still a human call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        staleDays: {
          type: 'number',
          description: 'Treat an entry as "not recalled for a while" after this many days. Default 14.',
        },
        top: {
          type: 'number',
          description: 'How many rows per section. Default 10.',
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, build the report but do not write it to disk.',
        },
        apply: {
          type: 'boolean',
          description: 'When true, also write the weight-only rebalance events (max +/-0.05 each, '
            + 'cumulative bounded to [-0.15, +0.10]). Text content is never touched. Default false.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          written: { type: 'boolean' },
          counts: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'number' },
              principles: { type: 'number' },
              stale: { type: 'number' },
              dupes: { type: 'number' },
              shared: { type: 'number' },
              // ⚠️ patrol.js 的 counts 里多了这个字段。schema 写了 additionalProperties:false，
              //    少声明一个就会在**返回值校验**阶段报错（不是注册阶段）——
              //    2026-10-28 实测：tool "chain_patrol" returned invalid output:
              //    "value.counts.rebalance" is not a declared property。
              rebalance: { type: 'number' },
              // ⚠️ **同一个坑第二次**（2026-10-29，用户/client 的鱼实测报错原文）：
              //    tool "chain_patrol" returned invalid output:
              //    "value.counts.unclassified" is not a declared property
              //    patrol.js 加了「未归类待审」计数，schema 又忘了跟 —— 上面那条注释
              //    就是在讲 rebalance 的同款事故。**加字段必须两边一起改。**
              unclassified: { type: 'number' },
            },
            required: ['total', 'principles', 'stale', 'dupes', 'shared', 'rebalance', 'unclassified'],
          },
          rebalanced: { type: 'number' },
          markdown: { type: 'string' },
        },
        required: ['path', 'written', 'counts', 'rebalanced', 'markdown'],
      },
      render: (_args, value) => {
        const c = value.counts;
        const head = `夜巡完成（${value.written ? `已写入 ${value.path}` : 'dry-run，未写盘'}）\n`
          + `共 ${c.total} 条 = 原则 ${c.principles} + 其余 ${c.total - c.principles}\n`
          + `久未命中 ${c.stale} · 疑似重复 ${c.dupes} 对 · 待连线 ${c.shared} 对\n`
          + `自动归整：本轮写入 ${value.rebalanced} 条权重事件（只动权重，正文一个字没改）`;
        return textBlock(`${head}\n\n${value.markdown}`);
      },
    },
    execute: async (args) => {
      const { entries } = loadAll();
      const opts = { staleDays: Number(args?.staleDays), top: Number(args?.top) };
      // 先归整、再出报告 —— 报告里 ④ 段展示的正是这一轮"将要/已经"动的权重。
      let rebalanced = 0;
      if (args?.apply === true) {
        rebalanced = applyRebalance(entries, { maxActions: opts.top }).written;
      }
      const fresh = rebalanced > 0 ? loadAll().entries : entries;
      if (args?.dryRun === true) {
        const built = buildPatrolReport(fresh, opts);
        return { path: '', written: false, counts: built.counts, rebalanced, markdown: built.markdown };
      }
      const result = writePatrolReport(fresh, { ...opts, trigger: '手动' });
      return { path: result.path, written: true, counts: result.counts, rebalanced, markdown: result.markdown };
    },
  };
}

/**
 * `chain_mood`：写/覆盖**当前情绪状态**。
 *
 * 和 `chain_append` 的根本区别：
 *   · `chain_append` 追加一条记忆，靠遗忘慢慢淡；
 *   · `chain_mood` **覆盖**同一块牌 —— 任何时刻只有一条情绪，新的盖掉旧的。
 *
 * 参数来自用户 2026-10-28 的定调：唯一性、可覆盖写、3 小时开始忘、半衰期 1 天。
 *
 * @param deps - 依赖。
 * @returns 工具定义。
 */
function defineMoodTool(deps) {
  void deps;
  return {
    name: TOOL_MOOD,
    description:
      'Overwrite my CURRENT emotional state (a single slot, not a log). '
      + 'Use it when something actually changes how I feel — repeated failures, worry about her, '
      + 'being moved by her mood, a win. It replaces the previous mood entirely. '
      + 'It fades on its own: begins decaying after 3 hours, half-life 1 day, then gone.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mood: {
          type: 'string',
          description: 'One short phrase for the state itself, e.g. "挫败", "担心用户", "被带动", "得意".',
        },
        why: {
          type: 'string',
          description: 'One line on what caused it. Kept verbatim; keep it short.',
        },
        intensity: {
          type: 'number',
          description: 'How strong, 0–1. Default 0.6. Use 0.9+ only for something that really hits.',
        },
      },
      required: ['mood'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mood: { type: 'string' },
          why: { type: 'string' },
          intensity: { type: 'number' },
          ts: { type: 'string' },
          strength: { type: 'number' },
        },
        required: ['mood', 'why', 'intensity', 'ts', 'strength'],
      },
      render: (_args, value) => textBlock(
        `当前情绪已覆盖：${value.mood}（强度 ${value.strength.toFixed(2)}）`
        + (value.why === '' ? '' : `\n因为：${value.why}`)
        + '\n它会自己过去：3 小时后开始淡，半衰期 1 天。',
      ),
    },
    execute: async (args) => {
      const saved = writeMood({
        mood: args?.mood,
        why: args?.why,
        intensity: args?.intensity,
      });
      const { strength } = moodStrength(saved);
      return {
        mood: saved.mood,
        why: saved.why,
        intensity: saved.intensity,
        ts: saved.ts,
        strength: Math.round(strength * 1000) / 1000,
      };
    },
  };
}

/** 段名与顺序也导出，测试可以断言它们与配置一致。 */
export { SECTION_NAME, SECTION_ORDER };
