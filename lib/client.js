/**
 * dsh-chain-shared 客户端半：会话视图里的「思维链」tab（v12 真 3D 星云）。
 *
 * 手写、不走构建，必须守住宿主模块加载器的格式（`window.__ModuleLoader__.load`），
 * 不能用 JSX；组件一律 React.createElement，CSS 用带 data-plugin 标记的 <style> 注入。
 *
 * ── v12 修的是什么（2026-10-28 主人一句话点破）────────────────────
 *   「你的节点根本没动态，是一张 2d 的纸在 3d 旋转」
 *
 *   v11 的错：布局把坐标烤死成静态 cx/cy，再给整组套 CSS rotate。
 *   点没有深度 → 旋转时不会近大远小、不会改变亮度、没有视差 = 平面纸片。
 *
 *   v12：每个点存 (x, y, z)，**每帧绕 Y / 绕 X 旋转后重新透视投影**：
 *     k = focal / (focal + z')；屏幕坐标 ×k、半径 ×k、亮度按 k 衰减。
 *     直接写 DOM 属性，React 一次都不重渲染。
 *
 * ── 性能取舍（别改回去）──────────────────────────────────────────
 *   · 上限 30fps（慢速自转不需要 60）
 *   · 依据微粒每 3 帧更新一次（最小、肉眼无感）
 *   · 全程零 SVG filter，光晕一律叠圆 / 径向渐变
 *   · 进/出聚焦态只动两个元素
 */

