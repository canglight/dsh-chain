/**
 * 自包含的「叫醒一个会话」—— 只依赖 DSH 自己的 HTTP 接口，不带任何本地项目依赖。
 *
 * 为什么要它：夜巡只在 18:00 后写一份报告，如果没人被叫醒，那一环就断了
 * （报告躺在磁盘里没人读）。原版用的是另一套专用客户端，开源包不能带那个。
 *
 * 握手流程（全部实测过）：
 *   ① 从 `~/.dsh/guard/logs/server-*.out.log` 里发现**端口**和**启动 token**
 *   ② `GET /?token=<token>` → 拿 Set-Cookie（之后所有请求带这个 Cookie）
 *   ③ `POST /api/<method>`，body 是 `{type:'client-request', rpcId, method, payload}`
 *   ④ `session/prompt` 的 payload 必须包在 `request` 里，字段：
 *        { requestId, sessionId, mode: 'queue'|'steer', content: [{type:'text',text}], clientTimeZone? }
 *
 * 用法：
 *   node wake.mjs check                  # 只体检：能否发现宿主 / 认证 / 列出会话
 *   node wake.mjs prompt [sessionId]     # 投递一条唤醒（不给 sessionId 就自动挑）
 *   node wake.mjs prompt --dry <id>      # 只打印要做什么，不真的发
 *
 * 目标会话的选取规则（这是「通用版」唯一说得通的定义）：
 *   · 显式给了 sessionId（参数 / WAKE_SESSION_ID / settings.json 的 wakeSessionId）→ 用它
 *   · 否则挑**最近活跃且 running=false（空闲）**的那个会话
 *   · 全都忙 → 跳过，不做任何事
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STORE_DIR_NAME } from './config.js';

const WAKE_TEXT = process.env.WAKE_MESSAGE || [
  '夜巡时间到了：报告已经生成。',
  '请把报告里「海马体待整理」和「未归类待审」两节过一遍，',
  '整理成候选判断清单 —— **只出清单，先别自己写进链**。',
].join('\n');

/* ---------- ① 从 guard 日志里发现端口 + token ---------- */

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function discoverHost() {
  // ① 显式覆盖（优先级最高）：有的启动方式（直接跑 dsh / 用 .cmd / 当服务）
  //    **不会写 guard 日志**，这时候用环境变量指定，别让它静默跳过。
  //      DSH_WAKE_URL=http://127.0.0.1:3080  DSH_WAKE_TOKEN=<启动日志里的那个 token>
  const envUrl = String(process.env.DSH_WAKE_URL ?? '').trim();
  const envToken = String(process.env.DSH_WAKE_TOKEN ?? '').trim();
  if (envUrl !== '' && envToken !== '') {
    return { baseUrl: envUrl.replace(/\/+$/, ''), token: envToken, source: 'env' };
  }

  const logsDir = join(dshHome(), 'guard', 'logs');
  let files;
  try {
    files = readdirSync(logsDir)
      .filter((name) => /^server-.*\.out\.log$/.test(name))
      .map((name) => ({ name, mtime: statSync(join(logsDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return { baseUrl: '', token: '' };
  }
  for (const { name } of files) {
    let text;
    try { text = readFileSync(join(logsDir, name), 'utf8'); } catch { continue; }
    // 同一份日志里既有端口也有 token
    const portMatch = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    const tokenMatch = text.match(/[?&]token=([A-Za-z0-9_-]{8,})/);
    if (portMatch && tokenMatch) {
      return { baseUrl: `http://127.0.0.1:${portMatch[1]}`, token: tokenMatch[1], source: logName(name) };
    }
  }
  return { baseUrl: '', token: '', source: '' };
}

/** 只留下日志文件名（报错时给线索，不打印 token）。 */
function logName(name) {
  return String(name ?? '');
}

/* ---------- ② RPC ---------- */

/** 哪些方法要把参数包进同名字段里（照 DSH 的 wire 约定）。 */
const WRAP_FIELD = {
  'session/list': '_request',   // ← 实测：不是 query，是 _request
  'session/prompt': 'request',
};

/**
 * RPC 信封的真实形状（照桥接的 wrapArgs 抄的，不是猜的）：
 *   payload = { args: { <参数名>: 真正的参数 } }
 * 有些方法不需要参数名（wrapper 为 null）→ payload = { args: {} }。
 */
function envelope(method, payload) {
  const field = WRAP_FIELD[method];
  const body = field === undefined ? { args: payload ?? {} } : { args: { [field]: payload ?? {} } };
  return { type: 'client-request', rpcId: randomUUID(), method, payload: body };
}

async function makeClient(baseUrl, token) {
  let cookie = '';
  async function ensureCookie() {
    if (cookie !== '') return cookie;
    const url = new URL(baseUrl);
    url.searchParams.set('token', token);
    const res = await fetch(url, { redirect: 'manual' });
    const raw = res.headers.get('set-cookie') || '';
    await res.body?.cancel?.();
    cookie = raw.split(';')[0] || '';
    if (!res.ok && cookie === '') throw new Error('换 Cookie 失败 HTTP ' + res.status);
    return cookie;
  }

  async function call(method, payload) {
    const c = await ensureCookie();
    const body = envelope(method, payload);
    const res = await fetch(baseUrl + '/api/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: c },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('返回不是 JSON：' + text.slice(0, 120)); }
    const result = json?.result;
    if (!result) throw new Error('没有 result 字段 HTTP ' + res.status);
    if (result.ok === false) {
      const err = result.error || {};
      throw new Error((err.code || 'error') + ': ' + (err.message || 'unknown'));
    }
    return result.value ?? result;
  }

  return { call };
}

/* ---------- ③ 选目标会话 ---------- */

function loadSettings() {
  // 按**当前这份插件自己的**数据目录读（同一个脚本装在两份插件里，目录不同）。
  const p = join(dshHome(), 'memories', STORE_DIR_NAME, 'settings.json');
  try {
    // 去掉 BOM：记事本 / PowerShell 写出来的 settings.json 常带 UTF-8 BOM，
    // 直接 JSON.parse 会抛错、被下面的 catch 吞成「没配置」——用户会以为设置没生效（实测踩过）。
    const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch { return {}; }
}

function pickTarget(sessions, explicit) {
  if (explicit) {
    // ⚠️ id 形态不一致会让唤醒**静默失败**：宿主 `sessions.list` 返回的是完整
    //    `session-<uuid>`，而用户按 README 设 `DSH_CHAIN_TARGET_SESSION_IDS` 时，
    //    从侧边栏/文档里抄来的往往是**不带** `session-` 的 uuid（或反过来）。
    //    严格相等 → 永远 false → 记一条「跳过：explicit-not-found」，报告照写但从不叫人。
    //    修法：两边都归一化（去掉前导 session-），哪种写法都能命中。
    const norm = (v) => String(v || '').replace(/^session-/, '');
    const want = norm(explicit);
    const found = sessions.find((s) => norm(s.sessionId || s.id) === want);
    return found ? { session: found, reason: 'explicit' } : { session: null, reason: 'explicit-not-found' };
  }
  // **不筛掉正在运行的**：这个包是"跨会话共享一条记忆链"，
  // 报告属于所有会话，最近说话的那个就是最该看的人；
  // 它正忙也没关系 —— 投递用的是 mode=queue，排在它当前这轮之后，不打断。
  const byRecent = sessions
    .slice()
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  if (byRecent.length === 0) return { session: null, reason: 'no-sessions' };
  return { session: byRecent[0], reason: 'most-recent' };
}

/* ---------- ④ main ---------- */

async function main() {
  const mode = process.argv[2] || 'check';
  const args = process.argv.slice(3);
  const dry = args.includes('--dry');
  const explicitArg = args.find((a) => !a.startsWith('--')) || '';

  const { baseUrl, token } = discoverHost();
  if (!baseUrl || !token) {
    console.log('跳过：没找到 DSH 的 guard 日志（宿主没在跑？）');
    return 0;
  }

  const client = await makeClient(baseUrl, token);
  const listValue = await client.call('session/list', {});
  const sessions = Array.isArray(listValue) ? listValue : (listValue?.items || []);

  if (mode === 'check') {
    console.log('宿主:', baseUrl);
    console.log('会话数:', sessions.length);
    const busy = sessions.filter((s) => s.running === true).length;
    console.log('空闲 / 运行中:', (sessions.length - busy) + ' / ' + busy);
    const picked = pickTarget(sessions, loadSettings().wakeSessionId || '');
    console.log('自动选中的目标:', picked.reason, '→', picked.session ? (picked.session.sessionId || picked.session.id) : '(无)');
    return 0;
  }

  if (mode === 'prompt') {
    // **默认唤醒"最近说话的那个会话"**（2026-10-29 用户定）。
    //
    // 为什么这是对的：这个包的前提就是「整个 DSH 共用同一条记忆链」——
    // 夜巡报告属于所有会话，那么"最近还在说话的那个人"就是最该看报告的人。
    // （我一度按"防止误唤醒"改成必须显式配置才动，那等于把这个包的默认用途堵死了。）
    //
    // 优先级：
    //   ① 显式指定（参数 / WAKE_SESSION_ID / settings.json 的 wakeSessionId）→ 叫醒它
    //   ② 否则 → 最近活跃的那个会话
    //   ③ settings.json 里 wakeEnabled:false → 一律不叫
    const cfg = loadSettings();
    const explicit = explicitArg || process.env.WAKE_SESSION_ID || cfg.wakeSessionId || '';
    if (cfg.wakeEnabled === false) {
      console.log('跳过：settings.json 里 wakeEnabled=false');
      return 0;
    }

    const picked = pickTarget(sessions, explicit);
    if (!picked.session) {
      console.log('跳过：' + picked.reason);
      return 0;
    }
    const sessionId = picked.session.sessionId || picked.session.id;
    // **不要把"正忙"当成跳过理由**（2026-10-30 修，这是唤醒失效的真因）。
    // 投递用的是 mode='queue'：它就是"排在当前这轮之后"，本来就不打断。
    // 而唤醒的触发点恰恰是【压缩】—— 压缩发生在回合中途，这一轮几乎必然还在跑，
    // 于是"正忙 → 跳过"等于「压缩触发的那次唤醒 100% 丢」。
    // 真丢的原因是报错，不是忙：让它照常排队，失败了由调用方的 wake.log 记下来。
    if (dry) {
      console.log('--dry：会给 ' + sessionId + ' 投递（' + picked.reason + '）→');
      console.log(WAKE_TEXT);
      return 0;
    }
    await client.call('session/prompt', {
      requestId: 'wake-' + Date.now() + '-' + randomUUID().slice(0, 8),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: WAKE_TEXT }],
      clientTimeZone: 'Asia/Shanghai',
    });
    console.log('已投递唤醒 → ' + sessionId + '（' + picked.reason + '）');
    return 0;
  }

  console.log('未知模式:', mode);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.log('失败:', error?.message || String(error));
    process.exit(1);
  });
