// ==UserScript==
// @name         B站关注时间一键查询
// @namespace    https://github.com/MolackTime/bili-follow-time
// @version      1.2.3
// @description  查询你关注某个 UP 主的时间；导出/筛选/排序你的全部关注列表。所有参数均可在设置面板中调整。
// @author       MolackTime
// @license      MIT
// @homepageURL  https://github.com/MolackTime/bili-follow-time
// @supportURL   https://github.com/MolackTime/bili-follow-time/issues
// @match        https://*.bilibili.com/*
// @match        https://bilibili.com/*
// @exclude      https://api.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.bilibili.com
// @connect      app.biliapi.net
// @connect      app.bilibili.com
// @connect      b23.tv
// @connect      www.bilibili.com
// @connect      cdn.jsdelivr.net
// @connect      gh-proxy.com
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * 0. 常量
   * ======================================================================= */

  var VERSION = '1.2.3';
  var DEFAULT_API_BASE = 'https://api.bilibili.com';
  var CFG_PREFIX = 'bft:cfg:';
  var UI_PREFIX = 'bft:ui:';
  var RETRYABLE = [-352, -412, -799];

  /* =========================================================================
   * 1. 基础工具
   * ======================================================================= */

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      var timer;
      function onAbort() {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      timer = setTimeout(function () {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
    });
  }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var kids = arguments[i];
      if (kids === null || kids === undefined || kids === false) continue;
      var arr = Array.isArray(kids) ? kids : [kids];
      arr.forEach(function (kid) {
        if (kid === null || kid === undefined || kid === false) return;
        el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
      });
    }
    return el;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmtFull(ts) {
    var d = new Date(ts * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtDate(ts) {
    var d = new Date(ts * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtAgo(ts) {
    var s = Math.floor(Date.now() / 1000) - ts;
    if (s < 0) return '刚刚';
    if (s < 60) return s + ' 秒前';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟前';
    var hh = Math.floor(m / 60);
    if (hh < 24) return hh + ' 小时前';
    var dd = Math.floor(hh / 24);
    if (dd < 31) return dd + ' 天前';
    var mo = Math.floor(dd / 30.44);
    if (mo < 12) return mo + ' 个月前';
    return Math.floor(dd / 365.25) + ' 年前';
  }

  function fmtTime(ts, mode) {
    if (!ts) return '—';
    if (mode === 'date') return fmtDate(ts);
    if (mode === 'ago') return fmtAgo(ts);
    return fmtFull(ts);
  }

  /* attribute 的完整取值（B站文档）：
     0 未关注 / 1 悄悄关注（官方标注已下线，但值仍可能出现）/ 2 已关注 / 6 已互粉 / 128 已拉黑。
     ⚠️ 一定要按 attribute 判定关系，不能按 mtime ——
        「已关注但接口没给 mtime」是真实存在的（mtime 为 0），
        旧代码拿 mtime 当主判据，会把它误报成「未关注」。 */
  function attrLabel(a) {
    switch (Number(a)) {
      case 0: return '未关注';
      case 1: return '悄悄关注';
      case 2: return '已关注';
      case 6: return '已互粉';
      case 128: return '已拉黑';
      default: return '状态未知';
    }
  }

  /* 悄悄关注也算关注（值 1） */
  function attrFollowed(a) {
    var n = Number(a);
    return n === 1 || n === 2 || n === 6;
  }

  /* 给用户看的原始值，便于在"结果不符预期"时自证 */
  function relDetail(rel) {
    var s = '接口返回：attribute=' +
      (rel.attribute === undefined || rel.attribute === null ? '(缺失)' : rel.attribute) +
      '，mtime=' + (rel.mtime || 0) + '，mid ' + rel.mid;
    if (rel.conflict && rel.via) {
      s += '　⚠️ 两个接口结论不一致：' + rel.via.map(function (x) {
        return x.name + ' → ' + (x.ok ? ('attribute=' + (x.attribute === null ? '(缺失)' : x.attribute)) : ('失败 ' + (x.error || '')));
      }).join('；');
    }
    return s;
  }

  /* 完整诊断文本：一键复制发给开发者，不用再靠猜 */
  function relDiagText(rel) {
    var L = [];
    L.push('=== B站关注时间脚本 · 关系查询诊断 ===');
    L.push('时间: ' + new Date().toLocaleString());
    L.push('脚本版本: v' + VERSION);
    L.push('页面: ' + location.href);
    L.push('目标 mid: ' + rel.mid);
    L.push('判定结果: ' + attrLabel(rel.attribute) +
      '（attribute=' + (rel.attribute === undefined || rel.attribute === null ? '(缺失)' : rel.attribute) +
      ', mtime=' + (rel.mtime || 0) + '）');
    if (rel.conflict) L.push('⚠️ 两个接口结论冲突 —— 已按"取已关注"处理');
    L.push('');
    L.push('--- 各接口原始返回 ---');
    (rel.via || []).forEach(function (x) {
      L.push('· ' + x.name + ' → ' + (x.ok
        ? ('attribute=' + (x.attribute === null ? '(缺失)' : x.attribute) + ', mtime=' + x.mtime)
        : ('失败: ' + (typeof x.code === 'number' ? ('code ' + x.code + ' ') : '') + (x.error || ''))));
      if (x.raw) {
        var t = JSON.stringify(x.raw);
        if (t.length > 1200) t = t.slice(0, 1200) + ' …(已截断)';
        L.push('    raw: ' + t);
      }
    });
    L.push('');
    L.push('UA: ' + navigator.userAgent);
    return L.join('\n');
  }

  /* 「结果不符预期」时的逃生口：一键把诊断信息复制走 */
  function diagBtn(rel) {
    return h('button', {
      class: 'mini',
      text: '⧉ 复制诊断信息',
      title: '复制两个接口的原始返回、脚本版本、当前页面等，便于反馈问题',
      onclick: function () {
        var okCopy = copyText(relDiagText(rel));
        toast(okCopy ? '诊断信息已复制 —— 粘贴发给开发者即可' : '复制失败', okCopy ? '' : 'err');
      }
    });
  }

  /* 终审按钮：两个关系接口都说"未关注"时，去自己的关注列表里找一次 */
  function verifyBtn(mid) {
    return h('button', {
      class: 'mini',
      text: '↻ 去我的关注列表里核实',
      title: '直接翻你自己的关注列表找这个 mid —— 这是最准的真值来源',
      onclick: async function () {
        var btn = this;
        if (btn.disabled) return;
        var old = btn.textContent;
        btn.disabled = true;
        btn.textContent = '正在翻你的关注列表…';
        try {
          var r = await verifyByFollowings(mid, function (p) {
            btn.textContent = '翻到第 ' + p.page + ' 页 · 已扫 ' + p.got + ' 条' +
              (p.total ? (' / 共 ' + p.total) : '') + '…';
          }, null);
          if (r.found) {
            var it = r.item || {};
            var m = Number(it.mtime) || 0;
            showMsg(ui.msgSingle,
              '在你的关注列表里【找到了】mid ' + mid + '：attribute=' + it.attribute +
              (m ? ('，关注时间 ' + fmtTime(m, cfg.get('timeFormat')) + '，时间戳 ' + m)
                 : '（列表里也没给 mtime）') +
              '　→ 说明关系接口刚才返回的数据有误，请把诊断信息发我。', 'ok');
          } else {
            showMsg(ui.msgSingle,
              '已扫描 ' + r.scanned + ' 条关注' +
              (r.total ? ('（你共关注 ' + r.total + ' 个账号）') : '') +
              '，其中【没有】mid ' + mid + '。基本可以确认：当前登录账号没有关注它。' +
              '（再核对一下浏览器登录的是哪个账号、以及是不是同一个 UP）', 'warn');
          }
        } catch (e) {
          showMsg(ui.msgSingle, friendlyError(e), 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = old;
        }
      }
    });
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + ' 秒';
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    if (m < 60) return s ? m + ' 分 ' + s + ' 秒' : m + ' 分钟';
    var hh = Math.floor(m / 60);
    var mm = m % 60;
    return mm ? hh + ' 小时 ' + mm + ' 分' : hh + ' 小时';
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1500);
  }

  function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return true; }
    } catch (e) { /* ignore */ }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /* =========================================================================
   * 2. mid 解析
   * ======================================================================= */

  function parseMidSync(input) {
    var s = String(input === null || input === undefined ? '' : input).trim();
    if (!s) return null;
    if (/^\d{1,12}$/.test(s)) return { mid: s, kind: 'raw' };

    /* space.bilibili.com/<mid>
       ⚠️ 必须把第一段整个取出来做「全数字」判断，不能写成 \/(\d+) 就完事 ——
       那样 /309b23d9-804a-49d8-a310-3cd878df9299 会被截成 mid=309，
       静默查成一个完全无关的真实用户。 */
    var m = s.match(/space\.bilibili\.com\/([^\s\/?#\u4e00-\u9fa5]+)/i);
    if (m) {
      var seg = m[1];
      if (/^\d{1,12}$/.test(seg)) return { mid: seg, kind: 'space' };
      return { error: 'SPACE_NOT_MID', seg: seg };
    }

    /* 分享链接里的查询参数。数字后同样要求边界，避免 mid=309abc 被截成 309 */
    m = s.match(/[?&](?:mid|up_id|uid|fid|vmid)=(\d{1,12})(?=[&#]|$)/i);
    if (m) return { mid: m[1], kind: 'query' };

    if (/^https?:\/\/b23\.tv\/[A-Za-z0-9_-]+/i.test(s)) {
      m = s.match(/https?:\/\/b23\.tv\/[A-Za-z0-9_-]+/i);
      return { short: m[0], kind: 'short' };
    }

    /* 从分享文案里抠链接。
       ⚠️ 必须判断 m[0] !== s 才递归 —— 否则抠出来的就是原串本身，
       会无限递归直到 RangeError: Maximum call stack size exceeded
       （任何非 bilibili 的 https 链接都能触发）。 */
    m = s.match(/https?:\/\/[^\s"'<>\u4e00-\u9fa5]+/);
    if (m && m[0] !== s) {
      var inner = parseMidSync(m[0]);
      if (inner) return inner;
    }
    return null;
  }

  function resolveRedirect(url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('当前环境不支持短链解析'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        redirect: 'follow',
        timeout: 15000,
        onload: function (r) { resolve((r && r.finalUrl) || url); },
        onerror: function () { reject(new Error('短链解析失败（网络错误）')); },
        ontimeout: function () { reject(new Error('短链解析超时')); }
      });
    });
  }

  /* 把解析错误翻成给人看的话。所有入口共用，避免各处文案不一致。 */
  function parseErrorText(p) {
    if (!p || !p.error) return '解析失败';
    switch (p.error) {
      case 'FORMAT':
        return '无法识别输入。支持：UP 主主页链接（space.bilibili.com/数字 mid）、纯数字 mid、b23.tv 短链。';
      case 'SPACE_NOT_MID':
        return '链接不对：space.bilibili.com 后面必须是纯数字的 mid，' +
          '而你给的这一段是「' + (p.seg || '') + '」。' +
          '这看起来不是 UP 主主页链接（可能是失效的分享链接或复制串了）。';
      case 'NO_USER':
        return '这个 mid（' + p.mid + '）对应的用户不存在，请检查链接是否完整、数字有没有复制漏。';
      case 'SHORT_OFF':
        return '短链解析已关闭（可在「设置 → 解析」里重新打开）。';
      case 'SHORT_FAIL':
        return '短链解析失败：' + (p.detail || '网络错误');
      case 'SHORT_NO_MID':
        return '这条短链指向的内容里没有 UP 主信息，请在 B 站 App 里点进 TA 的主页再复制链接。';
      default:
        return '解析失败：' + p.error;
    }
  }

  /* 存在性校验。返回 true=存在 / false=确定不存在 / null=问不出来（风控、网络等）
     只有明确 false 才应该阻断流程，null 一律放行。 */
  async function checkUserExists(mid, signal) {
    try {
      var j = await apiGet('/x/web-interface/card', { mid: mid }, { signal: signal });
      if (!j) return null;
      if (j.code === -404) return false;
      if (j.code === 0 && j.data && j.data.card) return true;
      return null;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      return null;
    }
  }

  async function parseMid(input, signal) {
    var r = parseMidSync(input);
    if (!r) return { error: 'FORMAT' };
    if (r.error) return r;          /* 已经在同步阶段判定为坏链接（如 UUID 段） */

    if (r.short) {
      if (!cfg.get('resolveShort')) return { error: 'SHORT_OFF' };

      var finalUrl;
      try {
        finalUrl = await resolveRedirect(r.short);
      } catch (e) {
        return { error: 'SHORT_FAIL', detail: e && e.message ? e.message : String(e) };
      }

      var q = finalUrl.match(/[?&](?:mid|up_id|uid|vmid)=(\d{1,12})(?=[&#]|$)/i);
      if (q) {
        r = { mid: q[1], kind: 'short-query', from: finalUrl };
      } else {
        var sp = finalUrl.match(/space\.bilibili\.com\/(\d{1,12})(?=[\/?#]|$)/i);
        if (sp) {
          r = { mid: sp[1], kind: 'short-space', from: finalUrl };
        } else {
          r = { kind: 'short' };
          var bv = finalUrl.match(/\/video\/(BV[0-9A-Za-z]{10})/);
          if (bv) {
            try {
              var j = await apiGet('/x/web-interface/view', { bvid: bv[1] }, { signal: signal });
              if (j && j.code === 0 && j.data && j.data.owner && j.data.owner.mid) {
                r = { mid: String(j.data.owner.mid), kind: 'short-video', from: finalUrl };
              }
            } catch (e) { /* 尽力而为，失败就走下面的 SHORT_NO_MID */ }
          }
          if (!r.mid) return { error: 'SHORT_NO_MID', from: finalUrl };
        }
      }
    }

    /* 解析出 mid 之后可选地确认一下这个人真的存在，
       免得"用户不存在"被误报成"未关注 / 0 条"。 */
    if (cfg.get('verifyUser')) {
      var exists = await checkUserExists(r.mid, signal);
      if (exists === false) return { error: 'NO_USER', mid: r.mid };
    }
    return r;
  }

  /* =========================================================================
   * 3. 配置系统（schema 驱动）
   * ======================================================================= */

  var GROUPS = [
    { key: 'query', label: '查询' },
    { key: 'speed', label: '速度' },
    { key: 'parse', label: '解析' },
    { key: 'display', label: '显示' },
    { key: 'ui', label: '界面' },
    { key: 'update', label: '更新' }
  ];

  var SCHEMA = [
    /* ---- A 查询 ---- */
    {
      key: 'ps', group: 'query', label: '每页条数', type: 'number', def: 50,
      min: 10, max: 50, step: 5,
      hint: '接口硬上限 50。调小不会更快，反而增加请求次数与风控概率。' +
        '注意：查他人时若用「兼容接口」，ps 会被服务端固定为 50，此项对它无效。'
    },
    {
      key: 'orderType', group: 'query', label: '列表排序', type: 'select', def: '',
      options: [{ value: '', label: '按关注顺序' }, { value: 'attention', label: '按常访问' }],
      hint: '只影响接口返回顺序，不改变 mtime。表格里可以随时重新排序。'
    },
    {
      key: 'maxPages', group: 'query', label: '最大翻页数', type: 'number', def: 100,
      min: 1, max: 200, step: 1,
      hint: '兜底保护，防止异常情况下无限翻页。'
    },
    {
      key: 'limitCount', group: 'query', label: '最多拉取条数', type: 'number', def: 0,
      min: 0, max: 100000, step: 50,
      hint: '0 = 不限。只想看「最近 N 个关注」时填 N。'
    },
    {
      key: 'othersEndpoint', group: 'query', label: '查他人用哪个接口', type: 'select', def: 'app',
      options: [
        { value: 'app', label: '兼容接口（上限 250 条）' },
        { value: 'web', label: '标准接口（上限 100 条）' }
      ],
      hint: '兼容接口可翻 5 页共 250 条，读公开关注列表甚至无需登录；标准接口只有前 100 条，' +
        '超过后接口会静默返回空列表（code 仍是 0，很容易误以为对方只关注了 100 人）。'
    },
    {
      key: 'othersCap', group: 'query', label: '查他人条数上限', type: 'number', def: 250,
      min: 1, max: 250, step: 10,
      hint: '实际上限受接口限制：兼容接口 250 条、标准接口 100 条。设超了会被自动夹紧。'
    },
    {
      key: 'verifyUser', group: 'query', label: '查询前校验用户是否存在', type: 'switch', def: true,
      hint: '解析出 mid 后先花一次轻量请求确认这个用户真的存在，避免把「用户不存在」' +
        '误报成「未关注 / 共 0 条」。觉得多一次请求碍事可以关掉。'
    },

    /* ---- B 速度与网络 ---- */
    {
      key: 'interval', group: 'speed', label: '请求间隔', type: 'presets', def: 1700,
      min: 300, max: 10000, step: 100, unit: 'ms',
      presets: [
        { value: 2000, label: '保守' },
        { value: 1700, label: '标准' },
        { value: 1000, label: '快速' },
        { value: 500, label: '极速' }
      ],
      hint: '相邻两次接口请求的最小间隔。调小更快，也更容易触发 -352 风控。',
      risk: function (v) { return v < 1000; }
    },
    {
      key: 'timeout', group: 'speed', label: '请求超时', type: 'number', def: 20000,
      min: 5000, max: 60000, step: 1000, unit: 'ms',
      hint: '单次请求超时时间。网络较差时调大。'
    },
    {
      key: 'retryMax', group: 'speed', label: '最大重试轮数', type: 'number', def: 2,
      min: 0, max: 5, step: 1,
      hint: '命中风控后最多重试几轮；0 = 不重试，遇到风控直接中止。',
      risk: function (v) { return v === 0; }
    },
    {
      key: 'backoff352', group: 'speed', label: '风控退避起点 (-352)', type: 'number', def: 3000,
      min: 1000, max: 30000, step: 500, unit: 'ms',
      hint: '遇到「风控校验失败」时，首次等待多久再重试。'
    },
    {
      key: 'backoff412', group: 'speed', label: '拦截退避起点 (-412)', type: 'number', def: 6000,
      min: 1000, max: 60000, step: 500, unit: 'ms',
      hint: '遇到「IP 被拦截」时，首次等待多久再重试。'
    },
    {
      key: 'jitter', group: 'speed', label: '退避随机抖动', type: 'range', def: 100,
      min: 0, max: 100, step: 10, unit: '%',
      hint: '在退避时长上叠加随机比例，避免规律性重试被识别。100% 表示 1~2 倍。'
    },
    {
      key: 'forceGM', group: 'speed', label: '强制走后台通道', type: 'switch', def: false,
      hint: '开启后所有请求都走扩展后台（绕开页面限制）。页面请求异常时可打开。'
    },

    /* ---- C 解析与接口 ---- */
    {
      key: 'resolveShort', group: 'parse', label: '解析 b23.tv 短链', type: 'switch', def: true,
      hint: '开启后可粘贴 b23.tv 短链。关闭后短链会直接报错，速度略快。'
    },
    {
      key: 'dedupe', group: 'parse', label: '结果自动去重', type: 'switch', def: true,
      hint: '按 mid 去重，避免出现重复行。'
    },
    {
      key: 'apiBase', group: 'parse', label: 'API 域名', type: 'text', def: DEFAULT_API_BASE,
      hint: '一般不需要修改。填错会导致所有查询失败，可在设置里一键恢复默认。',
      risk: function (v) { return v !== DEFAULT_API_BASE; },
      confirm: true
    },

    /* ---- D 显示与导出 ---- */
    {
      key: 'timeFormat', group: 'display', label: '时间格式', type: 'select', def: 'full',
      options: [
        { value: 'full', label: 'YYYY-MM-DD HH:mm:ss' },
        { value: 'date', label: 'YYYY-MM-DD' },
        { value: 'ago', label: '相对时间（3 天前）' }
      ],
      hint: '表格与导出文件中时间的显示方式。'
    },
    {
      key: 'csvBom', group: 'display', label: 'CSV 带 BOM', type: 'switch', def: true,
      hint: '开启后 Excel 打开中文不乱码；用脚本处理数据时可关闭。'
    },
    {
      key: 'csvDelimiter', group: 'display', label: 'CSV 分隔符', type: 'select', def: ',',
      options: [{ value: ',', label: '逗号 ,' }, { value: '\t', label: '制表符 \\t' }],
      hint: '制表符分隔的文件直接粘进 Excel 会自动分列。'
    },
    {
      key: 'exportFields', group: 'display', label: '导出字段', type: 'multi',
      def: ['uname', 'mid', 'time', 'ago', 'attr', 'mtime'],
      options: [
        { value: 'uname', label: '昵称' },
        { value: 'mid', label: 'mid' },
        { value: 'time', label: '关注时间' },
        { value: 'ago', label: '距今' },
        { value: 'attr', label: '关系' },
        { value: 'mtime', label: '关注时间戳' }
      ],
      hint: '勾选需要写进导出文件的列。'
    },
    {
      key: 'rowLimit', group: 'display', label: '表格每屏行数', type: 'select', def: '100',
      options: [
        { value: '50', label: '50 行' },
        { value: '100', label: '100 行' },
        { value: '200', label: '200 行' },
        { value: 'all', label: '全部' }
      ],
      hint: '超过 1000 行时建议保留限制，直接导出查看更快。'
    },

    /* ---- E 界面与体验 ---- */
    {
      key: 'theme', group: 'ui', label: '面板主题', type: 'select', def: 'auto',
      options: [
        { value: 'auto', label: '跟随系统' },
        { value: 'light', label: '浅色' },
        { value: 'dark', label: '深色' }
      ],
      hint: '只影响本工具面板，不改动 B 站页面本身。'
    },
    {
      key: 'ballPos', group: 'ui', label: '悬浮球位置', type: 'select', def: 'br',
      options: [
        { value: 'br', label: '右下' },
        { value: 'bl', label: '左下' },
        { value: 'tr', label: '右上' },
        { value: 'tl', label: '左上' },
        { value: 'hide', label: '隐藏' }
      ],
      hint: '隐藏后仍可通过 Tampermonkey 菜单重新打开面板。'
    },
    {
      key: 'autoSpaceChip', group: 'ui', label: '空间页自动提示', type: 'switch', def: true,
      hint: '打开某个 UP 主的主页时，自动显示「你关注 TA 的时间」。'
    },
    {
      key: 'rememberPanel', group: 'ui', label: '记住面板状态', type: 'switch', def: true,
      hint: '记住面板是否展开，以及上次输入的内容。'
    },

    /* ---- F 更新 ---- */
    {
      key: 'checkUpdate', group: 'update', label: '检查脚本更新', type: 'switch', def: true,
      hint: '定期对比远端版本号，发现新版会在面板顶部提示。关闭后仍可用油猴自带的更新机制。'
    },
    {
      key: 'updateCheckHours', group: 'update', label: '检查间隔', type: 'number', def: 12,
      min: 1, max: 168, step: 1, unit: '小时',
      hint: '两次自动检查之间的最短间隔。手动点「检查更新」不受此限制。'
    }
  ];

  function makeConfig(schema) {
    var map = Object.create(null);
    schema.forEach(function (it) { map[it.key] = it; });
    var listeners = [];

    function emit(key, val) {
      listeners.forEach(function (fn) {
        try { fn(key, val); } catch (e) { console.error('[BFT] listener error', e); }
      });
    }

    function clamp(it, v) {
      if (!it) return v;
      switch (it.type) {
        case 'number':
        case 'range':
        case 'presets': {
          var n = Number(v);
          if (!isFinite(n)) return it.def;
          if (it.min !== undefined && it.min !== null) n = Math.max(it.min, n);
          if (it.max !== undefined && it.max !== null) n = Math.min(it.max, n);
          return n;
        }
        case 'switch': {
          if (typeof v === 'boolean') return v;
          if (v === 'true' || v === 1 || v === '1') return true;
          if (v === 'false' || v === 0 || v === '0') return false;
          return it.def;
        }
        case 'select': {
          var hit = it.options.some(function (o) { return o.value === v; });
          return hit ? v : it.def;
        }
        case 'multi': {
          if (!Array.isArray(v)) return it.def.slice();
          var allowed = {};
          it.options.forEach(function (o) { allowed[o.value] = true; });
          var out = v.filter(function (x) { return allowed[x]; });
          return out.length ? out : it.def.slice();
        }
        default: {
          if (typeof v === 'string' && v.trim()) return v.trim();
          return it.def;
        }
      }
    }

    var api = {
      schema: schema,
      get: function (key) {
        var it = map[key];
        if (!it) return undefined;
        var raw = GM_getValue(CFG_PREFIX + key, it.def);
        if (it.type === 'multi' && typeof raw === 'string') {
          try { raw = JSON.parse(raw); } catch (e) { raw = it.def; }
        }
        return clamp(it, raw);
      },
      set: function (key, val) {
        var it = map[key];
        if (!it) return undefined;
        var v = clamp(it, val);
        var cur = api.get(key);
        if (JSON.stringify(v) === JSON.stringify(cur)) return v;
        GM_setValue(CFG_PREFIX + key, v);
        emit(key, v);
        return v;
      },
      all: function () {
        var o = {};
        schema.forEach(function (it) { o[it.key] = api.get(it.key); });
        return o;
      },
      reset: function () {
        schema.forEach(function (it) { GM_setValue(CFG_PREFIX + it.key, it.def); });
        emit('*', null);
      },
      exportJSON: function () {
        return JSON.stringify({ _tool: 'bili-follow-time', _version: VERSION, config: api.all() }, null, 2);
      },
      importJSON: function (json) {
        var o;
        try { o = JSON.parse(json); } catch (e) { return false; }
        var src = (o && o.config) ? o.config : o;
        if (!src || typeof src !== 'object') return false;
        schema.forEach(function (it) {
          if (Object.prototype.hasOwnProperty.call(src, it.key)) api.set(it.key, src[it.key]);
        });
        return true;
      },
      onChange: function (fn) {
        listeners.push(fn);
        return function () {
          var i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      }
    };
    return api;
  }

  var cfg = makeConfig(SCHEMA);

  /* =========================================================================
   * 4. 请求层（页面 fetch 主通道 + GM 后台降级）
   * ======================================================================= */

  var lastAt = 0;

  function ApiError(code, message) {
    this.name = 'ApiError';
    this.code = code;
    this.message = message || ('错误码 ' + code);
    if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  /* 兼容接口所在的域名。注意：它【不返回任何 CORS 头】，
     所以页面 fetch 必被浏览器拦下，只能走 GM 后台通道。 */
  var APP_BASE = 'https://app.biliapi.net';

  function buildUrl(path, params, baseOverride) {
    var base = String(baseOverride || cfg.get('apiBase') || DEFAULT_API_BASE).replace(/\/+$/, '');
    var url;
    try {
      url = new URL(base + path);
    } catch (e) {
      throw new Error('API 域名无效：' + base + '（可在设置里点「恢复默认」）');
    }
    if (params) {
      Object.keys(params).forEach(function (k) {
        var v = params[k];
        if (v === undefined || v === null || v === '') return;
        url.searchParams.set(k, String(v));
      });
    }
    return url.toString();
  }

  function apiGetGM(url, opts) {
    opts = opts || {};
    var signal = opts.signal;
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('后台请求通道不可用'));
        return;
      }
      var req = GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        headers: (opts.referer === false) ? {} : { Referer: 'https://www.bilibili.com/' },
        timeout: cfg.get('timeout'),
        responseType: 'json',
        /* ⚠️ 必须显式声明带凭证。
           后台通道默认【不发送 Cookie】，而 B 站几乎所有业务接口都要靠 SESSDATA
           才认得出"你是谁"。不带的话，要么直接 -101「账号未登录」，
           要么更糟 —— 静默返回一份"匿名视角"的数据（比如关系全是未关注）。
           用 opts.credentials === false 可对确实不需要登录态的请求关掉。 */
        withCredentials: opts.credentials !== false,
        onload: function (r) {
          try {
            var d = (r.response && typeof r.response === 'object') ? r.response : JSON.parse(r.responseText);
            resolve(d);
          } catch (e) {
            reject(new Error('响应解析失败'));
          }
        },
        onerror: function () { reject(new Error('网络错误')); },
        ontimeout: function () { reject(new Error('请求超时')); }
      });
      if (signal) {
        if (signal.aborted) {
          try { req.abort(); } catch (e) { /* ignore */ }
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', function () {
          try { req.abort(); } catch (e) { /* ignore */ }
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }
    });
  }

  async function apiGet(path, params, opts) {
    opts = opts || {};
    var url = buildUrl(path, params, opts.base);
    var signal = opts.signal;

    /* opts.forceGM：该域名没有 CORS 头，或需要绕过页面限制时，直接走后台通道，
       免得白白多一次注定失败的请求。 */
    if (!opts.forceGM && !cfg.get('forceGM') && typeof fetch === 'function') {
      try {
        var res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          signal: signal || undefined,
          headers: { Accept: 'application/json, text/plain, */*' }
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        console.warn('[BFT] 页面通道失败，降级到后台通道：', e && e.message);
      }
    }
    return apiGetGM(url, opts);
  }

  async function throttled(fn, signal) {
    var wait = Math.max(0, cfg.get('interval') - (Date.now() - lastAt));
    if (wait) await sleep(wait, signal);
    lastAt = Date.now();
    return fn();
  }

  async function backoff(code, signal, round) {
    var base = (code === -412) ? cfg.get('backoff412') : cfg.get('backoff352');
    var jitter = cfg.get('jitter') / 100;
    var ms = Math.round(base * Math.pow(1.6, Math.max(0, round - 1)) * (1 + Math.random() * jitter));
    toast('触发风控（' + code + '），' + (ms / 1000).toFixed(1) + 's 后重试…', 'warn');
    await sleep(ms, signal);
  }

  /* =========================================================================
   * 5. 业务层
   * ======================================================================= */

  /* ---- 登录态 ---- */
  var auth = { checked: false, isLogin: false, mid: null, uname: '', netError: null };
  var LOGIN_URL = 'https://passport.bilibili.com/login?gourl=' +
    encodeURIComponent('https://www.bilibili.com');

  function openLogin() {
    try {
      window.open(LOGIN_URL, '_blank', 'noopener');
    } catch (e) {
      location.href = LOGIN_URL;
    }
  }

  async function checkLogin(signal) {
    try {
      var j = await apiGet('/x/web-interface/nav', null, { signal: signal });
      if (j && j.code === 0 && j.data && j.data.isLogin && j.data.mid) {
        auth = { checked: true, isLogin: true, mid: String(j.data.mid), uname: j.data.uname || '', netError: null };
      } else {
        auth = { checked: true, isLogin: false, mid: null, uname: '', netError: null };
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      auth = {
        checked: true,
        isLogin: false,
        mid: null,
        uname: '',
        netError: (e && e.message) ? e.message : '网络异常'
      };
    }
    applyAuthUI();
    return auth;
  }

  async function ensureLogin(signal) {
    if (!auth.checked || !auth.isLogin) await checkLogin(signal);
    return auth.isLogin;
  }

  function markLoggedOut() {
    auth = { checked: true, isLogin: false, mid: null, uname: '', netError: null };
    applyAuthUI();
  }

  /* 在消息区渲染「未登录」提示 + 操作按钮 */
  function showLoginRequired(el, extra) {
    if (!el) return;
    el.className = 'msg warn';
    el.textContent = '';
    el.hidden = false;
    el.appendChild(document.createTextNode(
      (extra || '未登录 B 站：查询关注时间需要登录后才能使用。') + ' '));
    el.appendChild(h('button', { text: '去登录', onclick: openLogin }));
    el.appendChild(h('button', {
      text: '重新检测',
      onclick: function () {
        el.textContent = '检测中…';
        checkLogin(null)
          .then(function () {
            if (auth.isLogin) {
              showMsg(el, '已检测到登录：' +
                (auth.uname ? auth.uname + '（' + auth.mid + '）' : 'mid ' + auth.mid) +
                '，现在可以查询了。', 'ok');
              flashLoggedIn();
            } else if (auth.netError) {
              showMsg(el, '无法确认登录状态（' + auth.netError + '），请检查网络后重试。', 'warn');
            } else {
              showMsg(el, '仍未检测到登录状态。请确认已在浏览器登录 B 站，然后重新检测。', 'warn');
            }
          })
          .catch(function (e2) {
            showMsg(el, friendlyError(e2), 'err');
          });
      }
    }));
  }

  /* 统一错误上报：-101 单独走「去登录」引导 */
  function reportError(el, e) {
    if (e && e.code === -101) {
      markLoggedOut();
      showLoginRequired(el);
      return;
    }
    showMsg(el, friendlyError(e), (e && e.name === 'AbortError') ? 'warn' : 'err');
  }

  function friendlyError(e) {
    if (!e) return '未知错误';
    if (e.name === 'AbortError') return '已中止';
    var c = e.code;
    if (c === -101) return '未登录：请先在浏览器登录 B 站再试。';
    if (c === -352) return '触发 B 站风控（-352）。可把「请求间隔」调大后重试，或先在 B 站正常浏览几秒。';
    if (c === -412) return 'IP 被拦截（-412）。请等待几分钟后再试，或更换网络。';
    if (c === -799) return '请求过快（-799）。请在设置里把「请求间隔」调大。';
    if (c === -400) return '请求错误（-400）。接口参数可能已变化。';
    if (c === 22115 || c === 22118) return '对方未开放关注列表，无法查询。';
    if (c === 22007) return '已到兼容接口的翻页上限（最多前 5 页 / 250 条）。';
    if (c === 22001) return '目标用户不存在或已被封禁。';
    if (typeof c === 'number') return (e.message || '接口错误') + '（' + c + '）';
    return e.message || String(e);
  }

  async function getSelfMid(signal) {
    if (!auth.checked || !auth.isLogin) await checkLogin(signal);
    return auth.isLogin ? auth.mid : null;
  }

  /* ---- 关系查询：双接口交叉验证 ----
     背景（2026-09-30 用户反馈）：在某 UP 主页显示 attribute=0（"未关注"），但实际已关注。
     实测两个接口在【无有效凭证】时都返回 -101「账号未登录」而不是 0 ——
     也就是说 attribute=0 是"带着登录态"时服务端给出的结论，那就必须能区分：
       (a) 真的没关注　vs　(b) 某个接口返回了异常/降级数据
     做法：主接口拿到的结论若是"不是已关注"，再用备用接口复核一次。
       · 主接口  /x/relation?fid=                 （旧接口，一直沿用）
       · 备用接口 /x/web-interface/relation?mid=   （Bilibili-Evolved 采用，经大量用户验证）
     已关注时【零额外请求】；两者冲突时取"已关注"，并明确把冲突告诉用户。 */
  var REL_PROBES = [
    /* 主接口用 web-interface 版：Bilibili-Evolved 等成熟工具采用它，长期线上验证；
       旧的 /x/relation GET 版保留作备用（本脚本一直用它，兼容老行为）。 */
    { name: '/x/web-interface/relation', path: '/x/web-interface/relation', param: 'mid' },
    { name: '/x/relation', path: '/x/relation', param: 'fid' }
  ];

  function relationOf(j, fid) {
    var rel = (j && j.data && j.data.relation) || null;
    if (!rel) return null;          /* 结构不符 → 交给上层报"结构异常"，不要静默当 0 */
    var att = rel.attribute;
    return {
      mid: String(fid),
      mtime: Number(rel.mtime) || 0,
      /* attribute 缺失时保留 null 而不是塞 0 —— 0 是"未关注"的有效取值，
         拿它当兜底会把"没这个字段"伪装成"确认未关注"。 */
      attribute: (att === undefined || att === null || att === '') ? null : Number(att),
      beRelation: (j.data && j.data.be_relation) || null
    };
  }

  function relDiag(p) {
    var o = { name: p.name, ok: !!p.ok };
    if (p.ok) { o.attribute = p.attribute; o.mtime = p.mtime; }
    else { o.error = p.error || '?'; if (typeof p.code === 'number') o.code = p.code; }
    if (p.raw) o.raw = p.raw;
    return o;
  }

  async function probeRelation(p, fid, signal) {
    var out = { name: p.name, ok: false };
    try {
      var params = {};
      params[p.param] = fid;
      var j = await apiGet(p.path, params, { signal: signal });
      if (!j) { out.error = '空响应'; return out; }
      out.code = j.code;
      if (j.code !== 0) { out.error = j.message || ('code ' + j.code); out.raw = j; return out; }
      var rel = relationOf(j, fid);
      if (!rel) { out.error = '响应里没有 data.relation'; out.raw = j; return out; }
      out.ok = true;
      out.attribute = rel.attribute;
      out.mtime = rel.mtime;
      out.rel = rel;
      out.raw = j;
      return out;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      out.error = (e && e.message) ? e.message : String(e);
      if (e && typeof e.code === 'number') out.code = e.code;
      return out;
    }
  }

  async function fetchRelation(fid, signal) {
    var first = await probeRelation(REL_PROBES[0], fid, signal);

    /* 主接口明确"已关注 / 悄悄关注 / 互粉" → 直接用，不再多发请求 */
    if (first.ok && attrFollowed(first.attribute)) {
      first.rel.via = [relDiag(first)];
      first.rel.conflict = false;
      return first.rel;
    }

    /* 主接口给出"未关注 / 状态未知"，或干脆失败了 → 换另一个接口复核 */
    var second = await probeRelation(REL_PROBES[1], fid, signal);
    var via = [relDiag(first), relDiag(second)];

    /* 两条都没拿到可用数据：按主接口的错误抛出，保持原有错误处理链路 */
    if (!first.ok && !second.ok) {
      if (typeof first.code === 'number' && first.code !== 0) throw new ApiError(first.code, first.error);
      throw new Error('两个关系接口都没能查到：' +
        first.name + ' → ' + (first.error || '?') + '；' +
        second.name + ' → ' + (second.error || '?'));
    }

    var chosen, conflict = false;
    if (first.ok && second.ok) {
      conflict = String(first.attribute) !== String(second.attribute);
      /* 冲突时取"已关注"的那个 —— 宁可显示已关注，也不能误报未关注 */
      chosen = (attrFollowed(second.attribute) && !attrFollowed(first.attribute)) ? second.rel : first.rel;
    } else {
      chosen = first.ok ? first.rel : second.rel;
    }
    chosen.via = via;
    chosen.conflict = conflict;
    return chosen;
  }

  /* 关注列表两个接口的真实上限（2026-09-30 实测）：
     ┌ 标准接口 /x/relation/followings
     │   自己 = 全量可分页；他人 = 前 100 条。
     │   ⚠️ 超过 100 条时它【静默返回空列表，code 仍是 0】，很容易让人误以为对方只关注了 100 人。
     └ 兼容接口 /x/v2/relation/followings（域名 app.biliapi.net）
         自己 = 全量；他人 = 前 5 页，即 ps(50) × 5 = 250 条；
         第 6 页起返回 code 22007「限制只访问前5页」。
         ⚠️ ps 被服务端钉死在 50（传 100/250/500 都只回 50）；
         ⚠️ 该域名【不返回任何 CORS 头】，页面 fetch 必被拦，只能走 GM 后台通道。 */
  var ENDPOINT = {
    web: { path: '/x/relation/followings', base: undefined, psFixed: 0, othersMax: 100, maxPages: Infinity, forceGM: false },
    app: { path: '/x/v2/relation/followings', base: APP_BASE, psFixed: 50, othersMax: 250, maxPages: 5, forceGM: true }
  };

  async function fetchFollowings(vmid, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var signal = opts.signal;
    var orderType = cfg.get('orderType');
    var limit = cfg.get('limitCount');
    /* 早停目标：用于"去关注列表里核实某个 mid 在不在" —— 命中就停，不白翻后面几十页 */
    var stopAtMid = opts.stopAtMid ? String(opts.stopAtMid) : null;

    var selfMid = opts.selfMid;
    if (selfMid === undefined) {
      try { selfMid = await getSelfMid(signal); } catch (e) { selfMid = null; }
    }
    var isSelf = !!selfMid && String(vmid) === String(selfMid);

    /* 自己的关注一律走标准接口 —— 它给全量，没有 250 的封顶。
       查他人时才按设置选接口。 */
    var spec = (!isSelf && cfg.get('othersEndpoint') === 'app') ? ENDPOINT.app : ENDPOINT.web;
    var useApp = (spec === ENDPOINT.app);

    var ps = spec.psFixed || cfg.get('ps');

    /* 三个约束取最小：接口自身上限、用户设的"查他人上限"、"最多拉取条数" */
    var byEndpoint = isSelf ? Infinity : spec.othersMax;
    var cap = Math.min(byEndpoint, isSelf ? Infinity : cfg.get('othersCap'));
    if (limit > 0) cap = Math.min(cap, limit);
    var hardCap = cap;

    /* 页数：接口页数上限、用户"最大翻页数"、按 cap 反推所需页数，三者取最小。
       同时记下"是谁先卡住的"，好让提示文案说得准（用户设的限 vs 接口的限）。 */
    var maxPages = cfg.get('maxPages');
    var pageLimitFrom = 'user';
    if (spec.maxPages !== Infinity && spec.maxPages < maxPages) { maxPages = spec.maxPages; pageLimitFrom = 'endpoint'; }
    if (hardCap !== Infinity) {
      var needPages = Math.ceil(hardCap / ps);
      if (needPages < maxPages) { maxPages = needPages; pageLimitFrom = 'cap'; }
    }

    var collected = [];
    var total = null;
    var retries = 0;
    var stopped = 'end';

    for (var pn = 1; pn <= maxPages; pn++) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

      var j = await throttled(function () {
        return apiGet(spec.path, {
          vmid: vmid, pn: pn, ps: ps,
          order_type: isSelf ? orderType : ''
        }, {
          signal: signal,
          base: spec.base,          /* app 接口换域名 */
          forceGM: spec.forceGM,    /* app 域名无 CORS 头，直接走后台，省掉一次注定失败的请求 */
          referer: useApp ? false : true
        });
      }, signal);

      if (j && j.code === 0) {
        retries = 0;
        var list = (j.data && j.data.list) || [];
        if (j.data && typeof j.data.total === 'number') total = j.data.total;
        collected = collected.concat(list);
        onProgress({ page: pn, got: collected.length, total: total, isSelf: isSelf });

        /* 早停：命中目标 mid 就收工（"去关注列表核实"用） */
        if (stopAtMid && list.some(function (it) { return String(it.mid) === stopAtMid; })) {
          stopped = 'found';
          break;
        }

        /* 到顶了。区分是"用户自己设的条数上限"还是"接口硬上限" */
        if (collected.length >= hardCap) {
          stopped = (hardCap < byEndpoint) ? 'cap' : 'endpoint';
          break;
        }
        if (!list.length) { stopped = 'empty'; break; }
        if (list.length < ps) { stopped = 'end'; break; }
        if (total !== null && collected.length >= total) { stopped = 'total'; break; }
        if (pn >= maxPages) {
          stopped = (pageLimitFrom === 'endpoint') ? 'endpoint'
            : (pageLimitFrom === 'cap' ? 'cap' : 'more');
        }
        continue;
      }

      var code = j ? j.code : null;
      /* 22007 是兼容接口的翻页上限，属于"正常走到顶"，不当错误处理 */
      if (code === 22007) { stopped = 'endpoint'; break; }
      if (RETRYABLE.indexOf(code) >= 0 && retries < cfg.get('retryMax')) {
        retries++;
        await backoff(code, signal, retries);
        pn--;
        continue;
      }
      throw new ApiError(code, j && j.message);
    }

    var out = collected;
    if (cfg.get('dedupe')) {
      var seen = {};
      out = collected.filter(function (it) {
        var k = String(it.mid);
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });
    }
    if (hardCap !== Infinity && out.length > hardCap) out = out.slice(0, hardCap);

    return {
      list: out,
      isSelf: isSelf,
      selfMid: selfMid,
      total: total !== null ? total : out.length,
      endpoint: useApp ? 'app' : 'web',
      endpointMax: isSelf ? null : spec.othersMax,
      stopped: stopped
    };
  }

  /* ---- 终审兜底：直接去【你自己的关注列表】里找这个 mid ----
     两个关系接口都说"未关注"时，列表是最后一个真值来源 ——
     列表里每一条本来就带 attribute 和 mtime，是你账号下最直接的记录。
     只在用户手动点击时执行（要翻页，耗时与关注数成正比），命中即停。 */
  async function verifyByFollowings(mid, onProgress, signal) {
    var selfMid = await getSelfMid(signal);
    if (!selfMid) throw new Error('未登录，无法拉取你的关注列表');
    var res = await fetchFollowings(selfMid, {
      signal: signal,
      selfMid: selfMid,
      stopAtMid: mid,
      onProgress: onProgress
    });
    var hit = null;
    (res.list || []).forEach(function (it) {
      if (String(it.mid) === String(mid)) hit = it;
    });
    return {
      found: !!hit,
      item: hit,
      scanned: (res.list || []).length,
      total: res.total,
      stopped: res.stopped
    };
  }

  /* =========================================================================
   * 5.5 更新检查
   * ======================================================================= */

  /* 三个镜像都问一遍，取「所有成功结果里的最大版本」。
     ⚠️ jsDelivr 的分支缓存是 12 小时，刚发版时它可能仍返回旧版本 ——
        所以必须同时问实时源（gh-proxy / raw），否则会误报"已是最新"。 */
  var UPDATE_SOURCES = [
    'https://cdn.jsdelivr.net/gh/MolackTime/bili-follow-time@main/bili-follow-time.user.js',
    'https://gh-proxy.com/https://raw.githubusercontent.com/MolackTime/bili-follow-time/main/bili-follow-time.user.js',
    'https://raw.githubusercontent.com/MolackTime/bili-follow-time/main/bili-follow-time.user.js'
  ];
  var LAST_CHECK_KEY = 'bft:update:lastCheck';
  var DISMISS_KEY = 'bft:update:dismissed';

  var updateInfo = null;   /* { latest } */

  function parseVer(v) {
    return String(v || '').replace(/^v/i, '').trim().split(/[.\-+]/)
      .map(function (x) { return parseInt(x, 10) || 0; });
  }

  function cmpVer(a, b) {
    var x = parseVer(a), y = parseVer(b);
    var n = Math.max(x.length, y.length);
    for (var i = 0; i < n; i++) {
      var xi = x[i] || 0, yi = y[i] || 0;
      if (xi > yi) return 1;
      if (xi < yi) return -1;
    }
    return 0;
  }

  function extractVersion(text) {
    var m = String(text || '').match(/^[ \t]*\/\/[ \t]*@version[ \t]+(\S+)/m);
    return m ? m[1] : null;
  }

  function fetchTextGM(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('无可用通道')); return; }
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: timeoutMs || 12000,
        onload: function (r) {
          if (r.status >= 200 && r.status < 300) resolve(r.responseText);
          else reject(new Error('HTTP ' + r.status));
        },
        onerror: function () { reject(new Error('网络错误')); },
        ontimeout: function () { reject(new Error('超时')); }
      });
    });
  }

  function fetchText(url, timeoutMs) {
    var ms = timeoutMs || 12000;
    if (typeof fetch !== 'function') return fetchTextGM(url, ms);
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms) : 0;
    return fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .catch(function () {
        clearTimeout(timer);
        return fetchTextGM(url, ms);   /* 页面通道不行就换后台通道 */
      });
  }

  /* 返回 { url, version } —— 不仅要知道最新版本是多少，还要知道【哪个源】报的。
     坑：jsDelivr 有 12 小时分支缓存，刚发版时它仍返回旧版本。
     如果更新时照旧打开"安装来源 URL"（多半是 jsDelivr），就会重新装回旧版，
     于是「发现新版本」永远反复出现。所以必须用报出最新版的那个源去更新。 */
  function fetchLatestVersion() {
    return Promise.all(UPDATE_SOURCES.map(function (u) {
      return fetchText(u).then(function (t) {
        var v = extractVersion(t);
        return v ? { url: u, version: v } : null;
      }).catch(function () { return null; });
    })).then(function (list) {
      var best = null;
      list.forEach(function (r) {
        if (r && (!best || cmpVer(r.version, best.version) > 0)) best = r;
      });
      return best;
    });
  }

  function applyUpdateUI() {
    var hasNew = !!(updateInfo && updateInfo.latest);
    if (ui.updateBar) {
      if (hasNew) {
        ui.updateBar.hidden = false;
        ui.updateText.textContent = '发现新版本 v' + updateInfo.latest +
          '（当前 v' + VERSION + '）。更新后需要重新加载 B 站页面才会生效。';
      } else {
        ui.updateBar.hidden = true;
      }
    }
    if (ui.verBtn) {
      ui.verBtn.textContent = hasNew ? ('v' + VERSION + ' → v' + updateInfo.latest) : ('v' + VERSION);
      ui.verBtn.title = hasNew ? '点击更新' : '点击检查更新';
      ui.verBtn.classList.toggle('hasnew', hasNew);
    }
    applyBallPos();
  }

  function updateInstallUrl() {
    var url = null;
    try {
      var s = (typeof GM_info !== 'undefined' && GM_info && GM_info.script) ? GM_info.script : {};
      url = s.downloadURL || s.updateURL || s.fileURL || null;
    } catch (e) { /* ignore */ }
    return url || UPDATE_SOURCES[0];
  }

  function openUpdate() {
    /* 优先用「报出最新版本的那个源」，而不是安装来源 URL ——
       jsDelivr 的 12 小时缓存会让我们又装回旧版本，导致提示反复出现。 */
    window.open((updateInfo && updateInfo.url) || updateInstallUrl(), '_blank', 'noopener');
    toast('已打开安装页 —— 点「重新安装 / 安装」即可');
  }

  function dismissUpdate() {
    if (updateInfo && updateInfo.latest) GM_setValue(DISMISS_KEY, updateInfo.latest);
    updateInfo = null;
    applyUpdateUI();
    toast('已忽略该版本，下次发布仍会提示');
  }

  async function checkUpdate(manual) {
    if (!manual && !cfg.get('checkUpdate')) return;

    if (!manual) {
      var last = Number(GM_getValue(LAST_CHECK_KEY, 0)) || 0;
      var hours = cfg.get('updateCheckHours') || 12;
      if (Date.now() - last < hours * 3600 * 1000) return;   /* 还没到下次检查时间 */
    }
    if (manual && ui.verBtn) ui.verBtn.disabled = true;

    var found = null;   /* { url, version } */
    try { found = await fetchLatestVersion(); } catch (e) { /* 全部源都挂了 */ }

    GM_setValue(LAST_CHECK_KEY, Date.now());
    if (manual && ui.verBtn) ui.verBtn.disabled = false;

    if (!found) {
      if (manual) toast('检查更新失败：镜像与原始地址都不可达', 'warn');
      return;
    }

    if (cmpVer(found.version, VERSION) > 0 && GM_getValue(DISMISS_KEY, '') !== found.version) {
      updateInfo = { latest: found.version, url: found.url };
      applyUpdateUI();
      if (manual) toast('发现新版本 v' + found.version);
    } else {
      updateInfo = null;
      applyUpdateUI();
      if (manual) toast('已是最新版本 v' + VERSION);
    }
  }

  /* =========================================================================
   * 6. UI
   * ======================================================================= */

  var CSS = [
    ':host{all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;}',
    '*{box-sizing:border-box;}',
    '.bft{--bg:#ffffff;--fg:#1f2329;--muted:#8a919f;--line:#e5e7eb;--soft:#f6f7f8;',
    '--accent:#00a1d6;--accent-fg:#ffffff;--danger:#e5484d;--warn:#c8871a;--warnbg:#fff8e6;--dangerbg:#fff0f0;',
    '--shadow:0 8px 32px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    'font-size:13px;line-height:1.55;color:var(--fg);-webkit-font-smoothing:antialiased;}',
    '.bft.dark{--bg:#1f2023;--fg:#e8eaed;--muted:#9aa0a6;--line:#35373b;--soft:#26282c;',
    '--accent:#00a1d6;--danger:#ff6b6b;--warn:#f0b429;--warnbg:#3a2f14;--dangerbg:#3a1f1f;',
    '--shadow:0 8px 32px rgba(0,0,0,.5),0 1px 3px rgba(0,0,0,.4);}',
    '.bft *{font-family:inherit;font-size:inherit;}',
    'button{font-family:inherit;font-size:inherit;cursor:pointer;border:1px solid var(--line);',
    'background:var(--bg);color:var(--fg);border-radius:6px;padding:4px 10px;transition:.15s;}',
    'button:hover{border-color:var(--accent);color:var(--accent);}',
    'button.primary{background:var(--accent);border-color:var(--accent);color:#fff;}',
    'button.primary:hover{filter:brightness(1.08);color:#fff;}',
    'button:disabled{opacity:.5;cursor:not-allowed;}',
    /* 结果区里的辅助按钮（复制诊断 / 去关注列表核实）：更小更轻，不抢主操作 */
    'button.mini{font-size:11.5px;padding:2px 9px;line-height:1.6;color:var(--muted);}',
    'button.mini:hover{color:var(--accent);border-color:var(--accent);}',
    'input,select{font-family:inherit;font-size:inherit;color:var(--fg);background:var(--bg);',
    'border:1px solid var(--line);border-radius:6px;padding:4px 8px;outline:none;}',
    'input:focus,select:focus{border-color:var(--accent);}',
    'input[type=range]{padding:0;border:none;background:transparent;}',
    'input[type=checkbox]{width:auto;padding:0;border:none;background:transparent;accent-color:var(--accent);}',

    /* 悬浮球 */
    '.ball{position:fixed;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;',
    'justify-content:center;font-size:20px;padding:0;box-shadow:var(--shadow);z-index:2147483001;',
    'background:var(--bg);border:1px solid var(--line);}',
    '.ball:hover{transform:scale(1.08);}',
    '.pos-br{right:20px;bottom:20px;}.pos-bl{left:20px;bottom:20px;}',
    '.pos-tr{right:20px;top:80px;}.pos-tl{left:20px;top:80px;}',

    /* 面板 */
    '.panel{position:fixed;width:min(760px,94vw);max-height:min(82vh,760px);background:var(--bg);',
    'border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);display:flex;',
    'flex-direction:column;overflow:hidden;z-index:2147483002;}',
    '.panel.pos-br{right:20px;bottom:76px;left:auto;top:auto;}',
    '.panel.pos-bl{left:20px;bottom:76px;right:auto;top:auto;}',
    '.panel.pos-tr{right:20px;top:132px;left:auto;bottom:auto;}',
    '.panel.pos-tl{left:20px;top:132px;right:auto;bottom:auto;}',
    /* 任何带 hidden 的元素都必须真的隐藏。
       ⚠️ 作者样式表里的 display:flex/block 会盖过浏览器默认的 [hidden]{display:none}，
       所以必须显式 !important —— .loginbar 就是因为漏了这条而永远关不掉。
       这里用 .bft [hidden] 通配，避免以后新增组件再漏。 */
    '.bft [hidden]{display:none!important;}',
    '.p-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);}',
    '.p-head .ttl{font-weight:600;flex:1;}',
    '.p-tabs{display:flex;gap:4px;padding:8px 14px 0;}',
    '.p-tabs button{border-radius:6px 6px 0 0;border-bottom-color:transparent;}',
    '.p-tabs button.on{background:var(--soft);border-color:var(--line);border-bottom-color:transparent;',
    'font-weight:600;color:var(--accent);}',
    '.p-body{padding:12px 14px;overflow:auto;flex:1;min-height:120px;}',
    '.p-foot{display:flex;align-items:center;gap:8px;padding:8px 14px;border-top:1px solid var(--line);',
    'color:var(--muted);font-size:12px;}',
    '.p-foot .sp{flex:1;}',
    '.row{display:flex;gap:8px;align-items:center;}',
    '.row.wrap{flex-wrap:wrap;}',
    '.row input[type=text]{flex:1;min-width:180px;}',
    '.gap{margin-top:10px;}',
    '.muted{color:var(--muted);font-size:12px;}',
    '.card{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 12px;}',
    '.kv{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;}',
    '.kv .big{font-size:20px;font-weight:600;color:var(--accent);}',
    '.tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:12px;',
    'background:var(--soft);border:1px solid var(--line);color:var(--muted);}',
    '.bar{height:6px;background:var(--soft);border-radius:3px;overflow:hidden;margin-top:8px;}',
    '.bar > i{display:block;height:100%;background:var(--accent);width:0;transition:width .2s;}',
    '.msg{padding:8px 10px;border-radius:6px;margin-top:8px;font-size:12px;}',
    '.msg.err{background:var(--dangerbg);color:var(--danger);border:1px solid currentColor;}',
    '.msg.warn{background:var(--warnbg);color:var(--warn);border:1px solid currentColor;}',
    '.msg.ok{background:var(--soft);border:1px solid var(--line);}',
    '.tools{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px;}',
    '.tbl-wrap{margin-top:10px;max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:8px;}',
    'table{width:100%;border-collapse:collapse;font-size:12px;}',
    'th,td{padding:5px 8px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;}',
    'th{position:sticky;top:0;background:var(--soft);cursor:pointer;user-select:none;font-weight:600;}',
    'th:hover{color:var(--accent);}',
    'td.num{font-variant-numeric:tabular-nums;}',
    'tbody tr:hover{background:var(--soft);}',
    '.empty{padding:18px;text-align:center;color:var(--muted);}',

    /* 设置抽屉 */
    '.drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,96vw);background:var(--bg);',
    'border-left:1px solid var(--line);box-shadow:var(--shadow);display:flex;flex-direction:column;',
    'z-index:2147483003;}',
    '.d-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);}',
    '.d-head .ttl{font-weight:600;flex:1;}',
    '.d-tools{display:flex;gap:6px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--line);}',
    '.d-tools input[type=text]{flex:1;min-width:120px;}',
    '.d-warn{margin:10px 16px 0;padding:8px 10px;border-radius:6px;font-size:12px;',
    'background:var(--warnbg);color:var(--warn);border:1px solid currentColor;}',
    '.d-body{flex:1;overflow:auto;padding:8px 16px 24px;}',
    '.grp{margin-top:14px;}',
    '.grp > h4{margin:0 0 6px;font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.06em;}',
    '.item{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px dashed var(--line);}',
    '.item:last-child{border-bottom:none;}',
    '.item .lab{width:132px;flex:none;padding-top:3px;}',
    '.item .lab .q{display:inline-block;width:14px;height:14px;line-height:14px;text-align:center;',
    'border-radius:50%;border:1px solid var(--line);color:var(--muted);font-size:10px;cursor:help;}',
    '.item .ctl{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;}',
    '.item.risk .lab{color:var(--danger);}',
    '.item.risk .ctl input,.item.risk .ctl select{border-color:var(--danger);}',
    '.pills{display:flex;gap:5px;flex-wrap:wrap;}',
    '.pills button{padding:2px 10px;border-radius:12px;font-size:12px;}',
    '.pills button.on{background:var(--accent);border-color:var(--accent);color:#fff;}',
    '.inl{display:flex;gap:6px;align-items:center;}',
    '.inl input[type=number]{width:92px;}',
    '.inl .unit{color:var(--muted);font-size:12px;}',
    '.multi{display:flex;gap:10px;flex-wrap:wrap;}',
    '.multi label{display:inline-flex;gap:4px;align-items:center;cursor:pointer;}',
    '.hintx{color:var(--muted);font-size:11.5px;}',
    '.riskx{color:var(--danger);font-size:11.5px;}',

    /* 空间页小标签 */
    '.chip{position:fixed;left:16px;top:76px;z-index:2147483000;background:var(--bg);border:1px solid var(--line);',
    'border-radius:8px;padding:6px 12px;box-shadow:var(--shadow);font-size:12px;',
    'max-width:min(680px,92vw);line-height:1.6;}',
    '.chip b{color:var(--accent);}',

    /* toast */
    '.toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:var(--bg);',
    'border:1px solid var(--line);border-radius:8px;padding:8px 14px;box-shadow:var(--shadow);',
    'font-size:12px;z-index:2147483004;max-width:80vw;}',
    '.toast.warn{color:var(--warn);border-color:currentColor;}',
    '.toast.err{color:var(--danger);border-color:currentColor;}',

    /* 未登录提醒 */
    '.ball.warn{box-shadow:0 0 0 2px var(--danger),var(--shadow);}',
    '.ball.warn::after{content:"!";position:absolute;top:-3px;right:-3px;width:17px;height:17px;',
    'border-radius:50%;background:var(--danger);color:#fff;font-size:11px;line-height:17px;',
    'text-align:center;font-weight:700;}',
    '.loginbar{display:flex;gap:8px;align-items:center;padding:8px 14px;background:var(--warnbg);',
    'color:var(--warn);border-bottom:1px solid var(--line);font-size:12px;}',
    '.loginbar .txt{flex:1;min-width:0;line-height:1.5;}',
    '.loginbar button{background:transparent;border-color:currentColor;color:inherit;padding:2px 10px;flex:none;}',
    '.loginbar button:hover{background:var(--warn);color:#fff;}',
    '.loginbar.ok{background:#f0fbf4;color:#2e9e5b;}',
    '.loginbar.ok button:hover{background:#2e9e5b;color:#fff;}',
    '.bft.dark .loginbar.ok{background:#1b2c22;color:#5ddb8f;}',

    /* 更新提示 */
    '.updatebar{display:flex;gap:8px;align-items:center;padding:8px 14px;background:#eef8fd;',
    'color:#0b7fa8;border-bottom:1px solid var(--line);font-size:12px;}',
    '.updatebar .txt{flex:1;min-width:0;line-height:1.5;}',
    '.updatebar button{background:transparent;border-color:currentColor;color:inherit;padding:2px 10px;flex:none;}',
    '.updatebar button:hover{background:#0b7fa8;color:#fff;}',
    '.updatebar button.primary{background:#0b7fa8;border-color:#0b7fa8;color:#fff;}',
    '.updatebar button.primary:hover{filter:brightness(1.1);}',
    '.bft.dark .updatebar{background:#122b36;color:#5cc8e8;}',
    '.ball.update{box-shadow:0 0 0 2px var(--accent),var(--shadow);}',
    '.ball.update::after{content:"↑";position:absolute;top:-3px;right:-3px;width:17px;height:17px;',
    'border-radius:50%;background:var(--accent);color:#fff;font-size:11px;line-height:17px;',
    'text-align:center;font-weight:700;}',
    '.vbtn{border:none;background:transparent;color:var(--muted);padding:2px 6px;font-size:12px;}',
    '.vbtn:hover{color:var(--accent);border-color:transparent;}',
    '.vbtn.hasnew{color:#0b7fa8;font-weight:600;}',
    '.bft.dark .vbtn.hasnew{color:#5cc8e8;}',
    '.msg button{padding:1px 9px;font-size:11.5px;margin-left:2px;}'
  ].join('');

  var host = null;
  var root = null;
  var ui = {};

  function ensureHost() {
    if (host && host.isConnected && root) return;
    host = document.createElement('div');
    host.id = 'bft-host';
    (document.documentElement || document.body).appendChild(host);
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    var wrap = h('div', { class: 'bft' });
    root.appendChild(wrap);
    ui.wrap = wrap;
  }

  function toast(text, kind) {
    ensureHost();
    var t = ui.toast;
    if (!t) {
      t = h('div', { class: 'toast', hidden: true });
      ui.wrap.appendChild(t);
      ui.toast = t;
    }
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, kind ? 4200 : 2200);
  }

  function applyTheme() {
    if (!ui.wrap) return;
    var mode = cfg.get('theme');
    var dark = mode === 'dark' ||
      (mode === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    ui.wrap.classList.toggle('dark', !!dark);
  }

  function ballClass() {
    var p = cfg.get('ballPos');
    return p === 'bl' ? 'pos-bl' : p === 'tr' ? 'pos-tr' : p === 'tl' ? 'pos-tl' : 'pos-br';
  }

  /* 悬浮球角标：未登录 > 有新版 > 无（只显示一个，未登录更紧急） */
  function ballBadge() {
    if (auth.checked && !auth.isLogin) return 'warn';
    if (updateInfo && updateInfo.latest) return 'update';
    return '';
  }

  function applyBallPos() {
    if (!ui.ball) return;
    var p = cfg.get('ballPos');
    var badge = ballBadge();
    ui.ball.className = 'ball ' + ballClass() + (badge ? ' ' + badge : '');
    ui.ball.hidden = (p === 'hide');
    if (ui.panel) {
      ui.panel.className = 'panel ' + ballClass();
    }
  }

  /* 登录态相关的界面联动：横幅 + 悬浮球角标 + 账号提示 */
  function applyAuthUI() {
    var notLogin = auth.checked && !auth.isLogin;
    var uncertain = auth.checked && !auth.isLogin && !!auth.netError;

    if (ui.loginBar) {
      if (!auth.checked) {
        ui.loginBar.hidden = true;
      } else if (uncertain) {
        ui.loginBar.hidden = false;
        ui.loginText.textContent = '无法确认登录状态（' + auth.netError + '）。';
        ui.btnGoLogin.hidden = true;
      } else if (notLogin) {
        ui.loginBar.hidden = false;
        ui.loginText.textContent = '检测到你还未登录 B 站。查询关注时间需要登录后才能使用。';
        ui.btnGoLogin.hidden = false;
      } else {
        ui.loginBar.hidden = true;
      }
    }

    if (ui.ball) {
      applyBallPos();
      if (notLogin) ui.ball.title = '尚未登录 B 站 —— 点击打开面板查看说明';
      else if (updateInfo && updateInfo.latest) ui.ball.title = '发现新版本 v' + updateInfo.latest + ' —— 点击查看';
      else ui.ball.title = 'B站关注时间查询（点击打开 / 关闭）';
    }

    if (ui.selfHint) {
      if (!auth.checked) ui.selfHint.textContent = '正在检测登录状态…';
      else if (auth.isLogin) {
        ui.selfHint.textContent = '已登录：' +
          (auth.uname ? auth.uname + '（mid ' + auth.mid + '）' : 'mid ' + auth.mid);
      } else if (uncertain) ui.selfHint.textContent = '无法确认登录状态，可点下方按钮重新检测';
      else ui.selfHint.textContent = '未登录 B 站 —— 请先登录后再拉取';
    }
  }

  /* 手动「重新检测」成功后，把横幅短暂切成绿色的「已登录：xxx」再自动收起，
     让用户明确看到检测结果，而不是"点了没反应、横幅直接消失"。 */
  var loginFlashTimer = 0;
  function flashLoggedIn() {
    if (!ui.loginBar || !auth.isLogin) { applyAuthUI(); return; }
    ui.loginBar.hidden = false;
    ui.loginBar.className = 'loginbar ok';
    ui.loginText.textContent = '已登录：' +
      (auth.uname ? auth.uname + '（mid ' + auth.mid + '）' : 'mid ' + auth.mid);
    ui.btnGoLogin.hidden = true;
    clearTimeout(loginFlashTimer);
    loginFlashTimer = setTimeout(function () {
      ui.loginBar.className = 'loginbar';
      ui.loginBar.hidden = true;
      ui.btnGoLogin.hidden = false;
    }, 2800);
  }

  /* ---------- Toast / tooltip ---------- */

  /* =========================================================================
   * 7. 结果表格
   * ======================================================================= */

  var state = {
    rows: [],
    sortKey: 'mtime',
    sortDir: 'desc',
    year: '',
    keyword: ''
  };

  var COLS = [
    { key: 'uname', label: '昵称' },
    { key: 'mid', label: 'mid' },
    { key: 'time', label: '关注时间' },
    { key: 'ago', label: '距今' },
    { key: 'attr', label: '关系' }
  ];

  function applyFilterSort() {
    var rows = state.rows.slice();
    if (state.year) {
      rows = rows.filter(function (r) {
        return r.mtime && new Date(r.mtime * 1000).getFullYear() === Number(state.year);
      });
    }
    if (state.keyword) {
      var kw = state.keyword.toLowerCase();
      rows = rows.filter(function (r) {
        return String(r.uname || '').toLowerCase().indexOf(kw) >= 0 || String(r.mid).indexOf(kw) >= 0;
      });
    }
    var dir = state.sortDir === 'asc' ? 1 : -1;
    var k = state.sortKey;
    rows.sort(function (a, b) {
      var av = a[k], bv = b[k];
      if (k === 'uname' || k === 'attr') {
        av = String(av); bv = String(bv);
        return av.localeCompare(bv, 'zh') * dir;
      }
      return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
    });
    return rows;
  }

  function buildYearOptions() {
    var set = {};
    state.rows.forEach(function (r) {
      if (r.mtime) set[new Date(r.mtime * 1000).getFullYear()] = true;
    });
    var years = Object.keys(set).map(Number).sort(function (a, b) { return b - a; });
    var sel = ui.yearSel;
    if (!sel) return;
    sel.textContent = '';
    sel.appendChild(h('option', { value: '' }, '全部年份'));
    years.forEach(function (y) { sel.appendChild(h('option', { value: String(y) }, y + ' 年')); });
    sel.value = years.indexOf(Number(state.year)) >= 0 ? state.year : '';
  }

  function renderTable() {
    if (!ui.tbody || !ui.tblWrap) return;
    var rows = applyFilterSort();
    ui.tbody.textContent = '';

    if (!rows.length) {
      ui.tblWrap.hidden = true;
      ui.empty.hidden = false;
      ui.empty.textContent = state.rows.length ? '当前筛选条件下没有结果。' : '还没有数据。';
      ui.count.textContent = '';
      return;
    }

    var limitRaw = cfg.get('rowLimit');
    var limit = limitRaw === 'all' ? rows.length : Number(limitRaw) || 100;
    var shown = rows.slice(0, limit);

    var fmt = cfg.get('timeFormat');
    shown.forEach(function (r) {
      ui.tbody.appendChild(h('tr', null,
        h('td', { text: r.uname || '(未知)' }),
        h('td', { class: 'num', text: r.mid }),
        h('td', { class: 'num', text: fmtTime(r.mtime, fmt) }),
        h('td', { class: 'num', text: r.mtime ? fmtAgo(r.mtime) : '—' }),
        h('td', null, h('span', { class: 'tag', text: attrLabel(r.attribute) }))
      ));
    });

    ui.tblWrap.hidden = false;
    ui.empty.hidden = true;
    ui.count.textContent = '共 ' + state.rows.length + ' 条' +
      (rows.length !== state.rows.length ? '（筛选后 ' + rows.length + ' 条）' : '') +
      (shown.length < rows.length ? '，当前显示前 ' + shown.length + ' 行' : '');
  }

  function renderHead() {
    if (!ui.thead || !ui.theadRow) return;
    ui.theadRow.textContent = '';
    COLS.forEach(function (c) {
      var arrow = state.sortKey === c.key ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      ui.theadRow.appendChild(h('th', {
        text: c.label + arrow,
        onclick: function () {
          if (state.sortKey === c.key) {
            state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            state.sortKey = c.key;
            state.sortDir = c.key === 'uname' || c.key === 'attr' ? 'asc' : 'desc';
          }
          renderHead();
          renderTable();
        }
      }));
    });
  }

  /* =========================================================================
   * 8. 导出
   * ======================================================================= */

  function csvCell(v, delim) {
    var s = (v === null || v === undefined) ? '' : String(v);
    if (s.indexOf('"') >= 0 || s.indexOf(delim) >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function exportRows(kind) {
    var rows = applyFilterSort();
    if (!rows.length) { toast('没有可导出的数据', 'warn'); return; }
    var stamp = fmtFull(Math.floor(Date.now() / 1000)).replace(/[-: ]/g, '');

    if (kind === 'json') {
      download('bili-followings-' + stamp + '.json',
        JSON.stringify(rows.map(function (r) {
          return {
            uname: r.uname, mid: r.mid, mtime: r.mtime,
            time: r.mtime ? fmtFull(r.mtime) : '',
            attribute: r.attribute, relation: attrLabel(r.attribute)
          };
        }), null, 2),
        'application/json;charset=utf-8');
      toast('已导出 JSON');
      return;
    }

    var fields = cfg.get('exportFields');
    var delim = cfg.get('csvDelimiter') === '\t' ? '\t' : ',';
    var fmt = cfg.get('timeFormat');
    var headerMap = { uname: '昵称', mid: 'mid', time: '关注时间', ago: '距今', attr: '关系', mtime: '关注时间戳' };
    var cellMap = {
      uname: function (r) { return r.uname || ''; },
      mid: function (r) { return r.mid; },
      time: function (r) { return r.mtime ? fmtTime(r.mtime, fmt) : ''; },
      ago: function (r) { return r.mtime ? fmtAgo(r.mtime) : ''; },
      attr: function (r) { return attrLabel(r.attribute); },
      mtime: function (r) { return r.mtime || ''; }
    };

    var lines = [];
    lines.push(fields.map(function (f) { return csvCell(headerMap[f] || f, delim); }).join(delim));
    rows.forEach(function (r) {
      lines.push(fields.map(function (f) { return csvCell(cellMap[f] ? cellMap[f](r) : '', delim); }).join(delim));
    });

    var text = lines.join('\r\n');
    if (cfg.get('csvBom')) text = '\ufeff' + text;
    download('bili-followings-' + stamp + (delim === '\t' ? '.tsv' : '.csv'),
      text, 'text/csv;charset=utf-8');
    toast('已导出 ' + rows.length + ' 条');
  }

  /* =========================================================================
   * 9. 面板构建
   * ======================================================================= */

  var ctrl = { abort: null, busy: false };

  function setBusy(busy, text) {
    ctrl.busy = busy;
    var btns = [ui.btnSingle, ui.btnMine, ui.btnOther, ui.btnAbort];
    btns.forEach(function (b) { if (b) b.disabled = busy ? true : false; });
    if (ui.btnAbort) ui.btnAbort.disabled = !busy;
    if (ui.progressText) ui.progressText.textContent = text || '';
  }

  function setProgress(cur, total) {
    if (!ui.progressBar) return;
    var pct = total ? Math.min(100, Math.round(cur / total * 100)) : 0;
    ui.progressBar.style.width = pct + '%';
  }

  function showMsg(el, text, kind) {
    if (!el) return;
    el.className = 'msg' + (kind ? ' ' + kind : '');
    el.textContent = text;
    el.hidden = !text;
  }

  function ratePerRequest() { return cfg.get('interval'); }

  function updateRateHint() {
    if (!ui.rateHint) return;
    var ms = ratePerRequest();
    var hundred = ms * 100 / 1000;
    var warn = ms < 1000;
    ui.rateHint.textContent = '当前 ' + (ms / 1000).toFixed(1) + 's/次 · 100 人约需 ' +
      fmtDuration(hundred);
    ui.rateHint.style.color = warn ? 'var(--warn)' : '';
  }

  async function runSingle() {
    var input = ui.inSingle.value.trim();
    if (!input) { showMsg(ui.msgSingle, '请先粘贴主页链接或输入 mid。', 'warn'); return; }
    showMsg(ui.msgSingle, '');
    ui.resultSingle.hidden = true;
    ctrl.abort = new AbortController();
    setBusy(true, '检测登录状态…');

    try {
      if (!(await ensureLogin(ctrl.abort.signal))) {
        showLoginRequired(ui.msgSingle);
        return;
      }

      setBusy(true, '解析中…');
      var p = await parseMid(input, ctrl.abort.signal);
      if (p.error) throw new Error(parseErrorText(p));

      setBusy(true, '查询中…');
      var rel = await throttled(function () {
        return fetchRelation(p.mid, ctrl.abort.signal);
      }, ctrl.abort.signal);

      var isSelf = false;
      try {
        var selfMid = await getSelfMid(ctrl.abort.signal);
        isSelf = selfMid && String(selfMid) === String(rel.mid);
      } catch (e) { /* ignore */ }

      ui.resultSingle.textContent = '';
      var fmt = cfg.get('timeFormat');
      var att = rel.attribute;
      var label = attrLabel(att);

      if (attrFollowed(att)) {
        /* 已关注（含悄悄关注/互粉）。有 mtime 就显示日期，没有也照样说"已关注"。 */
        var kv = h('div', { class: 'kv' },
          h('span', { class: 'muted' }, isSelf ? '你关注你自己的时间' : '你关注 TA 的时间')
        );
        if (rel.mtime) {
          kv.appendChild(h('span', { class: 'big', text: fmtTime(rel.mtime, fmt) }));
        } else {
          kv.appendChild(h('span', { class: 'big', text: label }));
        }
        kv.appendChild(h('span', { class: 'tag', text: label }));
        kv.appendChild(h('span', { class: 'tag', text: 'mid ' + rel.mid }));
        ui.resultSingle.appendChild(kv);

        if (rel.mtime) {
          ui.resultSingle.appendChild(h('div', { class: 'muted gap' },
            '距今 ' + fmtAgo(rel.mtime) + '　·　时间戳 ' + rel.mtime));
        } else {
          ui.resultSingle.appendChild(h('div', { class: 'muted gap' },
            '关系是「' + label + '」，但接口这次没有返回关注时间（mtime = 0），所以给不出具体日期。' +
            '这不算"没关注"—— 旧版本正是在这里误报成未关注的。'));
        }
      } else if (att === 128) {
        ui.resultSingle.appendChild(h('div', { class: 'kv' },
          h('span', { class: 'big', text: '已拉黑' }),
          h('span', { class: 'tag', text: 'mid ' + rel.mid })
        ));
      } else if (att === 0) {
        ui.resultSingle.appendChild(h('div', { class: 'kv' },
          h('span', { class: 'big', text: '未关注' }),
          h('span', { class: 'tag', text: 'mid ' + rel.mid })
        ));
        ui.resultSingle.appendChild(h('div', { class: 'muted gap' },
          rel.conflict
            ? '⚠️ 两个接口结论不一致（已在下方标出）。这通常是接口返回了异常数据，请把诊断信息发我。'
            : '两个接口都查过了，结论一致：当前登录账号没有关注这个用户。'));
        ui.resultSingle.appendChild(h('div', { class: 'muted gap' },
          '若你确信已关注，请先确认两点：① 浏览器当前登录的是不是你自己的账号（点头像看昵称）；' +
          '② 关注的是不是同一个 UP（同名 / 小号很常见）。'));
        ui.resultSingle.appendChild(h('div', { class: 'muted' }, relDetail(rel)));
        ui.resultSingle.appendChild(h('div', { class: 'row gap' }, diagBtn(rel), verifyBtn(rel.mid)));
      } else {
        /* 未识别的 attribute：不武断下结论（旧版本会在这里说"未关注"） */
        ui.resultSingle.appendChild(h('div', { class: 'kv' },
          h('span', { class: 'big', text: label }),
          h('span', { class: 'tag', text: 'mid ' + rel.mid })
        ));
        ui.resultSingle.appendChild(h('div', { class: 'muted gap' },
          'B 站返回了一个本脚本还不认识的关系状态，所以无法判断你是否关注了 TA。原始数据：'));
        ui.resultSingle.appendChild(h('div', { class: 'muted' }, relDetail(rel)));
        ui.resultSingle.appendChild(h('div', { class: 'row gap' }, diagBtn(rel)));
      }
      ui.resultSingle.hidden = false;
      GM_setValue(UI_PREFIX + 'lastInput', input);
    } catch (e) {
      reportError(ui.msgSingle, e);
    } finally {
      setBusy(false, '');
      ctrl.abort = null;
    }
  }

  async function runList(mode) {
    var input = mode === 'mine' ? ui.inMine.value.trim() : ui.inOther.value.trim();
    var msgEl = mode === 'mine' ? ui.msgMine : ui.msgOther;
    showMsg(msgEl, '');

    ctrl.abort = new AbortController();
    state.rows = [];
    state.year = '';
    if (ui.yearSel) ui.yearSel.value = '';
    renderTable();

    var selfMid = null;
    var vmid = input;

    try {
      if (!(await ensureLogin(ctrl.abort.signal))) {
        showLoginRequired(msgEl);
        return;
      }

      if (mode === 'mine') {
        if (!input) {
          setBusy(true, '读取我的账号信息…');
          selfMid = auth.mid;
          if (!selfMid) { showLoginRequired(msgEl); return; }
          vmid = selfMid;
          ui.inMine.value = selfMid;
        } else {
          var pm = await parseMid(input, ctrl.abort.signal);
          if (pm.error) throw new Error(parseErrorText(pm));
          vmid = pm.mid;
        }
      } else {
        if (!input) { showMsg(msgEl, '请粘贴对方的主页链接，或直接填 mid。', 'warn'); setBusy(false, ''); ctrl.abort = null; return; }
        var po = await parseMid(input, ctrl.abort.signal);
        if (po.error) throw new Error(parseErrorText(po));
        vmid = po.mid;
      }

      setBusy(true, '准备中…');
      var t0 = Date.now();

      var res = await fetchFollowings(vmid, {
        signal: ctrl.abort.signal,
        /* 传 undefined 让 fetchFollowings 自行判定「是不是自己」：
           若用户在"查 TA"里粘的其实是自己的链接，也能正确走全量而非 100 条截断。
           判定走 auth 缓存，不产生额外请求。 */
        selfMid: (selfMid === null ? undefined : selfMid),
        onProgress: function (p) {
          setProgress(p.got, p.total);
          ui.progressText.textContent = '第 ' + p.page + ' 页 · 已获取 ' + p.got +
            (p.total ? ' / ' + p.total : '') + ' 条　·　已用 ' + fmtDuration((Date.now() - t0) / 1000);
        }
      });

      state.rows = res.list.map(function (it) {
        return {
          uname: it.uname || '',
          mid: String(it.mid),
          mtime: it.mtime || 0,
          attribute: it.attribute || 0
        };
      });

      buildYearOptions();
      renderHead();
      renderTable();

      var endNote = '';
      if (res.stopped === 'cap') endNote = '（已达你在设置里的条数上限，已截断）';
      else if (res.stopped === 'endpoint') endNote = '（已达该接口上限，B 站不再返回更多）';
      else if (res.stopped === 'more') endNote = '（已达「最大翻页数」设置，后面还有更多）';

      var note = '';
      if (!res.isSelf) {
        note = '　· ' + (res.endpoint === 'app' ? '兼容接口' : '标准接口') +
          '（上限 ' + res.endpointMax + ' 条）　· 对方关注总数 ' + res.total;
      } else if (res.total) {
        note = '　· 关注总数 ' + res.total;
      }
      showMsg(msgEl, '完成：共 ' + state.rows.length + ' 条' + endNote + note, 'ok');
      toast('拉取完成，共 ' + state.rows.length + ' 条');
    } catch (e) {
      reportError(msgEl, e);
    } finally {
      setBusy(false, '');
      ctrl.abort = null;
    }
  }

  function abortRun() {
    if (ctrl.abort) {
      try { ctrl.abort.abort(); } catch (e) { /* ignore */ }
      toast('已请求中止', 'warn');
    }
  }

  function buildPanel() {
    var p = h('section', { class: 'panel ' + ballClass(), hidden: true });
    ui.panel = p;

    /* --- 单查 --- */
    var paneSingle = h('div', { class: 'tabpane' },
      h('div', { class: 'row wrap' },
        h('input', { type: 'text', placeholder: '粘贴 UP 主主页链接 / b23.tv 短链 / 直接输入 mid', id: 'bft-single' }),
        h('button', { class: 'primary', text: '查关注时间', onclick: runSingle })
      ),
      h('div', { class: 'muted gap' }, '例：https://space.bilibili.com/1643718　或　1643718'),
      h('div', { class: 'msg', hidden: true }),
      h('div', { class: 'card gap', hidden: true })
    );
    ui.inSingle = paneSingle.querySelector('input');
    ui.msgSingle = paneSingle.querySelector('.msg');
    ui.resultSingle = paneSingle.querySelector('.card');

    /* --- 我的列表 --- */
    var paneMine = h('div', { class: 'tabpane', hidden: true },
      h('div', { class: 'row wrap' },
        h('input', { type: 'text', placeholder: '留空 = 自动读取你自己；也可粘贴你的主页链接', id: 'bft-mine' }),
        h('button', { class: 'primary', text: '拉取我的关注', onclick: function () { runList('mine'); } })
      ),
      h('div', { class: 'muted gap' }),
      h('div', { class: 'msg', hidden: true })
    );
    ui.inMine = paneMine.querySelector('input');
    ui.selfHint = paneMine.querySelector('.muted');
    ui.msgMine = paneMine.querySelector('.msg');

    /* --- 他人列表 --- */
    var paneOther = h('div', { class: 'tabpane', hidden: true },
      h('div', { class: 'row wrap' },
        h('input', { type: 'text', placeholder: '粘贴对方主页链接 / b23.tv 短链 / 直接输入 mid', id: 'bft-other' }),
        h('button', { class: 'primary', text: '拉取 TA 的关注', onclick: function () { runList('other'); } })
      ),
      h('div', { class: 'muted gap' }, '需要对方开放关注列表权限。默认走兼容接口，最多前 5 页共 250 条；可在设置里切回标准接口（只有前 100 条）。'),
      h('div', { class: 'msg', hidden: true })
    );
    ui.inOther = paneOther.querySelector('input');
    ui.msgOther = paneOther.querySelector('.msg');

    /* --- 结果区 --- */
    ui.progressText = h('div', { class: 'muted' });
    ui.progressBar = h('i');
    ui.count = h('span', { class: 'muted' });
    ui.yearSel = h('select', {
      onchange: function (e) { state.year = e.target.value; renderTable(); }
    });

    var kwInput = h('input', {
      type: 'text', placeholder: '搜索昵称 / mid',
      oninput: function (e) { state.keyword = e.target.value.trim(); renderTable(); }
    });

    ui.theadRow = h('tr');
    var thead = h('thead', null, ui.theadRow);
    ui.tbody = h('tbody');
    var table = h('table', null, thead, ui.tbody);
    ui.tblWrap = h('div', { class: 'tbl-wrap', hidden: true }, table);
    ui.empty = h('div', { class: 'empty', text: '还没有数据。' });

    var resultArea = h('div', { class: 'gap' },
      h('div', { class: 'row wrap' },
        ui.yearSel,
        kwInput,
        h('button', { text: '导出 CSV', onclick: function () { exportRows('csv'); } }),
        h('button', { text: '导出 JSON', onclick: function () { exportRows('json'); } }),
        h('button', { text: '复制', onclick: function () {
          var rows = applyFilterSort();
          if (!rows.length) { toast('没有可复制的内容', 'warn'); return; }
          var txt = rows.map(function (r) {
            return (r.uname || '') + '\t' + r.mid + '\t' + (r.mtime ? fmtFull(r.mtime) : '') + '\t' + attrLabel(r.attribute);
          }).join('\n');
          var okCopy = copyText(txt);
          toast(okCopy ? '已复制 ' + rows.length + ' 行' : '复制失败', okCopy ? '' : 'err');
        } }),
        ui.count
      ),
      h('div', { class: 'bar' }, ui.progressBar),
      ui.progressText,
      ui.tblWrap,
      ui.empty
    );

    var body = h('div', { class: 'p-body' }, paneSingle, paneMine, paneOther, resultArea);
    ui.body = body;
    ui.panes = { single: paneSingle, mine: paneMine, other: paneOther };

    /* --- 头部 / tabs / 底部 --- */
    var tabs = h('nav', { class: 'p-tabs' });
    var tabDefs = [['single', '单个查询'], ['mine', '我的关注列表'], ['other', '查 TA 的关注列表']];
    var tabBtns = {};
    tabDefs.forEach(function (t) {
      var b = h('button', {
        text: t[1],
        onclick: function () { switchTab(t[0]); }
      });
      tabBtns[t[0]] = b;
      tabs.appendChild(b);
    });
    ui.tabBtns = tabBtns;

    ui.rateHint = h('span');
    ui.btnAbort = h('button', { text: '中止', disabled: true, onclick: abortRun });

    ui.verBtn = h('button', {
      class: 'vbtn',
      text: 'v' + VERSION,
      title: '点击检查更新',
      onclick: function () { checkUpdate(true); }
    });

    var foot = h('div', { class: 'p-foot' },
      h('button', { text: '⚙ 设置', onclick: openSettings }),
      ui.rateHint,
      h('span', { class: 'sp' }),
      ui.btnAbort,
      ui.verBtn
    );

    ui.loginText = h('span', { class: 'txt' });
    ui.btnGoLogin = h('button', { text: '去登录', onclick: openLogin });
    ui.loginBar = h('div', { class: 'loginbar', hidden: true },
      ui.loginText,
      ui.btnGoLogin,
      h('button', {
        text: '重新检测',
        onclick: function () {
          ui.loginBar.hidden = false;
          ui.loginBar.className = 'loginbar';
          ui.btnGoLogin.hidden = false;
          ui.loginText.textContent = '检测中…';
          checkLogin(null)
            .then(function () {
              if (auth.isLogin) {
                flashLoggedIn();
                toast('已登录：' + (auth.uname || auth.mid));
              } else if (auth.netError) {
                applyAuthUI();
                toast('无法确认登录状态：' + auth.netError, 'warn');
              } else {
                applyAuthUI();
                toast('仍未检测到登录，请先在 B 站完成登录', 'warn');
              }
            })
            .catch(function (e) {
              /* 兜底：checkLogin 万一把异常抛出来，也不能让横幅永远卡在「检测中…」 */
              applyAuthUI();
              toast(friendlyError(e), 'err');
            });
        }
      })
    );

    ui.updateText = h('span', { class: 'txt' });
    ui.updateBar = h('div', { class: 'updatebar', hidden: true },
      ui.updateText,
      h('button', { class: 'primary', text: '立即更新', onclick: openUpdate }),
      h('button', { text: '忽略', title: '忽略这个版本', onclick: dismissUpdate })
    );

    p.appendChild(h('div', { class: 'p-head' },
      h('span', { class: 'ttl', text: '⏱ B站关注时间查询' }),
      h('button', { text: '✕', title: '关闭', onclick: closePanel })
    ));
    p.appendChild(ui.loginBar);
    p.appendChild(ui.updateBar);
    p.appendChild(tabs);
    p.appendChild(body);
    p.appendChild(foot);
    ui.wrap.appendChild(p);

    ui.btnSingle = paneSingle.querySelector('button.primary');
    ui.btnMine = paneMine.querySelector('button.primary');
    ui.btnOther = paneOther.querySelector('button.primary');

    switchTab('single');
    renderHead();
    renderTable();
    updateRateHint();
  }

  function switchTab(name) {
    Object.keys(ui.panes).forEach(function (k) {
      ui.panes[k].hidden = (k !== name);
    });
    Object.keys(ui.tabBtns).forEach(function (k) {
      ui.tabBtns[k].classList.toggle('on', k === name);
    });
  }

  function openPanel() {
    ensureHost();
    ui.panel.hidden = false;
    applyBallPos();
    applyTheme();
    updateRateHint();
    applyAuthUI();
    applyUpdateUI();
    if (cfg.get('rememberPanel')) GM_setValue(UI_PREFIX + 'open', true);
    /* 未登录时每次打开面板顺手复检一次（用户可能刚登录完回来） */
    if (auth.checked && !auth.isLogin) checkLogin(null).catch(function () { /* ignore */ });
  }

  function closePanel() {
    ui.panel.hidden = true;
    if (cfg.get('rememberPanel')) GM_setValue(UI_PREFIX + 'open', false);
  }

  function togglePanel() {
    if (ui.panel.hidden) openPanel(); else closePanel();
  }

  /* =========================================================================
   * 10. 设置抽屉（schema 自动渲染）
   * ======================================================================= */

  function riskText(it, v) {
    if (it.key === 'interval') return '⚠ 间隔小于 1 秒，触发 B 站风控（-352）的概率明显升高。';
    if (it.key === 'retryMax') return '⚠ 已关闭重试：一旦遇到风控会直接中止。';
    if (it.key === 'apiBase') return '⚠ API 域名已被修改，若不是你刻意为之，请点「恢复默认」。';
    return '';
  }

  function buildControl(it, refresh) {
    var val = cfg.get(it.key);
    var ctl = h('div', { class: 'ctl' });

    if (it.type === 'number' || it.type === 'range' || it.type === 'presets') {
      if (it.type === 'presets') {
        var pills = h('div', { class: 'pills' });
        (it.presets || []).forEach(function (pr) {
          pills.appendChild(h('button', {
            class: val === pr.value ? 'on' : '',
            text: pr.label + ' ' + (pr.value / 1000) + 's',
            onclick: function (e) {
              e.preventDefault();
              cfg.set(it.key, pr.value);
              refresh();
            }
          }));
        });
        ctl.appendChild(pills);
      }

      var wrap = h('div', { class: 'inl' });
      if (it.type === 'range') {
        var rng = h('input', {
          type: 'range', min: it.min, max: it.max, step: it.step, value: val,
          oninput: function (e) { cfg.set(it.key, e.target.value); refresh(); }
        });
        wrap.appendChild(rng);
        wrap.appendChild(h('span', { class: 'unit', text: val + (it.unit || '') }));
      } else {
        var num = h('input', {
          type: 'number', min: it.min, max: it.max, step: it.step, value: val,
          onchange: function (e) {
            var v = cfg.set(it.key, e.target.value);
            e.target.value = v;
            refresh();
          }
        });
        wrap.appendChild(num);
        if (it.unit) wrap.appendChild(h('span', { class: 'unit', text: it.unit }));
        if (it.min !== undefined) {
          wrap.appendChild(h('span', { class: 'unit', text: '范围 ' + it.min + ' ~ ' + it.max }));
        }
      }
      ctl.appendChild(wrap);
      if (it.key === 'interval') {
        var ms = cfg.get('interval');
        ctl.appendChild(h('div', {
          class: ms < 1000 ? 'riskx' : 'hintx',
          text: '当前 ' + (ms / 1000).toFixed(1) + 's/次 · 100 人约需 ' + fmtDuration(ms * 100 / 1000)
        }));
      }
      return ctl;
    }

    if (it.type === 'switch') {
      ctl.appendChild(h('label', { class: 'inl' },
        h('input', {
          type: 'checkbox', checked: !!val ? true : null,
          onchange: function (e) { cfg.set(it.key, e.target.checked); refresh(); }
        }),
        h('span', { class: 'hintx', text: val ? '已开启' : '已关闭' })
      ));
      return ctl;
    }

    if (it.type === 'select') {
      var sel = h('select', {
        onchange: function (e) { cfg.set(it.key, e.target.value); refresh(); }
      });
      it.options.forEach(function (o) {
        var op = h('option', { value: o.value, text: o.label });
        if (String(o.value) === String(val)) op.selected = true;
        sel.appendChild(op);
      });
      ctl.appendChild(sel);
      return ctl;
    }

    if (it.type === 'multi') {
      var box = h('div', { class: 'multi' });
      it.options.forEach(function (o) {
        var cb = h('input', { type: 'checkbox', checked: val.indexOf(o.value) >= 0 ? true : null });
        cb.addEventListener('change', function () {
          var next = cfg.get(it.key).slice();
          var i = next.indexOf(o.value);
          if (cb.checked && i < 0) next.push(o.value);
          if (!cb.checked && i >= 0) next.splice(i, 1);
          cfg.set(it.key, next);
          refresh();
        });
        box.appendChild(h('label', null, cb, o.label));
      });
      ctl.appendChild(box);
      return ctl;
    }

    /* text */
    ctl.appendChild(h('input', {
      type: 'text', value: val,
      onchange: function (e) {
        var v = cfg.set(it.key, e.target.value);
        e.target.value = v;
        refresh();
      }
    }));
    return ctl;
  }

  function buildSettings() {
    var d = h('aside', { class: 'drawer', hidden: true });
    ui.drawer = d;

    ui.search = h('input', {
      type: 'text', placeholder: '搜索参数…',
      oninput: function () { renderSettingsForm(); }
    });

    var warnBar = h('div', { class: 'd-warn', hidden: true });
    ui.warnBar = warnBar;

    ui.form = h('div', { class: 'd-body' });
    ui.gnav = h('div', { class: 'd-tools' });

    var head = h('div', { class: 'd-head' },
      h('span', { class: 'ttl', text: '⚙ 设置' }),
      h('button', { text: '✕', onclick: closeSettings })
    );
    var tools = h('div', { class: 'd-tools' },
      ui.search,
      h('button', { text: '恢复默认', onclick: function () {
        cfg.reset();
        ui.search.value = '';
        renderSettingsForm();
        toast('已恢复默认设置');
      } }),
      h('button', { text: '导出配置', onclick: function () {
        var txt = cfg.exportJSON();
        if (copyText(txt)) toast('配置已复制到剪贴板');
        download('bili-follow-time-config.json', txt, 'application/json;charset=utf-8');
      } }),
      h('button', { text: '导入配置', onclick: function () {
        var box = h('textarea', {
          style: { width: '100%', height: '160px', fontFamily: 'monospace', fontSize: '12px' },
          placeholder: '把导出的 JSON 粘贴到这里，然后点「确定导入」'
        });
        var panel = h('div', { class: 'card', style: { margin: '12px 16px' } },
          h('div', { class: 'muted' }, '粘贴配置 JSON：'),
          box,
          h('div', { class: 'tools' },
            h('button', { class: 'primary', text: '确定导入', onclick: function () {
              if (cfg.importJSON(box.value)) {
                renderSettingsForm();
                toast('配置已导入');
                panel.remove();
              } else {
                toast('JSON 解析失败', 'err');
              }
            } }),
            h('button', { text: '取消', onclick: function () { panel.remove(); } })
          )
        );
        ui.form.insertBefore(panel, ui.form.firstChild);
        box.focus();
      } })
    );

    d.appendChild(head);
    d.appendChild(tools);
    d.appendChild(warnBar);
    d.appendChild(ui.form);
    ui.wrap.appendChild(d);
  }

  function renderSettingsForm() {
    var kw = (ui.search.value || '').trim().toLowerCase();
    ui.form.textContent = '';

    var risky = [];
    GROUPS.forEach(function (g) {
      var items = SCHEMA.filter(function (it) {
        if (it.group !== g.key) return false;
        if (!kw) return true;
        return (it.label + ' ' + it.key + ' ' + (it.hint || '')).toLowerCase().indexOf(kw) >= 0;
      });
      if (!items.length) return;

      var box = h('div', { class: 'grp', 'data-grp': g.key });
      box.appendChild(h('h4', { text: g.label }));
      items.forEach(function (it) {
        var v = cfg.get(it.key);
        var isRisk = typeof it.risk === 'function' ? it.risk(v) : false;
        if (isRisk) risky.push(it.label);
        var item = h('div', { class: 'item' + (isRisk ? ' risk' : '') });
        item.appendChild(h('div', { class: 'lab' },
          h('span', { text: it.label }),
          ' ',
          h('span', { class: 'q', title: it.hint || '', text: '?' })
        ));
        item.appendChild(buildControl(it, function () {
          renderSettingsForm();
          updateRateHint();
          renderTable();
          applyBallPos();
          applyTheme();
        }));
        if (isRisk) {
          item.querySelector('.ctl').appendChild(h('div', { class: 'riskx', text: riskText(it, v) }));
        } else if (it.hint) {
          item.querySelector('.ctl').appendChild(h('div', { class: 'hintx', text: it.hint }));
        }
        box.appendChild(item);
      });
      ui.form.appendChild(box);
    });

    if (!ui.form.childNodes.length) {
      ui.form.appendChild(h('div', { class: 'empty', text: '没有匹配的参数。' }));
    }

    if (risky.length) {
      ui.warnBar.hidden = false;
      ui.warnBar.textContent = '⚠ 以下参数处于风险状态：' + risky.join('、') + '。若非刻意设置，建议点「恢复默认」。';
    } else {
      ui.warnBar.hidden = true;
    }
  }

  function openSettings() {
    ensureHost();
    ui.drawer.hidden = false;
    renderSettingsForm();
  }

  function closeSettings() {
    ui.drawer.hidden = true;
  }

  /* =========================================================================
   * 11. 空间页小标签
   * ======================================================================= */

  /* B 站空间页是 SPA：站内点进另一个 UP 不会重新加载页面，而脚本只在页面加载时跑一次。
     结果就是小标签停留在上一个 UP 的状态上 —— 用户看着 B 的主页，看到的却是 A 的结论，
     表现为「明明关注了却说没关注」。所以必须监听地址变化并重查。 */
  var chipMid = null;
  var chipSeq = 0;          /* 防止旧请求晚到后覆盖新结果 */

  function currentSpaceMid() {
    if (location.hostname.indexOf('space.bilibili.com') < 0) return null;
    var m = location.pathname.match(/^\/(\d+)(?=[\/?#]|$)/);
    return m ? m[1] : null;
  }

  function removeChip() {
    if (ui.chip && ui.chip.parentNode) ui.chip.parentNode.removeChild(ui.chip);
    ui.chip = null;
  }

  /* 让 chip 可点击（去登录 / 复制时间戳）时，先清掉上一次的点击处理，
     否则 SPA 切换后点击会同时触发新旧两个回调。 */
  function bindChipClick(handler) {
    if (ui.chip._bftClick) ui.chip.removeEventListener('click', ui.chip._bftClick);
    ui.chip._bftClick = handler;
    if (handler) ui.chip.addEventListener('click', handler);
  }

  async function autoSpaceChip() {
    if (!cfg.get('autoSpaceChip')) return;
    var mid = currentSpaceMid();
    if (!mid) return;
    chipMid = mid;
    var seq = ++chipSeq;

    if (!ui.chip) ui.chip = h('div', { class: 'chip', text: '查询关注时间…' });
    if (!ui.chip.parentNode) ui.wrap.appendChild(ui.chip);
    var chip = ui.chip;
    chip.style.cursor = '';
    bindChipClick(null);
    chip.textContent = '查询关注时间…';

    if (!(await ensureLogin(null).catch(function () { return false; }))) {
      if (seq !== chipSeq) return;
      chip.textContent = '未登录 B 站 —— 点击此处去登录';
      chip.style.cursor = 'pointer';
      chip.title = '点击打开 B 站登录页';
      bindChipClick(openLogin);
      return;
    }

    try {
      var rel = await throttled(function () { return fetchRelation(mid, null); }, null);
      if (seq !== chipSeq) return;     /* 用户已经跳到别的 UP 了，这条结果作废 */
      var att = rel.attribute;
      var label = attrLabel(att);
      chip.title = relDetail(rel);

      if (attrFollowed(att)) {
        chip.textContent = '';
        chip.appendChild(document.createTextNode('你关注 TA 的时间：'));
        chip.appendChild(h('b', {
          text: rel.mtime ? fmtTime(rel.mtime, cfg.get('timeFormat')) : '（接口未返回）'
        }));
        if (rel.mtime) {
          chip.appendChild(document.createTextNode('（' + fmtAgo(rel.mtime) + '）'));
          chip.title = '点击复制时间戳 ' + rel.mtime + '　·　' + relDetail(rel);
          chip.style.cursor = 'pointer';
          bindChipClick(function () {
            var okCopy = copyText(String(rel.mtime));
            toast(okCopy ? '已复制时间戳 ' + rel.mtime : '复制失败', okCopy ? '' : 'err');
          });
        } else {
          chip.appendChild(document.createTextNode('　（关系为「' + label + '」，但接口没给 mtime）'));
        }
      } else if (att === 0) {
        chip.textContent = (rel.conflict ? '⚠️ 两个接口结论不一致。' : '你没有关注这个 UP 主。') +
          relDetail(rel) + '　（点这里复制诊断信息）';
        chip.style.cursor = 'pointer';
        bindChipClick(function () {
          var okCopy = copyText(relDiagText(rel));
          toast(okCopy ? '诊断信息已复制' : '复制失败', okCopy ? '' : 'err');
        });
      } else {
        chip.textContent = '关系状态：' + label + '。' + relDetail(rel) + '　（点这里复制诊断信息）';
        chip.style.cursor = 'pointer';
        bindChipClick(function () {
          var okCopy = copyText(relDiagText(rel));
          toast(okCopy ? '诊断信息已复制' : '复制失败', okCopy ? '' : 'err');
        });
      }
    } catch (e) {
      if (seq !== chipSeq) return;
      chip.textContent = '查询失败：' + friendlyError(e);
    }
  }

  /* 监听 SPA 站内跳转（pushState/replaceState + 前进后退），换 UP 就重查 */
  function watchSpaceNavigation() {
    if (!cfg.get('autoSpaceChip')) return;
    function tick() {
      if (!cfg.get('autoSpaceChip')) return;
      var mid = currentSpaceMid();
      if (!mid) {
        if (ui.chip) removeChip();
        chipMid = null;
        return;
      }
      if (mid !== chipMid) autoSpaceChip();
    }
    ['pushState', 'replaceState'].forEach(function (fn) {
      var orig = history[fn];
      history[fn] = function () {
        var r = orig.apply(this, arguments);
        setTimeout(tick, 60);
        return r;
      };
    });
    window.addEventListener('popstate', function () { setTimeout(tick, 60); });
    setInterval(tick, 1500);   /* 兜底：有些跳转不走 history API */
  }

  /* =========================================================================
   * 12. 启动
   * ======================================================================= */

  function buildBall() {
    ui.ball = h('button', {
      class: 'ball ' + ballClass(),
      title: 'B站关注时间查询（点击打开 / 关闭）',
      text: '⏱',
      onclick: togglePanel
    });
    ui.wrap.appendChild(ui.ball);
  }

  function init() {
    ensureHost();
    buildBall();
    buildPanel();
    buildSettings();
    applyBallPos();
    applyTheme();

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onMq = function () { if (cfg.get('theme') === 'auto') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    }

    /* 恢复上次输入 / 面板状态 */
    var last = GM_getValue(UI_PREFIX + 'lastInput', '');
    if (last) ui.inSingle.value = last;
    if (cfg.get('rememberPanel') && GM_getValue(UI_PREFIX + 'open', false)) openPanel();

    /* 配置变更联动 */
    cfg.onChange(function (key) {
      applyBallPos();
      applyTheme();
      updateRateHint();
      renderTable();
      /* 挪动「更新」这两项后立刻反馈一次，不然要重启才生效，体验很怪 */
      if ((key === 'checkUpdate' || key === 'updateCheckHours') && cfg.get('checkUpdate')) {
        checkUpdate(true).catch(function () { /* ignore */ });
      }
    });

    /* 菜单命令 */
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('打开查询面板', openPanel);
      GM_registerMenuCommand('打开设置', openSettings);
      GM_registerMenuCommand('检查脚本更新', function () { checkUpdate(true); });
      GM_registerMenuCommand('恢复默认设置', function () {
        cfg.reset();
        if (!ui.drawer.hidden) renderSettingsForm();
        toast('已恢复默认设置');
      });
    }

    /* 快捷键：Alt+B 开关面板 */
    document.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        togglePanel();
      }
    });

    /* 启动即检测一次登录态，未登录会在面板顶部与悬浮球上给出提醒 */
    checkLogin(null)
      .catch(function () { /* ignore */ })
      .then(function () {
        watchSpaceNavigation();
        autoSpaceChip();
        /* 顺带做一次带节流的更新检查，发现新版会在面板顶部与悬浮球上提示 */
        checkUpdate(false).catch(function () { /* ignore */ });
      });
  }

  /* 等待 DOM 就绪 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