window.__ModuleLoader__.load({
  id: 'dsh-chain-shared',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    /* ════════════ 池定义（颜色是主人一条条点的，别自己调） ════════════ */

    var POOL_SPEC = [
      { key: 'core', label: '核心', color: '#ffd24a' },
      { key: 'fact', label: '事实', color: '#b9a6ff' },
      { key: 'skill', label: '技能', color: '#59d98e' },
      { key: 'dailyCore', label: '核心日常', color: '#2f6bff' },
      { key: 'dailyPartial', label: '片面日常', color: '#7fd4ff' },
      { key: 'emotion', label: '情绪', color: '#ff7fb4' },
      { key: 'hippocampus', label: '海马体', color: '#f2f7ff' },
    ];
    var POOL_MAP = {};
    for (var pi = 0; pi < POOL_SPEC.length; pi += 1) POOL_MAP[POOL_SPEC[pi].key] = POOL_SPEC[pi];

    var TARGET_SESSION_LABEL = '全部会话';
    var VERSION = 'v16';
    var FOCAL = 2.4;

    /* ════════════ 样式 ════════════ */

    var CSS = [
      '.chg-root{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;',
      'background:radial-gradient(ellipse at 50% 46%,#070b14 0%,#04060a 55%,#020307 100%);',
      'color:var(--dsw-alias-label-primary,#e6edf7);font-size:12px;}',
      '.chg-bar{display:flex;align-items:center;gap:8px;flex:none;padding:7px 10px;',
      'border-bottom:1px solid rgba(120,150,200,.08);font-size:11px;letter-spacing:.2px;}',
      '.chg-k{color:rgba(190,205,230,.55);}',
      '.chg-btn{border:1px solid rgba(140,175,225,.22);background:rgba(24,34,52,.5);',
      'color:rgba(205,218,240,.82);border-radius:999px;padding:2px 9px;font-size:11px;cursor:pointer;}',
      '.chg-btn[data-on="1"]{background:rgba(90,140,220,.26);border-color:rgba(150,190,255,.5);color:#eaf2ff;}',
      '.chg-stage{position:relative;flex:1;min-height:0;}',
      '.chg-svg{width:100%;height:100%;display:block;touch-action:none;cursor:grab;}',
      '.chg-galaxy{transition:opacity .34s ease-out, transform .34s ease-out;}',
      '.chg-galaxy[data-out="1"]{opacity:0;pointer-events:none;transform:scale(1.12);}',
      '.chg-item{cursor:pointer;}',
      '.chg-tip{font-size:10px;fill:rgba(198,212,238,.72);pointer-events:none;',
      'font-family:ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;}',
      '.chg-tip-pool{font-size:12px;fill:rgba(228,238,255,.88);}',
      '.chg-panel{position:absolute;top:10px;right:10px;bottom:10px;width:330px;overflow:auto;',
      'background:rgba(12,18,30,.82);backdrop-filter:blur(14px);',
      'border:1px solid rgba(130,165,220,.18);border-radius:14px;padding:14px 15px;',
      'box-shadow:0 18px 50px rgba(0,0,0,.5);transform:translateX(16px);opacity:0;',
      'transition:transform .34s ease-out, opacity .34s ease-out;}',
      '.chg-panel[data-in="1"]{transform:translateX(0);opacity:1;}',
      '.chg-panel h4{margin:0 0 8px;font-size:14px;line-height:1.45;font-weight:600;}',
      '.chg-pool-tag{display:inline-block;font-size:10px;padding:1px 7px;border-radius:999px;margin-bottom:9px;}',
      '.chg-field{margin:9px 0;font-size:11.5px;line-height:1.6;}',
      '.chg-field-k{color:rgba(170,190,220,.6);font-size:10px;letter-spacing:.4px;display:block;margin-bottom:2px;}',
      '.chg-li{margin:3px 0 0 14px;padding:0;}',
      '.chg-li li{margin:2px 0;color:rgba(214,226,244,.86);}',
      '.chg-back{margin-top:12px;width:100%;border:1px solid rgba(140,175,225,.28);',
      'background:rgba(30,42,64,.6);color:rgba(215,228,246,.9);border-radius:9px;padding:6px;',
      'font-size:11.5px;cursor:pointer;}',
      '.chg-empty{color:rgba(180,196,222,.55);padding:24px;text-align:center;}',
      '.chg-set{position:absolute;top:10px;right:10px;width:340px;max-height:calc(100% - 20px);overflow:auto;',
      'background:rgba(10,16,26,.92);backdrop-filter:blur(12px);border:1px solid rgba(130,165,220,.2);',
      'border-radius:12px;padding:12px 13px;font-size:11.5px;box-shadow:0 16px 44px rgba(0,0,0,.5);z-index:5;}',
      '.chg-set-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:13px;}',
      '.chg-set-hint{color:rgba(180,196,222,.6);margin:0 0 8px;line-height:1.5;word-break:break-all;}',
      '.chg-set-globals{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}',
      '.chg-set-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.chg-set-row input{width:96px;}',
      '.chg-set-table{width:100%;border-collapse:collapse;}',
      '.chg-set-table th{text-align:left;font-weight:500;color:rgba(180,196,222,.65);padding:2px 6px 4px 0;font-size:10.5px;}',
      '.chg-set-table td{padding:1px 6px 1px 0;}',
      '.chg-set-table input{width:64px;}',
    ].join('');

    function ensureStyle() {
      try {
        if (typeof document === 'undefined') return;
        if (document.querySelector('style[data-plugin="dsh-chain-shared-v16"]')) return;
        var el = document.createElement('style');
        el.setAttribute('data-plugin', 'dsh-chain-shared-v16');
        el.textContent = CSS;
        (document.head || document.body).appendChild(el);
      } catch (e) { /* 样式注不进去不影响渲染 */ }
    }

    /* ════════════ 工具 ════════════ */

    function hash01(s) {
      var v = 2166136261;
      var str = String(s === undefined || s === null ? '' : s);
      for (var i = 0; i < str.length; i += 1) { v ^= str.charCodeAt(i); v = Math.imul(v, 16777619); }
      return ((v >>> 0) % 100000) / 100000;
    }
    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function shortDate(ts) {
      var t = Date.parse(String(ts || ''));
      if (!isFinite(t)) return '';
      var d = new Date(t);
      return (d.getMonth() + 1) + '-' + d.getDate();
    }
    function poolColor(k) { return (POOL_MAP[k] || { color: '#dfe8ff' }).color; }
    function poolLabel(k) { return (POOL_MAP[k] || { label: k }).label; }

    /* ════════════ 力导向布局（算一次冻结，三维坐标） ════════════ */

    function computeLayout(graphNodes) {
      var mem = []; var evi = [];
      for (var i = 0; i < graphNodes.length; i += 1) {
        if (graphNodes[i].kind === 'evidence') evi.push(graphNodes[i]); else mem.push(graphNodes[i]);
      }
      var byPool = {};
      for (var mi = 0; mi < mem.length; mi += 1) {
        var kk = mem[mi].pool || 'dailyPartial';
        if (!byPool[kk]) byPool[kk] = [];
        byPool[kk].push(mem[mi]);
      }
      var keys = [];
      for (var si = 0; si < POOL_SPEC.length; si += 1) keys.push(POOL_SPEC[si].key);
      for (var bk in byPool) if (keys.indexOf(bk) < 0) keys.push(bk);

      var pos = {}; var pools = [];
      for (var k2 = 0; k2 < keys.length; k2 += 1) {
        // **七个大节点的位置随机**（她 2026-10-28 定），但**不要铺太远**：
        // 角度全随机、半径限制在 0.26–0.54 —— 随机感有，但还在画面中圈。
        var a = hash01(keys[k2] + 'ang') * 6.283;
        // **半径交替拉开**：原来全是 0.5，七个池必然挤成一圈"一块板"。
        // 大小穿插 + 相位错开，团与团之间才有空隙。
        // **七个池连成一个环**（她 2026-10-28 定：要「圈团」不是「铺开」）。
        // 半径基本一致 + 少量抖动 → 像一圈星团，中间留空；差异太大就散成几块。
        var rr0 = 0.26 + hash01(keys[k2] + 'rad') * 0.28;
        var pc = {
          key: keys[k2],
          cx: Math.cos(a) * rr0,
          cy: Math.sin(a) * rr0,
          // **池心也要有纵深**（2026-10-29 加）：七个池心原来全在同一个平面上，
          // 云一转就露馅 —— 转到 90° 时整圈池心压成一条竖线，所有团叠在一起。
          // 实测：那时投影重叠从 2 对跳到 19 对，是"截图看着乱"的最大来源。
          // 按序号均匀铺开 0.62 的纵深，环就变成三维的了。
          cz: ((keys.length > 1 ? k2 / (keys.length - 1) : 0.5) - 0.5) * 1.15,   // 1.15：sweep3 实测最优（90° 视角不再压成一条线）
          r0: rr0,
          a0: a,
          count: (byPool[keys[k2]] || []).length,
          // 每个池自己的公转速率与相位（大节点不再一起转）
          rate: 0.012 + hash01(keys[k2] + 'rate') * 0.020,
          spin: 0.016 + hash01(keys[k2] + 'spin') * 0.028,
          ph: hash01(keys[k2] + 'ph') * 6.283,
        };
        pools.push(pc);
        pos['pool:' + pc.key] = pc;
      }
      /* ── 池内铺点：**球面上的黄金角螺旋**（2026-10-29 改，取代"随机角度撒点"）──
       *
       * 这条改了三轮，前面两轮都被指标否掉了，值得把过程写下来：
       *
       *   ① 随机角度撒点（原版）：随机必有近距尾巴 —— 8 个转角平均有 4.9 对点 <0.012。
       *   ② 平面黄金角螺旋 + 收窄纵深：只看 rotY=0 时光学上更好，
       *      但**90°/270° 反而炸了**（7→22 对）。原因：转角到 90° 时屏幕上只剩下
       *      「纵深 × 高度」，我把纵深从 0.9 收到 0.52，等于把那个视角拆了。
       *      → **教训：这是个旋转的 3D 云，只优化一个角度一定会牺牲别的角度。**
       *   ③ 现在这个：**斐波那契球面**（Fibonacci sphere）—— 点均匀铺在球面上，
       *      半径按 ∛i 递增（体积均匀）。**各方向一样厚，转到哪都一样**，
       *      所以不用再为某个视角做取舍。
       *
       * 池子半径按 ∛n 自动缩放：点数多的池自己铺大，少的收紧。
       */
      var memByPool = {};
      for (var g0 = 0; g0 < mem.length; g0 += 1) {
        var gk = mem[g0].pool || 'dailyPartial';
        if (!memByPool[gk]) memByPool[gk] = [];
        memByPool[gk].push(mem[g0]);
      }
      var GOLDEN = 2.39996323;   // 黄金角（弧度）
      for (var gk2 in memByPool) {
        var group = memByPool[gk2];
        var pc2 = pos['pool:' + gk2];
        if (!pc2) continue;
        // 稳定顺序：同一批数据每次打开排出来一样（不然"复位"会跳）
        group.sort(function (a, b) { return String(a.id) < String(b.id) ? -1 : 1; });
        var n = group.length;
        // 球半径：让相邻两点平均间隔约 0.055（归一化单位，R≈330px 时约 18px）
        var radMax = (Math.cbrt(n) * 0.034 + 0.03) * 0.5;   // 1.2：sweep3 实测最优（团不粘连）
        var spin0 = hash01(gk2 + 'ph') * 6.283;
        for (var gi = 0; gi < n; gi += 1) {
          var gm = group[gi];
          // 斐波那契球面：y 均匀取值，其余按黄金角绕开 → 任意方向密度一致
          var uy = 1 - (gi + 0.5) * 2 / n;
          var rxz = Math.sqrt(Math.max(0, 1 - uy * uy));
          var phi = spin0 + gi * GOLDEN;
          // 半径按 ∛ 递增 = 体积均匀（否则中心会挤成一颗亮核）
          var shell = radMax * Math.cbrt((gi + 0.5) / n);
          pos[gm.id] = {
            x: pc2.cx + Math.cos(phi) * rxz * shell,
            y: pc2.cy + uy * shell,
            z: (pc2.cz || 0) + Math.sin(phi) * rxz * shell,
            key: gk2,
          };
        }
      }
      for (var i4 = 0; i4 < evi.length; i4 += 1) {
        var e = evi[i4];
        var parent = pos[e.parent];
        if (!parent) continue;
        var ea = hash01(e.id) * Math.PI * 2;
        var er = 0.028 + hash01(e.id + 'r') * 0.038;
        pos[e.id] = {
          x: parent.x + Math.cos(ea) * er,
          y: parent.y + Math.sin(ea) * er,
          z: (parent.z || 0) + (hash01(e.id + 'z') - 0.5) * 0.26,
          key: parent.key,
        };
      }

      var ITER = 240;
      for (var it = 0; it < ITER; it += 1) {
        var cool = 0.9 * (1 - it / ITER) + 0.1;
        for (var a1 = 0; a1 < pools.length; a1 += 1) {
          var p1 = pools[a1];
          var fx1 = -p1.cx * 0.55; var fy1 = -p1.cy * 0.55;
          for (var b1 = 0; b1 < pools.length; b1 += 1) {
            if (a1 === b1) continue;
            var p2 = pools[b1];
            var dx1 = p1.cx - p2.cx; var dy1 = p1.cy - p2.cy;
            var d21 = dx1 * dx1 + dy1 * dy1 + 1e-4;
            var f1 = 0.052 / d21;
            fx1 += dx1 * f1; fy1 += dy1 * f1;
          }
          p1.cx += fx1 * cool; p1.cy += fy1 * cool;
        }
        for (var a2 = 0; a2 < mem.length; a2 += 1) {
          var m2 = mem[a2]; var q2 = pos[m2.id]; var c2 = pos['pool:' + q2.key];
          var fx2 = (c2.cx - q2.x) * 0.095;
          var fy2 = (c2.cy - q2.y) * 0.095;
          for (var b2 = 0; b2 < mem.length; b2 += 1) {
            if (a2 === b2) continue;
            var r2 = pos[mem[b2].id];
            var dx2 = q2.x - r2.x; var dy2 = q2.y - r2.y;
            var d22 = dx2 * dx2 + dy2 * dy2 + 1e-5;
            if (d22 > 0.09) continue;
            var f2 = 0.00042 / d22;
            fx2 += dx2 * f2; fy2 += dy2 * f2;
          }
          q2.x += fx2 * cool; q2.y += fy2 * cool;
        }
      }

      var xs = []; var ys = [];
      for (var a3 = 0; a3 < pools.length; a3 += 1) { xs.push(pools[a3].cx); ys.push(pools[a3].cy); }
      for (var a4 = 0; a4 < mem.length; a4 += 1) { xs.push(pos[mem[a4].id].x); ys.push(pos[mem[a4].id].y); }
      var mx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
      var my = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
      var span = Math.max(
        (Math.max.apply(null, xs) - Math.min.apply(null, xs)) / 2,
        (Math.max.apply(null, ys) - Math.min.apply(null, ys)) / 2,
      ) || 1;
      span *= 1.12;   // 稍微留白，团与团之间才有呼吸
      for (var p3 = 0; p3 < pools.length; p3 += 1) {
        pools[p3].cx = (pools[p3].cx - mx) / span;
        pools[p3].cy = (pools[p3].cy - my) / span;
      }
      for (var a5 = 0; a5 < mem.length; a5 += 1) {
        var q3 = pos[mem[a5].id];
        q3.x = (q3.x - mx) / span;
        q3.y = (q3.y - my) / span;
      }


      /* ── 七个池心归到同一个环上（2026-10-29 修）────────────────────────
       *
       * 为什么要这一步：力导向的斥力会把某个池推到接近中心
       * （实测环半径 0.150–0.768，差 5 倍），那个池的小点就铺满画面中央 ——
       * 看起来"小点没围着大点、自己飞出去一坨"。
       * 方位角保留（看着仍是随机的一圈），只把**半径**统一到 0.42±0.05。
       * 池内小点是绝对坐标，所以池心搬家时它们必须跟着搬，否则会脱节。
       */
      var RING_R = 0.37;
      for (var pr = 0; pr < pools.length; pr += 1) {
        var pp = pools[pr];
        var prAng = Math.atan2(pp.cy, pp.cx);
        var prNew = RING_R + (hash01(pp.key + 'ring') - 0.5) * 0.10;
        var prX = Math.cos(prAng) * prNew;
        var prY = Math.sin(prAng) * prNew;
        var prDx = prX - pp.cx;
        var prDy = prY - pp.cy;
        pp.cx = prX;
        pp.cy = prY;
        for (var prq = 0; prq < mem.length; prq += 1) {
          if ((mem[prq].pool || 'dailyPartial') !== pp.key) continue;
          var prp = pos[mem[prq].id];
          prp.x += prDx;
          prp.y += prDy;
        }
      }


      /* ── 每池小点群半径：显式设定（2026-10-29）─────────────────────────
       *
       * 前面调的都是布局阶段的相对参数，而**归一化会按 span 除一遍** ——
       * 团缩小、span 也缩小，除完比例不变（k 从 1.2 调到 0.5，实测群半径一模一样）。
       * 所以这里在归一化和归环之后，直接按点数算目标半径再缩放。
       *   target = 0.045 × ∛n
       *   87 条 → 0.20（相对环半径 0.46 是 0.43）；32 条 → 0.143；1 条 → 0.045
       */
      for (var sz = 0; sz < pools.length; sz += 1) {
        var szPool = pools[sz];
        var szIds = [];
        for (var szi = 0; szi < mem.length; szi += 1) {
          if ((mem[szi].pool || 'dailyPartial') === szPool.key) szIds.push(mem[szi].id);
        }
        if (szIds.length === 0) continue;
        var szTarget = 0.062 * Math.cbrt(szIds.length);
        var szMax = 0;
        for (var szj = 0; szj < szIds.length; szj += 1) {
          var szP = pos[szIds[szj]];
          var szDx = szP.x - szPool.cx;
          var szDy = szP.y - szPool.cy;
          var szDz = (szP.z || 0) - (szPool.cz || 0);
          var szD = Math.sqrt(szDx * szDx + szDy * szDy + szDz * szDz);
          if (szD > szMax) szMax = szD;
        }
        if (szMax < 1e-6) continue;
        var szK = szTarget / szMax;
        for (var szk = 0; szk < szIds.length; szk += 1) {
          var szQ = pos[szIds[szk]];
          szQ.x = szPool.cx + (szQ.x - szPool.cx) * szK;
          szQ.y = szPool.cy + (szQ.y - szPool.cy) * szK;
          szQ.z = (szPool.cz || 0) + ((szQ.z || 0) - (szPool.cz || 0)) * szK;
        }
      }


      /* ── 证据点钉回父节点（2026-10-29 补）────────────────────────────
       *
       * 上面把池心归了环、把每个池的小点群按点数缩放了，但**证据点没跟着动** ——
       * 它们的坐标还是归一化之前的，于是散在离父点很远的地方，
       * 看上去就是"一堆细白点在空中乱飞"。这里统一重钉一次：
       * 父点位置 + 一个由 id 决定的小偏移（半径约 0.03，方向随机但确定）。
       */
      for (var ev2 = 0; ev2 < evi.length; ev2 += 1) {
        var evn = evi[ev2];
        var evParent = pos[evn.parent];
        if (!evParent) continue;
        var evAng = hash01(evn.id + 'ea') * 6.283;
        var evR = 0.018 + hash01(evn.id + 'er') * 0.022;
        pos[evn.id] = {
          x: evParent.x + Math.cos(evAng) * evR,
          y: evParent.y + Math.sin(evAng) * evR,
          z: (evParent.z || 0) + (hash01(evn.id + 'ez') - 0.5) * 0.05,
          key: evParent.key,
        };
      }

      return { pos: pos, pools: pools, mem: mem, evi: evi };
    }

    /* ════════════ 视图 ════════════ */

    function ChainGraphView(props) {
      void props;
      ensureStyle();

      var [data, setData] = React.useState(null);
      var [error, setError] = React.useState(null);
      var [focus, setFocus] = React.useState(null);
      var [panelIn, setPanelIn] = React.useState(false);
      var [size, setSize] = React.useState({ w: 900, h: 620 });
      var [spin, setSpin] = React.useState(false);   // 默认不自转（client 2026-10-29 要求）
      var [labels, setLabels] = React.useState(false);
      // 设置面板（右上角齿轮）。**放在自己的画布里**，不走宿主设置页 ——
      // 那套要 plugins.item 槽位 + configForms，接了两轮才通；自己开接口更直接。
      var [showSettings, setShowSettings] = React.useState(false);

      var elMap = React.useRef({});
      var dataRef = React.useRef(null);   // 轮询里要读最新数据，不能靠闭包里的旧 data
      var rotRef = React.useRef({ rotY: 0, rotX: -0.30, zoom: 1, vel: 0 });
      var dragRef = React.useRef({ on: false, x: 0, y: 0, moved: 0 });
      var layoutRef = React.useRef(null);
      var stageRef = React.useRef(null);
      var spinRef = React.useRef(spin);
      spinRef.current = spin;
      var frameNo = React.useRef(0);
      var animRef = React.useRef(null);   // id -> {x,y,z} 显示位置（弹簧追目标）
      var openRef = React.useRef({ p: 0 });   // 开场进度 0→1（铺开星云）

      React.useEffect(function () {
        var alive = true;
        fetch('/chain-shared/api/graph', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (alive) setData(j); })
          .catch(function (e) { if (alive) setError(String(e && e.message ? e.message : e)); });
        return function () { alive = false; };
      }, []);

      // **实时增量**：每 9 秒拉一次，只把"新的"补进图里。
      // ⚠️ 绝不重跑 computeLayout —— 那会让所有已有节点重新洗牌，整张图跳一下。
      React.useEffect(function () {
        var stopped = false;
        var timer = 0;

        function addOne(node, jdata) {
          var laid = layoutRef.current;
          if (!laid || laid.pos[node.id]) return false;
          var isEvi = node.kind === 'evidence';
          var anchor = null;
          var poolKey = node.pool || 'dailyPartial';
          if (isEvi) {
            anchor = laid.pos[node.parent] || null;
            if (!anchor) return false;
          } else {
            anchor = laid.pos['pool:' + poolKey] || null;
          }
          var ax = anchor ? (typeof anchor.x === 'number' ? anchor.x : anchor.cx) : 0;
          var ay = anchor ? (typeof anchor.y === 'number' ? anchor.y : anchor.cy) : 0;
          var az = anchor ? (typeof anchor.z === 'number' ? anchor.z : (typeof anchor.cz === 'number' ? anchor.cz : 0)) : 0;
          var ang = hash01(node.id) * 6.283;
          var rr = isEvi
            ? 0.030 + hash01(node.id + 'r') * 0.040
            : 0.055 + hash01(node.id + 'r') * 0.115;
          var zz = az + (hash01(node.id + 'z') - 0.5) * (isEvi ? 0.26 : 0.9);
          laid.pos[node.id] = {
            x: ax + Math.cos(ang) * rr,
            y: ay + Math.sin(ang) * rr,
            z: zz,
            key: isEvi ? (anchor.key || poolKey) : poolKey,
          };
          if (isEvi) {
            laid.evi.push(node);
          } else {
            laid.mem.push(node);
            for (var pi = 0; pi < laid.pools.length; pi += 1) {
              if (laid.pools[pi].key === poolKey) laid.pools[pi].count += 1;
            }
            var spool = laid.pos['pool:' + poolKey];
            if (spool && animRef.current) {
              var nOx = laid.pos[node.id].x - spool.cx;
              var nOy = laid.pos[node.id].y - spool.cy;
              animRef.current[node.id] = {
                ox: nOx,
                oy: nOy,
                oz: zz - (spool.cz || 0),
                // 轨道参数必须和种子那边一致，否则新点会走另一种运动
                orr: Math.sqrt(nOx * nOx + nOy * nOy),
                oa: Math.atan2(nOy, nOx),
                ow: 0.10 + hash01(node.id + 'w') * 0.22,
                of: 0.70 + hash01(node.id + 'f') * 0.22,
                oi: (hash01(node.id + 'i') - 0.5) * 1.5,
                oh: hash01(node.id + 'h') * 6.283,
                x: laid.pos[node.id].x,
                y: laid.pos[node.id].y,
                z: zz,
                b: 0,          // 出生进度：0→1（0.6 秒长出来）
              };
            }
          }
          return true;
        }

        function pull() {
          fetch('/chain-shared/api/graph', { headers: { accept: 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (stopped || !layoutRef.current) return;
              var added = 0;
              var nodes = j.nodes || [];
              for (var i = 0; i < nodes.length; i += 1) {
                if (addOne(nodes[i], j)) added += 1;
              }
              var oldTotal = (dataRef.current && dataRef.current.stats) ? dataRef.current.stats.total : -1;
              var newTotal = (j.stats && j.stats.total) ? j.stats.total : -1;
              // 只在"真的有新增 / 总数变了"时重渲染，避免每 9 秒白刷一次
              if (added > 0 || newTotal !== oldTotal) {
                setData(j);
              }
            })
            .catch(function () { /* 拉失败就算了，下一轮再试 */ });
        }

        timer = window.setInterval(pull, 9000);
        return function () {
          stopped = true;
          window.clearInterval(timer);
        };
      }, []);

      React.useEffect(function () {
        function measure() {
          var el = stageRef.current;
          if (!el) return;
          var w = el.clientWidth || 900;
          var hh = el.clientHeight || 620;
          setSize(function (old) {
            if (Math.abs(old.w - w) < 2 && Math.abs(old.h - hh) < 2) return old;
            return { w: w, h: hh };
          });
        }
        measure();
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('resize', measure);
          return function () { window.removeEventListener('resize', measure); };
        }
        return undefined;
      }, []);

      dataRef.current = data;
      if (data && !layoutRef.current && data.nodes) {
        layoutRef.current = computeLayout(data.nodes);
        var seedAnim = {};
        for (var si2 = 0; si2 < layoutRef.current.mem.length; si2 += 1) {
          var sm = layoutRef.current.mem[si2];
          var sp2 = layoutRef.current.pos[sm.id];
          // 记住**相对池心的偏移**，之后绕池心转
          var spool = layoutRef.current.pos['pool:' + sp2.key];
          // 轨道参数（2026-10-29）：半径固定 + 自己的角速度 + 压扁系数
          var sOx = sp2.x - spool.cx;
          var sOy = sp2.y - spool.cy;
          seedAnim[sm.id] = {
            ox: sOx, oy: sOy, oz: (sp2.z || 0) - (spool.cz || 0),
            orr: Math.sqrt(sOx * sOx + sOy * sOy),
            oa: Math.atan2(sOy, sOx),
            ow: 0.10 + hash01(sm.id + 'w') * 0.22,
            of: 0.70 + hash01(sm.id + 'f') * 0.22,
            // **轨道倾角与朝向**（2026-10-29）：每个点一个不同的轨道平面，
            // 否则所有点都在 xy 平面里转，从侧面看就是一条扁线。
            oi: (hash01(sm.id + 'i') - 0.5) * 1.5,
            oh: hash01(sm.id + 'h') * 6.283,
            x: sp2.x, y: sp2.y, z: sp2.z || 0,
          };
        }
        animRef.current = seedAnim;
      }

      function collect(id) {
        return function (el) {
          if (el) elMap.current[id] = el; else delete elMap.current[id];
        };
      }

      function onDown(ev) { dragRef.current = { on: true, x: ev.clientX, y: ev.clientY, moved: 0 }; }
      function onMove(ev) {
        var d = dragRef.current;
        if (!d.on) return;
        var dx = ev.clientX - d.x; var dy = ev.clientY - d.y;
        d.moved += Math.abs(dx) + Math.abs(dy);
        d.x = ev.clientX; d.y = ev.clientY;
        var r = rotRef.current;
        r.rotY += dx * 0.006;
        r.vel = clamp(dx * 0.0012, -0.05, 0.05);   // 拖拽给一个角速度
        r.rotX = clamp(r.rotX + dy * 0.004, -1.15, 1.15);
      }
      function onUp() { dragRef.current.on = false; }   // 惯性交给 projectFrame 慢慢衰减
      function onWheel(ev) {
        if (ev.preventDefault) ev.preventDefault();
        var r = rotRef.current;
        r.zoom = clamp(r.zoom * (ev.deltaY > 0 ? 0.94 : 1.06), 0.5, 2.4);
      }
      function onReset() { rotRef.current = { rotY: 0, rotX: -0.30, zoom: 1 }; }
      function pick(node) {
        if (dragRef.current.moved > 6) return;
        setFocus(node);
        setPanelIn(false);
        if (typeof window !== 'undefined' && window.requestAnimationFrame) {
          window.requestAnimationFrame(function () { setPanelIn(true); });
        } else { setPanelIn(true); }
      }
      function exit() { setPanelIn(false); setFocus(null); }

      React.useEffect(function () {
        if (!focus) return undefined;
        function onKey(ev) { if (ev.key === 'Escape') exit(); }
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('keydown', onKey);
          return function () { window.removeEventListener('keydown', onKey); };
        }
        return undefined;
      }, [focus]);

      React.useEffect(function () {
        if (!data) return undefined;
        var running = true;
        var raf = 0;
        var last = 0;
        function tick(ts) {
          if (!running) return;
          raf = window.requestAnimationFrame(tick);
          if (ts - last < 32) return;          // 上限 30fps
          last = ts;
          try { projectFrame(); } catch (e) {
            // 只报一次：既不在控制台刷屏，也不让错误完全静默。
            // （静默的 try/catch 让「漏声明一个变量」这种错看起来像"动画没生效"，查了很久。）
            if (!window.__chgFrameErr) {
              window.__chgFrameErr = 1;
              if (typeof console !== 'undefined') console.error('[dsh-chain] projectFrame failed:', e);
            }
          }
        }
        // **先同步投影一次**：rAF 在后台标签页会被节流甚至完全暂停，
        // 只靠循环的话首帧可能停在初始化坐标（全挤在中心）。先算一帧兜底。
        if (layoutRef.current) {
          try { projectFrame(); } catch (e) {
            if (typeof console !== 'undefined') console.error('[dsh-chain] first frame failed:', e);
          }
        }
        raf = window.requestAnimationFrame(tick);
        return function () { running = false; window.cancelAnimationFrame(raf); };
      }, [data]);

      if (error) return h('div', { className: 'chg-root' }, h('div', { className: 'chg-empty' }, '读取失败：' + error));
      if (!data) return h('div', { className: 'chg-root' }, h('div', { className: 'chg-empty' }, '读取中…'));
      var laid = layoutRef.current;
      if (!laid) return h('div', { className: 'chg-root' }, h('div', { className: 'chg-empty' }, '布局中…'));

      var cx = size.w / 2;
      var cy = size.h / 2;
      var R = Math.min(size.w, size.h) * 0.46;

      /* ---- 真 3D 投影：每帧算，直接写 DOM（React 不重渲染）---- */
      function projectFrame() {
        var r = rotRef.current;
        var tt = frameNo.current / 30;                 // 秒
        // **开场铺开**：0→1 缓动（easeOutCubic）。所有位置/半径/亮度都乘它，
        // 于是星云从中心向外长出来，而不是一上来就满屏。
        var op = openRef.current;
        if (op.p < 1) op.p = Math.min(1, op.p + 0.028);
        var openE = 1 - Math.pow(1 - op.p, 3);
        // 自转：sin 缓动（0.6~1.0 倍速）+ 松手惯性衰减，转起来不"硬"
        if (spinRef.current) {
          var ease = 0.65 + 0.35 * Math.sin(tt * 0.23);
          r.rotY += 0.0022 * ease;
        }
        if (Math.abs(r.vel) > 1e-5) {
          r.rotY += r.vel;
          r.vel *= 0.94;                               // 惯性每秒衰减
        }
        var cY = Math.cos(r.rotY); var sY = Math.sin(r.rotY);
        var cX = Math.cos(r.rotX); var sX = Math.sin(r.rotX);
        var map = elMap.current;
        // ⚠️ 2026-10-28 第二次漏声明：AN 少了这一行 → 每帧 ReferenceError →
        // 所有点停在初始化坐标（画布中心），屏幕上看只剩一团雾。**同一个坑连踩两次。**
        var AN = animRef.current;
        frameNo.current += 1;
        var doEvi = (frameNo.current % 3) === 0;

        // **七个池心各自公转**（大节点不是一个整体）。
        // ⚠️ 2026-10-28 踩过：这段曾经漏插，而下面的代码已经引用 poolNow ——
        // 于是 projectFrame 每帧抛 ReferenceError，被 tick 里的 try/catch 吞掉，
        // 表现是"节点全冻在中心、也不报错"。**加了 try/catch 的地方必须有别的观测手段。**
        var poolNow = {};
        for (var pn = 0; pn < laid.pools.length; pn += 1) {
          var ppn = laid.pools[pn];
          var pAng = ppn.a0 + tt * ppn.rate;
          poolNow[ppn.key] = {
            x: Math.cos(pAng) * ppn.r0,
            y: Math.sin(pAng) * ppn.r0,
            z: (ppn.cz || 0) + Math.sin(tt * 0.30 + ppn.ph) * 0.10,
            spin: tt * ppn.spin + ppn.ph,
          };
        }

        function put(id, x, y, z) {
          var x2 = x * cY + z * sY;
          var z2 = -x * sY + z * cY;
          var y3 = y * cX - z2 * sX;
          var z3 = y * sX + z2 * cX;
          var k = FOCAL / (FOCAL + z3);
          // **从 0 铺开**：所有坐标乘开场进度，星云从中心长出来。
          return { sx: cx + x2 * R * k * r.zoom * openE, sy: cy + y3 * R * k * r.zoom * openE, k: k };
        }
        var shownById = {};   // 本帧"显示坐标"，给线段复用（保证线和点严格同步）

        for (var i = 0; i < laid.mem.length; i += 1) {
          var n = laid.mem[i];
          var p = laid.pos[n.id];
          var el = map[n.id];
          if (!p || !el) continue;
          var pnw = poolNow[p.key] || { x: 0, y: 0, z: 0, spin: 0 };
          var a2 = AN ? AN[n.id] : null;
          var an = (hash01(n.id + 'ph') * 6.283);
          if (a2) {
            // **行星轨道**（2026-10-29 改）：每个点绕池心走自己的圆轨道 ——
            // 半径固定、角速度按 id 固定、轨道压扁一点（椭圆感）。
            // 原来这里是"弹簧追一个带随机晃动的目标"，追的过程看起来就是在飘。
            var oAng = (a2.oa || 0) + tt * (a2.ow || 0.2);
            var oR = a2.orr || Math.sqrt((a2.ox || 0) * (a2.ox || 0) + (a2.oy || 0) * (a2.oy || 0));
            var oF = a2.of || 0.8;
            // 先在轨道平面里算出点，再按各自的倾角/朝向转到三维空间 ——
            // 这样每条轨道朝向不同，侧面看才有厚度。
            var opx = Math.cos(oAng) * oR;
            var opy = Math.sin(oAng) * oR * oF;
            var oi2 = a2.oi || 0;
            var oh2 = a2.oh || 0;
            var ci = Math.cos(oi2); var si = Math.sin(oi2);
            var ch = Math.cos(oh2); var sh = Math.sin(oh2);
            var py1 = opy * ci;                 // 绕 x 轴倾斜
            var pz1 = opy * si;
            var tx = pnw.x + opx * ch + pz1 * sh;
            var ty = pnw.y + py1;
            var tz = (pnw.z || 0) + (a2.oz || 0) + (-opx * sh + pz1 * ch);
            // **弹簧跟随**：有延迟、有惯性 —— 这就是"跟随感"
            a2.x += (tx - a2.x) * 0.075;
            a2.y += (ty - a2.y) * 0.075;
            a2.z += (tz - a2.z) * 0.075;
          }
          var curX = a2 ? a2.x : p.x;
          var curY = a2 ? a2.y : p.y;
          var curZ = a2 ? a2.z : (p.z || 0);
          shownById[n.id] = [curX, curY, curZ];
          var o = put(n.id, curX, curY, curZ);
          var w = clamp(Number(n.weight) || 0.5, 0.1, 1);
          // **每个点自己的相位**：整齐地一起明灭反而更假，散开才像活的
          var ph = (hash01(n.id) * 6.283) + (hash01(n.id + 'p') * 3.1);
          var breathe = 0.94 + 0.12 * Math.sin(tt * 1.15 + ph);
          var twinkle = 0.72 + 0.28 * Math.sin(tt * 2.1 + ph * 1.7);
          // 极缓慢的原地漂移（±1px），让静止时也不"死"
          var driftX = Math.sin(tt * 0.55 + ph) * 0.5;
          var driftY = Math.cos(tt * 0.43 + ph * 1.3) * 0.5;
          // 出生进度：新加入的点从 0 长出来（0.6 秒 = 约 18 帧）
          var born = 1;
          if (a2 && a2.b !== undefined && a2.b < 1) {
            a2.b = Math.min(1, a2.b + 0.055);
            born = a2.b;
          }
          var rad = (0.85 + 1.15 * w) * o.k * breathe * (0.30 + 0.70 * openE) * born;
          var sx2 = o.sx + driftX;
          var sy2 = o.sy + driftY;
          if (el.dot) {
            el.dot.setAttribute('cx', sx2.toFixed(1));
            el.dot.setAttribute('cy', sy2.toFixed(1));
            el.dot.setAttribute('r', Math.max(0.5, rad).toFixed(2));
            el.dot.setAttribute('opacity', (clamp((0.30 + 0.70 * o.k) * twinkle, 0.12, 1) * born).toFixed(3));
          }
          if (el.halo) {
            el.halo.setAttribute('cx', sx2.toFixed(1));
            el.halo.setAttribute('cy', sy2.toFixed(1));
            el.halo.setAttribute('r', Math.max(1.4, rad * (2.4 + 0.5 * breathe)).toFixed(2));
            el.halo.setAttribute('opacity', clamp((0.03 + 0.12 * o.k) * twinkle, 0.015, 0.24).toFixed(3));
          }
          if (el.txt) {
            el.txt.setAttribute('x', (o.sx + rad + 4).toFixed(1));
            el.txt.setAttribute('y', (o.sy + 3.2).toFixed(1));
            el.txt.setAttribute('opacity', clamp(0.2 + 0.8 * o.k, 0.15, 1).toFixed(2));
          }
        }

        for (var j = 0; j < laid.pools.length; j += 1) {
          var pc = laid.pools[j];
          var pp = laid.pos['pool:' + pc.key];
          var pel = map['pool:' + pc.key];
          if (!pp || !pel) continue;
          var pnow = poolNow[pc.key];
          var po = put('p', pnow ? pnow.x : pp.cx, pnow ? pnow.y : pp.cy, pnow ? pnow.z : 0);
          var ppulse = 1 + 0.10 * Math.sin(tt * 0.8 + j);
          if (pel.dot) {
            pel.dot.setAttribute('cx', po.sx.toFixed(1));
            pel.dot.setAttribute('cy', po.sy.toFixed(1));
            pel.dot.setAttribute('r', (2.2 * ppulse).toFixed(2));
          }
          if (pel.halo) {
            pel.halo.setAttribute('cx', po.sx.toFixed(1));
            pel.halo.setAttribute('cy', po.sy.toFixed(1));
            pel.halo.setAttribute('r', (12 * ppulse * openE).toFixed(1));
          }
          // **底雾跟着转**：原来它只在初始化算了一次，整个背景是死的（这是"硬"的主因）
          var fel = map['fog:' + pc.key];
          if (fel) {
            fel.setAttribute('cx', po.sx.toFixed(1));
            fel.setAttribute('cy', po.sy.toFixed(1));
            fel.setAttribute('r', Math.max(6, R * (0.05 + 0.010 * Math.sqrt(pc.count)) * (0.92 + 0.08 * po.k) * openE).toFixed(1));
            fel.setAttribute('opacity', (clamp(0.55 + 0.45 * po.k, 0.3, 1) * (0.25 + 0.75 * openE)).toFixed(3));
          }
          if (pel.txt) { pel.txt.setAttribute('x', (po.sx + 9).toFixed(1)); pel.txt.setAttribute('y', (po.sy - 6).toFixed(1)); }
        }

        for (var l = 0; l < laid.linkPairs.length; l += 1) {
          var pair = laid.linkPairs[l];
          var lel = map['ln:' + pair[0] + '>' + pair[1]];
          // **端点直接取节点本帧的显示坐标**（含弹簧跟随与开场插值）——
          // 再也不自己算一遍，线就不可能和点脱开。
          var sa = shownById[pair[0]]; var sb = shownById[pair[1]];
          if (!sa || !sb || !lel) continue;
          var oa = put('a', sa[0], sa[1], sa[2]);
          var ob = put('b', sb[0], sb[1], sb[2]);
          // **微弯弧线**：直线穿网太生硬，弦中点沿法线偏一点就柔了。
          // 偏的方向由 id 决定（同一对永远往同一边弯，不会每帧抖）。
          var dxL = ob.sx - oa.sx; var dyL = ob.sy - oa.sy;
          var len = Math.sqrt(dxL * dxL + dyL * dyL) || 1;
          var bowSign = (hash01(pair[0] + pair[1]) - 0.5) * 2;
          var bow = Math.min(18, len * 0.10) * bowSign;
          var mxL = (oa.sx + ob.sx) / 2 - (dyL / len) * bow;
          var myL = (oa.sy + ob.sy) / 2 + (dxL / len) * bow;
          lel.setAttribute('d',
            'M' + oa.sx.toFixed(1) + ' ' + oa.sy.toFixed(1)
            + 'Q' + mxL.toFixed(1) + ' ' + myL.toFixed(1)
            + ' ' + ob.sx.toFixed(1) + ' ' + ob.sy.toFixed(1));
          // 淡：越远越淡；再乘开场进度
          lel.setAttribute('opacity',
            (clamp(0.035 + 0.105 * ((oa.k + ob.k) / 2), 0.02, 0.17) * openE).toFixed(3));
        }

        if (doEvi) {
          for (var q = 0; q < laid.evi.length; q += 1) {
            var en = laid.evi[q];
            var ep = laid.pos[en.id];
            var eel = map[en.id];
            if (!ep || !eel) continue;
            // **跟着父节点本帧的位置走**（2026-10-29）：父点现在绕轨道转，
            // 证据点如果还用布局时的死坐标，就会脱离父点飘在外面。
            var par = shownById[en.parent];
            var ex2 = ep.x;
            var ey2 = ep.y;
            var ez2 = ep.z || 0;
            if (par) {
              var pl = laid.pos[en.parent];
              ex2 = par[0] + (ep.x - pl.x);
              ey2 = par[1] + (ep.y - pl.y);
              ez2 = par[2] + ((ep.z || 0) - (pl.z || 0));
            }
            var eo = put('e', ex2, ey2, ez2);
            eel.setAttribute('cx', eo.sx.toFixed(1));
            eel.setAttribute('cy', eo.sy.toFixed(1));
            eel.setAttribute('opacity', (clamp(0.03 + 0.13 * eo.k, 0.02, 0.2) * openE).toFixed(3));
          }
        }
      }

      /* ---- 标签只给权重前 10 ---- */
      var topIds = {};
      (function () {
        var arr = laid.mem.slice().sort(function (a, b) { return (Number(b.weight) || 0) - (Number(a.weight) || 0); });
        for (var ti = 0; ti < Math.min(10, arr.length); ti += 1) topIds[arr[ti].id] = 1;
      })();

      /* ---- 相关边（跨池的桥）---- */
      var linkEls = [];
      var linkPairs = [];
      var seen = {};
      var links = data.links || [];
      for (var lk = 0; lk < links.length; lk += 1) {
        var L = links[lk];
        if (L.kind !== 'related') continue;
        if (!laid.pos[L.source] || !laid.pos[L.target]) continue;
        var key = L.source + '>' + L.target;
        if (seen[key]) continue;
        seen[key] = 1;
        linkPairs.push([L.source, L.target]);
        // 注意：这里必须是 <path>（不是 <line>）。更新循环写的是 `d`；
        // 用 <line> 的话 setAttribute('d') 完全无效，线会停在初始的 0,0 —— 看起来"线是死的"。
        linkEls.push(h('path', {
          key: 'ln-' + key,
          ref: collect('ln:' + key),
          d: 'M0 0',
          fill: 'none',
          stroke: '#9dc2f0',
          strokeWidth: 0.45,
          strokeLinecap: 'round',
          opacity: 0.06,
        }));
      }
      laid.linkPairs = linkPairs;

      /* ---- 底雾（径向渐变，不用 filter）---- */
      var defs = h('defs', null, POOL_SPEC.map(function (p) {
        return h('radialGradient', { key: 'rg-' + p.key, id: 'chg-fog-' + p.key },
          h('stop', { offset: '0%', stopColor: p.color, stopOpacity: '0.17' }),
          h('stop', { offset: '45%', stopColor: p.color, stopOpacity: '0.07' }),
          h('stop', { offset: '100%', stopColor: p.color, stopOpacity: '0' }));
      }));
      var fogEls = laid.pools.map(function (p) {
        return h('circle', {
          key: 'fog-' + p.key,
          ref: collect('fog:' + p.key),
          cx: cx + p.cx * R, cy: cy + p.cy * R,
          r: Math.max(110, R * (0.40 + 0.05 * Math.sqrt(p.count))),
          fill: 'url(#chg-fog-' + p.key + ')', opacity: 0.85,
        });
      });

      /* ---- 依据微粒 ---- */
      var eviEls = laid.evi.map(function (en) {
        return h('circle', {
          key: 'ev-' + en.id, 'data-role': 'evi', ref: collect(en.id),
          cx: cx, cy: cy, r: 0.7, fill: poolColor(en.pool), opacity: 0.07,
        });
      });

      /* ---- 记忆球 ---- */
      var nodeEls = laid.mem.map(function (mn) {
        var col = poolColor(mn.pool);
        return h('g', {
          key: 'n-' + mn.id,
          className: 'chg-item',
          onClick: function () { pick(mn); },
        },
        h('circle', { 'data-role': 'halo', ref: function (el) { if (!elMap.current[mn.id]) elMap.current[mn.id] = {}; elMap.current[mn.id].halo = el; }, cx: cx, cy: cy, r: 2, fill: col, opacity: 0.06 }),
        h('circle', { 'data-role': 'mem', ref: function (el) { if (!elMap.current[mn.id]) elMap.current[mn.id] = {}; elMap.current[mn.id].dot = el; }, cx: cx, cy: cy, r: 1.4, fill: col, opacity: 0.9 }),
        labels && topIds[mn.id]
          ? h('text', {
            ref: function (el) { if (!elMap.current[mn.id]) elMap.current[mn.id] = {}; elMap.current[mn.id].txt = el; },
            className: 'chg-tip', x: cx, y: cy,
            style: { paintOrder: 'stroke', stroke: 'rgba(4,6,10,.85)', strokeWidth: 2.2 },
          }, String(mn.label || '').slice(0, 6))
          : null);
      });

      /* ---- 池心 ---- */
      var poolEls = laid.pools.map(function (p) {
        var col = poolColor(p.key);
        return h('g', { key: 'pl-' + p.key },
          h('circle', { ref: function (el) { if (!elMap.current['pool:' + p.key]) elMap.current['pool:' + p.key] = {}; elMap.current['pool:' + p.key].halo = el; }, cx: cx, cy: cy, r: 12, fill: col, opacity: 0.09 }),
          h('circle', { 'data-role': 'pool', ref: function (el) { if (!elMap.current['pool:' + p.key]) elMap.current['pool:' + p.key] = {}; elMap.current['pool:' + p.key].dot = el; }, cx: cx, cy: cy, r: 2.2, fill: col, opacity: 0.95 }),
          labels
            ? h('text', {
              ref: function (el) { if (!elMap.current['pool:' + p.key]) elMap.current['pool:' + p.key] = {}; elMap.current['pool:' + p.key].txt = el; },
              className: 'chg-tip chg-tip-pool', x: cx, y: cy,
            }, poolLabel(p.key) + ' ' + p.count)
            : null);
      });

      /* ---- 微尘（静态，不参与投影）---- */
      var dustEls = [];
      var DN = Math.min(900, laid.mem.length * 8);
      for (var di = 0; di < DN; di += 1) {
        var host = laid.mem[di % laid.mem.length];
        var hp = laid.pos[host.id];
        var dxs = (hash01('dx' + di) - 0.5) * 0.10;
        var dys = (hash01('dy' + di) - 0.5) * 0.08;
        dustEls.push(h('circle', {
          key: 'd-' + di,
          cx: cx + (hp.x + dxs) * R, cy: cy + (hp.y + dys) * R,
          r: 0.35 + hash01('dr' + di) * 0.4,
          fill: poolColor(host.pool),
          opacity: 0.02 + hash01('da' + di) * 0.06,
        }));
      }

      /* ---- 聚焦层 ---- */
      var focusEl = null;
      if (focus) {
        var fcol = poolColor(focus.kind === 'mood' ? 'emotion' : focus.pool);
        focusEl = h('g', { key: 'focus' },
          h('circle', { cx: cx, cy: cy, r: 58, fill: fcol, opacity: 0.05 }),
          h('circle', { cx: cx, cy: cy, r: 30, fill: fcol, opacity: 0.10 }),
          h('circle', { cx: cx, cy: cy, r: 14, fill: fcol, opacity: 0.20 }),
          h('circle', { cx: cx, cy: cy, r: 7, fill: fcol, opacity: 0.95 }));
      }

      var total = (data.stats && data.stats.total) ? data.stats.total : laid.mem.length;
      var bar = h('div', { className: 'chg-bar' },
        h('span', null, '共 ' + total + ' 条 · ' + laid.pools.length + ' 池 · ' + laid.mem.length + ' 点'),
        h('span', { className: 'chg-k', style: { fontSize: '10px', opacity: 0.5 } }, VERSION),
        h('span', { className: 'chg-k', style: { fontSize: '10px', opacity: 0.55 } }, '只属于 ' + TARGET_SESSION_LABEL),
        h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
          h('button', { className: 'chg-btn', 'data-on': spin ? '1' : '0', onClick: function () { setSpin(!spin); } }, '自转'),
          h('button', { className: 'chg-btn', 'data-on': labels ? '1' : '0', onClick: function () { setLabels(!labels); } }, '标签'),
          h('button', { className: 'chg-btn', onClick: onReset }, '复位'),
          h('button', {
            className: 'chg-btn',
            'data-on': showSettings ? '1' : '0',
            title: '记忆寿命 / 注入预算 / 夜巡时间',
            onClick: function () { setShowSettings(!showSettings); },
          }, '设置')));

      var stage = h('div', { className: 'chg-stage', ref: stageRef },
        h('svg', {
          className: 'chg-svg',
          viewBox: '0 0 ' + size.w + ' ' + size.h,
          preserveAspectRatio: 'xMidYMid meet',
          onPointerDown: onDown, onPointerMove: onMove,
          onPointerUp: onUp, onPointerLeave: onUp, onWheel: onWheel,
          onClick: function (ev) { if (ev.target && ev.target.tagName === 'svg') exit(); },
        },
        defs,
        h('g', { className: 'chg-galaxy', 'data-out': focus ? '1' : '0' },
          fogEls, dustEls, eviEls, linkEls, nodeEls, poolEls),
        focusEl),
        focus ? h(FocusPanel, { node: focus, data: data, in: panelIn, onBack: exit }) : null,
        showSettings ? h(SettingsPanel, { onClose: function () { setShowSettings(false); } }) : null);

      return h('div', { className: 'chg-root' }, bar, stage);
    }

    /* ════════════ 聚焦简介面板 ════════════ */

    function FocusPanel(props) {
      var n = props.node;
      var isMood = n.kind === 'mood';
      var col = poolColor(isMood ? 'emotion' : n.pool);
      var rows = [];

      rows.push(h('span', {
        key: 'tag', className: 'chg-pool-tag',
        style: { background: col + '22', color: col, border: '1px solid ' + col + '55' },
      }, isMood ? '我现在' : poolLabel(n.pool)));
      rows.push(h('h4', { key: 't' }, String(n.label || '')));

      if (isMood) {
        if (n.why) rows.push(h('div', { className: 'chg-field', key: 'w' },
          h('span', { className: 'chg-field-k' }, '因为'), String(n.why)));
        rows.push(h('div', { className: 'chg-field', key: 's' },
          h('span', { className: 'chg-field-k' }, '强度 / 时效'),
          '强度 ' + Number(n.strength || 0).toFixed(2) + ' · ' + Math.round(Number(n.ageHours) || 0) + ' 小时前'));
      } else {
        rows.push(h('div', { className: 'chg-field', key: 'm' },
          h('span', { className: 'chg-field-k' }, '权重 / 年龄 / 被想起'),
          Number(n.weight || 0).toFixed(2) + ' · ' + Math.round(Number(n.ageDays) || 0) + ' 天 · ' + (Number(n.touchCount) || 0) + ' 次'));
        if (n.conclusion) rows.push(h('div', { className: 'chg-field', key: 'c' },
          h('span', { className: 'chg-field-k' }, '结论'), String(n.conclusion)));
        if (n.evidence && n.evidence.length) {
          rows.push(h('div', { className: 'chg-field', key: 'e' },
            h('span', { className: 'chg-field-k' }, '依据'),
            h('ul', { className: 'chg-li' }, n.evidence.map(function (x, i) { return h('li', { key: i }, String(x)); }))));
        }
        if (n.hesitation && n.hesitation.length) {
          rows.push(h('div', { className: 'chg-field', key: 'h' },
            h('span', { className: 'chg-field-k' }, '犹豫'),
            h('ul', { className: 'chg-li' }, n.hesitation.map(function (x, i) { return h('li', { key: i }, String(x)); }))));
        }
        if (n.tags && n.tags.length) rows.push(h('div', { className: 'chg-field', key: 'g' },
          h('span', { className: 'chg-field-k' }, '标签'), n.tags.join(' · ')));
        if (n.ts) rows.push(h('div', { className: 'chg-field', key: 'd' },
          h('span', { className: 'chg-field-k' }, '写下'), shortDate(n.ts)));
      }
      rows.push(h('button', { key: 'back', className: 'chg-back', onClick: props.onBack }, '返回星系'));
      return h('div', { className: 'chg-panel', 'data-in': props.in ? '1' : '0' }, rows);
    }

    /* ════════════ 设置面板（画布右上角齿轮） ════════════ */

    /** 池的顺序与中文名（只用于显示；真正叫什么由 pools.js 决定）。 */
    var SETTINGS_POOLS = [
      ['core', '核心'],
      ['fact', '事实'],
      ['skill', '技能'],
      ['dailyCore', '核心日常'],
      ['dailyPartial', '片面日常'],
      ['emotion', '情绪'],
      ['hippocampus', '海马体'],
    ];

    /** 每个池的三个寿命字段（面板按这个顺序画三列）。 */
    var SETTINGS_FIELDS = ['graceDays', 'halfLifeDays', 'archiveDays'];

    /**
     * 记忆设置面板，画在「思维链」画布右上角。
     *
     * 数据走**插件自己的接口** `/chain/api/settings`（GET 读、POST 写）：
     * 处理器与插件在同一个进程里，所以写进去当场生效、不用重启
     * （这也是不走宿主设置页的主要原因 —— 那套要走 plugins.item 槽位 + configForms）。
     *
     * 输入框用 `defaultValue`（非受控）：受控输入在"每敲一下就发请求、回填又覆盖"时
     * 会出现光标跳动和半截数字。
     */
    function SettingsPanel(props) {
      var dataPair = React.useState(null);
      var data = dataPair[0];
      var setData = dataPair[1];
      var errPair = React.useState('');
      var err = errPair[0];
      var setErr = errPair[1];
      var timerRef = React.useRef(0);

      React.useEffect(function () {
        var alive = true;
        fetch('/chain-shared/api/settings', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (alive) setData(j); })
          .catch(function (e) { if (alive) setErr(String((e && e.message) || e)); });
        return function () { alive = false; };
      }, []);

      // 320ms 防抖：一次输入只打一次接口，敲数字时不会刷屏。
      function post(patch) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(function () {
          fetch('/chain-shared/api/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ settings: patch }),
          })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (j && j.settings) {
                setData(function (old) { return Object.assign({}, old || {}, { settings: j.settings }); });
                setErr('');
              }
            })
            .catch(function (e) { setErr(String((e && e.message) || e)); });
        }, 320);
      }

      var current = (data && data.settings) || {};
      var defaults = (data && data.defaults) || {};
      var rows = [];

      rows.push(h('div', { key: 'hd', className: 'chg-set-hd' },
        h('strong', null, '记忆设置'),
        h('button', { className: 'chg-btn', onClick: props.onClose }, '关闭')));
      rows.push(h('p', { key: 'hp', className: 'chg-set-hint' },
        '改完立刻生效，不用重启。「宽限」＝这段时间内不衰减；「半衰期」＝衰减到一半要多久。'));

      if (err) rows.push(h('p', { key: 'e', className: 'chg-set-hint' }, '写入/读取失败：' + err));
      if (!data) rows.push(h('p', { key: 'l', className: 'chg-set-hint' }, '读取中…'));

      var globals = Object.keys(defaults).map(function (key) {
        var spec = defaults[key] || {};
        var shown = current[key];
        if (shown === undefined || shown === null) shown = spec.value;
        return h('label', { key: key, className: 'chg-set-row' },
          h('span', null, spec.label || key),
          h('input', {
            type: 'number',
            min: spec.min,
            max: spec.max,
            defaultValue: shown === undefined ? '' : String(shown),
            onChange: function (ev) {
              var patch = {};
              patch[key] = ev.target.value;
              post(patch);
            },
          }));
      });
      rows.push(h('div', { key: 'g', className: 'chg-set-globals' }, globals));

      var pools = (current.pools && typeof current.pools === 'object') ? current.pools : {};
      rows.push(h('table', { key: 't', className: 'chg-set-table' },
        h('thead', null, h('tr', null,
          h('th', null, '池'),
          h('th', null, '宽限（天）'),
          h('th', null, '半衰期（天）'),
          h('th', null, '归档（天）'))),
        h('tbody', null, SETTINGS_POOLS.map(function (item) {
          var pkey = item[0];
          var cur = (pools[pkey] && typeof pools[pkey] === 'object') ? pools[pkey] : {};
          return h('tr', { key: pkey },
            h('td', null, item[1]),
            SETTINGS_FIELDS.map(function (field) {
              var shown = cur[field];
              return h('td', { key: field }, h('input', {
                type: 'number',
                min: 0,
                defaultValue: shown === undefined || shown === null ? '' : String(shown),
                placeholder: '默认',
                onChange: function (ev) {
                  var one = {};
                  one[field] = ev.target.value;
                  var patch = { pools: {} };
                  patch.pools[pkey] = one;
                  post(patch);
                },
              }));
            }));
        }))));

      if (data && data.file) {
        rows.push(h('p', { key: 'f', className: 'chg-set-hint' }, '存到：' + data.file));
      }

      return h('div', { className: 'chg-set' }, rows);
    }

    /* ════════════ 注册 ════════════ */

    var inject = ['slots'];

    function apply(ctx) {
      try {
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({
            name: 'conversation.view',
            id: 'chain-graph-shared',
            order: 95,
            label: function () { return '思维链'; },
          }, ChainGraphView);
        });
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[dsh-chain] tab register failed', e);
      }

      // 设置面板画在画布右上角（见 SettingsPanel），不需要宿主的设置槽位。
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ChainGraphView = ChainGraphView;
    exports.FocusPanel = FocusPanel;
    exports.SettingsPanel = SettingsPanel;
    return module.exports;
  },
});
