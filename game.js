/* 拉姆探险记 · H5 移植版（V1.2.1 对齐）
 * 原版：zzt741《拉姆探险记》/ V1.2.1 维护：Dlmos 火烧云
 * 本版把“读取手环站立/卡路里/步数”改为“牧场活动积累活动值 → 喂养转化”，
 * 其余事件文案、概率、消耗、战斗、属性递减、等级曲线按 V1.2.1 源码还原。
 */
(function () {
  "use strict";

  var DATA = window.GAME_DATA;
  var LAM = window.LAM_EVENTS;
  var LOCATIONS = LAM.LOCATIONS;

  var SAVE_KEY = "lam-h5-save-v1";
  var PENDING_CAP = 20;
  var ACTIVITY_CD = 3600000; // 牧场活动冷却：1 小时

  var ACTIVITIES = [
    { key: "stamina",  name: "伸展",   gain: 2, cd: ACTIVITY_CD, label: "体力", desc: "活动筋骨 · 体力 +2" },
    { key: "strength", name: "搬草垛", gain: 2, cd: ACTIVITY_CD, label: "力量", desc: "出力干活 · 力量 +2" },
    { key: "speed",    name: "散步",   gain: 2, cd: ACTIVITY_CD, label: "速度", desc: "绕场散步 · 速度 +2" }
  ];

  var ICONS = {
    stamina: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19C5 11 11 5 19 5c0 8-6 14-14 14Z"/><path d="M5 19C8 13 12 9 17 6"/></svg>',
    strength: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8l8-4 8 4v8l-8 4-8-4V8Z"/><path d="M4 8l8 4 8-4M12 12v8"/></svg>',
    speed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6c1.6 2 1.6 4 0 6s-1.6 4 0 6"/><path d="M11 5c1.6 2 1.6 4 0 6s-1.6 4 0 6"/><path d="M16 6c1.6 2 1.6 4 0 6s-1.6 4 0 6"/></svg>'
  };

  var ATTR_NAMES = { stamina: "体力", strength: "力量", speed: "速度" };

  var MEDALS = [
    { key: "honest", name: "拾金不昧奖章" },
    { key: "brave",  name: "见义勇为奖章" },
    { key: "good",   name: "三好拉姆奖章" },
    { key: "ski",    name: "滑雪冠军奖章" },
    { key: "dragon", name: "拉姆勇士勋章" }
  ];

  var STAGE_SCALE = [0.82, 0.88, 0.94, 1.0, 1.05, 1.1];

  var $ = function (id) { return document.getElementById(id); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var sumPending = function (p) { return p.stamina + p.strength + p.speed; };

  function pickWeighted(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].w || 0;
    var roll = Math.random() * total;
    for (i = 0; i < list.length; i++) {
      roll -= list[i].w || 0;
      if (roll < 0) return list[i];
    }
    return list[list.length - 1];
  }

  function defaultState() {
    return {
      version: 2,
      name: "你的拉姆",
      bornAt: Date.now(),
      lastTick: Date.now(),
      hunger: 100,
      hungerAcc: 0,
      stamina: 28,
      strength: 8,
      speed: 23,
      dead: false,
      deathAt: 0,
      reviveProgress: 0,
      pending: { stamina: 0, strength: 0, speed: 0 },
      cooldowns: { stamina: 0, strength: 0, speed: 0 },
      speedMultiplier: 30,
      feedCount: 0,
      talkCount: 0,
      exploreCount: 0,
      feedHungerGain: 0,
      feedStaminaGain: 0,
      feedStrengthGain: 0,
      feedSpeedGain: 0,
      naturalHungerLoss: 0,
      exploreHungerCost: 0,
      medals: { honest: 0, brave: 0, good: 0, ski: 0, dragon: 0 },
      warriorMedal: 0,
      battle: {
        flower: { win: 0, enc: 0 },
        small:  { win: 0, enc: 0 },
        big:    { win: 0, enc: 0 }
      },
      dragonEnc: 0,
      dragonWin: 0,
      fishCount: 0,
      whaleCount: 0,
      noWhaleCount: 0,
      lahmKingCount: 0,
      reviveCount: 0,
      updatedAt: Date.now()
    };
  }

  // 把云端/外部存档合并到完整状态，补齐旧版本缺失字段。
  function mergeState(raw) {
    var def = defaultState();
    if (!raw || typeof raw !== "object") return def;
    var out = Object.assign(def, raw);
    out.pending = Object.assign({ stamina: 0, strength: 0, speed: 0 }, raw.pending || {});
    out.cooldowns = Object.assign({ stamina: 0, strength: 0, speed: 0 }, raw.cooldowns || {});
    out.medals = Object.assign({ honest: 0, brave: 0, good: 0, ski: 0, dragon: 0 }, raw.medals || {});
    out.battle = {
      flower: Object.assign({ win: 0, enc: 0 }, (raw.battle && raw.battle.flower) || {}),
      small:  Object.assign({ win: 0, enc: 0 }, (raw.battle && raw.battle.small) || {}),
      big:    Object.assign({ win: 0, enc: 0 }, (raw.battle && raw.battle.big) || {})
    };
    if (out.warriorMedal == null) out.warriorMedal = (out.medals && out.medals.dragon > 0) ? 1 : 0;
    out.hunger = Number(out.hunger) || 0;
    out.hungerAcc = Number(out.hungerAcc) || 0;
    out.updatedAt = Number(out.updatedAt) || Date.now();
    out.reviveProgress = Math.min(1, Number(out.reviveProgress) || 0);
    var cap = 100 + Math.min(DATA.maxStage,
      Math.floor(Math.floor((out.stamina + out.strength + out.speed) / 100) / 10)) * 20;
    out.hunger = clamp(out.hunger, 0, cap);
    if (out.hunger <= 0) { out.hunger = 0; out.dead = true; }
    return out;
  }

  // ---------- 存档 ----------
  function loadState() {
    var def = defaultState();
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return def;
      var s = JSON.parse(raw);
      if (!s || typeof s !== "object") return def;
      var out = Object.assign(def, s);
      out.pending = Object.assign({ stamina: 0, strength: 0, speed: 0 }, s.pending || {});
      out.cooldowns = Object.assign({ stamina: 0, strength: 0, speed: 0 }, s.cooldowns || {});
      out.medals = Object.assign({ honest: 0, brave: 0, good: 0, ski: 0, dragon: 0 }, s.medals || {});
      out.battle = {
        flower: Object.assign({ win: 0, enc: 0 }, (s.battle && s.battle.flower) || {}),
        small:  Object.assign({ win: 0, enc: 0 }, (s.battle && s.battle.small) || {}),
        big:    Object.assign({ win: 0, enc: 0 }, (s.battle && s.battle.big) || {})
      };
      // 旧存档迁移：V1.0 的“拉姆勇士勋章”计数转为 V1.2.1 的 0/1 标记。
      if (out.warriorMedal == null) out.warriorMedal = (out.medals && out.medals.dragon > 0) ? 1 : 0;
      out.dragonWin = Number(out.dragonWin) || 0;
      out.noWhaleCount = Number(out.noWhaleCount) || 0;
      out.lahmKingCount = Number(out.lahmKingCount) || 0;
      out.hunger = Number(out.hunger) || 0;
      out.hungerAcc = Number(out.hungerAcc) || 0;
      out.updatedAt = Number(out.updatedAt) || Date.now();
      out.reviveProgress = Math.min(1, Number(out.reviveProgress) || 0);
      var cap = 100 + Math.min(DATA.maxStage,
        Math.floor(Math.floor((out.stamina + out.strength + out.speed) / 100) / 10)) * 20;
      out.hunger = clamp(out.hunger, 0, cap);
      if (out.hunger <= 0) { out.hunger = 0; out.dead = true; }
      return out;
    } catch (e) {
      return def;
    }
  }

  var state = loadState();
  var activeSheet = null;
  var sheetLocked = false;
  var activityTimer = null;
  var toastTimer = null;
  var closeTimer = null;

  function persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* 忽略隐私模式限制 */ }
  }

  function save() {
    state.updatedAt = Date.now();
    persist();
    try { window.dispatchEvent(new CustomEvent("lamu:save", { detail: state })); } catch (e) { /* 忽略无 CustomEvent 的环境 */ }
  }

  // ---------- 数值 ----------
  // V1.2.1：LV = floor((体力 + 力量 + 速度) / 100)，每 10 级进化一次。
  function levelOf(s) {
    return Math.max(0, Math.floor((s.stamina + s.strength + s.speed) / 100));
  }
  function stageOf(s) {
    return Math.min(DATA.maxStage, Math.floor(levelOf(s) / 10));
  }
  function hungerMax() {
    return 100 + stageOf(state) * 20;
  }

  function travelBase() {
    var e = state.stamina;
    if (e >= 3000) return 0;
    if (e >= 1500) return 0.5;
    if (e >= 700) return 1;
    if (e >= 300) return 1.5;
    if (e >= 100) return 2;
    return 3;
  }

  function travelCost(extra) {
    return Math.round(travelBase() + 4 * Math.random() + (extra || 0));
  }

  function die() {
    if (state.dead) return;
    state.dead = true;
    state.deathAt = Date.now();
    state.reviveProgress = 0;
    state.hunger = 0;
    state.hungerAcc = 0;
  }

  function changeHunger(delta, chips) {
    var cap = hungerMax();
    var before = state.hunger;
    var after = clamp(before + delta, 0, cap);
    state.hunger = after;
    var diff = after - before;
    if (Math.round(diff) !== 0 && chips) {
      chips.push({ text: "饥饿 " + (diff > 0 ? "+" : "") + Math.round(diff), tone: diff > 0 ? "up" : "down" });
    }
    if (after <= 0) die();
    return diff;
  }

  // 属性递减：ceil(1 / ln(attr/160 + e) * num)；attr > 1000 时收益减半。
  function attrAdd(key, num) {
    if (state[key] > 1000) num /= 2;
    var res = Math.ceil(1 / Math.log(state[key] / 160 + Math.E) * num);
    state[key] += res;
    return res;
  }

  // ---------- 时间 ----------
  // V1.2.1：每 4 小时自然 -1 饥饿，单次结算不超过当前饥饿。
  function settle() {
    var now = Date.now();
    var elapsed = now - state.lastTick;
    if (elapsed < 0) elapsed = 0;
    state.lastTick = now;
    if (state.dead) { state.hungerAcc = 0; return 0; }

    var raw = (elapsed / (4 * 3600000)) * state.speedMultiplier + state.hungerAcc;
    var units = Math.floor(raw);
    state.hungerAcc = raw - units;
    if (units <= 0) return 0;
    if (units > state.hunger) { units = state.hunger; state.hungerAcc = 0; }

    state.hunger -= units;
    state.naturalHungerLoss += units;
    if (state.hunger <= 0) die();
    return units;
  }

  // ---------- 渲染 ----------
  function render() {
    var lv = levelOf(state);
    var stage = stageOf(state);
    var cap = hungerMax();
    var h = Math.floor(state.hunger);
    var pendingTotal = sumPending(state.pending);

    $("sName").textContent = state.name;
    $("sLevel").textContent = lv;
    $("sHunger").textContent = h + " / " + cap;
    $("sStamina").textContent = state.stamina;
    $("sStrength").textContent = state.strength;
    $("sSpeed").textContent = state.speed;

    $("hungerRow").classList.toggle("low", h <= 25 && !state.dead);

    var base = travelBase();
    $("exploreCost").textContent = "消耗 " + Math.round(base) + "–" + Math.round(base + 14) + " 饥饿";

    var svg = $("lamSvg");
    svg.dataset.stage = String(stage);
    svg.style.setProperty("--lam-scale", String(STAGE_SCALE[stage] || 1));
    svg.classList.toggle("is-dead", state.dead);

    var tag = $("sceneTag");
    tag.classList.remove("warn", "dead");
    if (state.dead) {
      tag.textContent = "已死亡 · 完成 1 次牧场活动后可复活";
      tag.classList.add("dead");
    } else if (h <= 25) {
      tag.textContent = "阶段 " + stage + " · 饥饿，快喂喂它";
      tag.classList.add("warn");
    } else {
      tag.textContent = "阶段 " + stage + " · 等级 " + lv;
    }

    var feedBtn = $("feedBtn");
    var feedHint = $("feedHint");
    if (state.dead) {
      feedHint.textContent = state.reviveProgress >= 1 ? "可以复活了" : "复活进度 0 / 1";
      feedBtn.classList.add("ready");
    } else if (pendingTotal > 0) {
      feedHint.textContent = "活动值 " + pendingTotal;
      feedBtn.classList.add("ready");
    } else {
      feedHint.textContent = "活动值 0";
      feedBtn.classList.remove("ready");
    }
  }

  // ---------- 提示 ----------
  function toast(msg, ms) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, ms || 2200);
  }

  // ---------- 弹层 ----------
  function openSheet(opts) {
    opts = opts || {};
    sheetLocked = !!opts.locked;
    $("sheetClose").style.display = "";
    $("sheetKicker").textContent = opts.kicker || "";
    $("sheetTitle").textContent = opts.title || "";
    $("sheetBody").innerHTML = opts.body || "";
    $("sheetFoot").innerHTML = opts.foot || "";
    var overlay = $("overlay");
    clearTimeout(closeTimer);
    overlay.hidden = false;
    requestAnimationFrame(function () { overlay.classList.add("show"); });
    $("sheetBody").scrollTop = 0;
    document.body.style.overflow = "hidden";
    if (!opts.noFocus) {
      try { $("sheetClose").focus({ preventScroll: true }); } catch (e) { $("sheetClose").focus(); }
    }
  }

  function closeSheet() {
    if (sheetLocked) return;
    var overlay = $("overlay");
    overlay.classList.remove("show");
    document.body.style.overflow = "";
    activeSheet = null;
    clearInterval(activityTimer);
    activityTimer = null;
    closeTimer = setTimeout(function () { overlay.hidden = true; }, 180);
  }

  $("sheetClose").addEventListener("click", closeSheet);
  $("overlay").addEventListener("click", function (e) {
    if (e.target === $("overlay")) closeSheet();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("overlay").hidden) closeSheet();
  });
  $("sheetFoot").addEventListener("click", function (e) {
    if (e.target.closest("[data-close]")) closeSheet();
  });

  // ---------- 分页 ----------
  function paginate(text, max) {
    max = max || 220;
    text = String(text == null ? "" : text).trim();
    if (!text) return [""];
    var paras = text.split(/\n+/);
    var pages = [], cur = "";
    function push() { if (cur.trim()) { pages.push(cur.trim()); cur = ""; } }
    paras.forEach(function (para) {
      if (para.length > max) {
        push();
        var sentences = para.split(/(?<=[。！？!?；;])/);
        var buf = "";
        sentences.forEach(function (s) {
          if ((buf + s).length > max && buf) { pages.push(buf); buf = s; }
          else { buf += s; }
        });
        if (buf) {
          if (buf.length > max) {
            for (var i = 0; i < buf.length; i += max) pages.push(buf.slice(i, i + max));
          } else pages.push(buf);
        }
      } else {
        if (((cur ? cur + "\n" : "") + para).length > max) { push(); cur = para; }
        else cur = cur ? cur + "\n" + para : para;
      }
    });
    push();
    return pages.length ? pages : [""];
  }

  function pagerFoot(idx, total) {
    if (total <= 1) return '<button class="btn ghost" data-close>关闭</button>';
    return '<button class="btn ghost" data-close>关闭</button>' +
      '<button class="btn small" id="pgPrev"' + (idx === 0 ? " disabled" : "") + ">上一页</button>" +
      '<button class="btn small" id="pgNext"' + (idx === total - 1 ? " disabled" : "") + ">下一页</button>";
  }

  function wirePager(total, go) {
    var prev = document.getElementById("pgPrev");
    var next = document.getElementById("pgNext");
    if (prev) prev.addEventListener("click", function () { if (go.idx > 0) { go.idx--; go.draw(); } });
    if (next) next.addEventListener("click", function () { if (go.idx < total - 1) { go.idx++; go.draw(); } });
  }

  function showPaged(title, kicker, pages, opts) {
    opts = opts || {};
    var go = { idx: 0 };
    go.draw = function () {
      var body = "";
      if (opts.headerHtml) body += opts.headerHtml;
      body += '<div class="content-text">' + esc(pages[go.idx]) + "</div>";
      if (opts.chips && opts.chips.length && go.idx === pages.length - 1) {
        body += '<div class="effect-chips">' + opts.chips.map(function (c) {
          return '<span class="chip ' + (c.tone || "") + '">' + esc(c.text) + "</span>";
        }).join("") + "</div>";
      }
      if (pages.length > 1) {
        body += '<div class="pager"><span>第 ' + (go.idx + 1) + " / " + pages.length + " 页</span></div>";
      }
      openSheet({
        kicker: kicker,
        title: title,
        body: body,
        foot: pagerFoot(go.idx, pages.length),
        noFocus: true
      });
      wirePager(pages.length, go);
    };
    go.draw();
  }

  // ---------- 探险 ----------
  function addGains(ev, chips) {
    if (!ev.gains || !ev.gains.length) return "";
    var out = "";
    ev.gains.forEach(function (g, idx) {
      var res = attrAdd(g.k, g.n);
      var prefix = (idx === 0 && ev.noComma) ? "" : "，";
      out += prefix + ATTR_NAMES[g.k] + "+" + res;
      if (chips) chips.push({ text: ATTR_NAMES[g.k] + " +" + res, tone: "up" });
    });
    return out;
  }

  // 战斗：V1.2.1 的 mCap / bonus 公式。
  function fightResult(mCap, bonus) {
    var chips = [];
    var cap = 4 * state.strength + 2 * state.speed + state.stamina;
    var rate = Math.log(cap / mCap / 7 * (Math.E - 1) + 1) / 2;
    if (Math.random() < rate) {
      var g = attrAdd("strength", bonus);
      changeHunger(bonus / 2, chips);
      return {
        text: "，战斗成功，力量+" + g + "，饥饿+" + (bonus / 2),
        win: true,
        chips: chips
      };
    }
    var cap2 = 2 * state.speed + state.stamina;
    var rate2 = Math.log(cap2 / mCap / 3 * (Math.E - 1) + 1) / 2;
    var gs = attrAdd("strength", bonus);
    var gv = attrAdd("speed", bonus);
    if (Math.random() < rate2) {
      return {
        text: "，战斗失败，开溜，逃跑成功，力量+" + gs + "，速度+" + gv,
        win: false,
        chips: chips
      };
    }
    changeHunger(-bonus, chips);
    return {
      text: "，战斗失败，开溜，逃跑失败，力量+" + gs + "，速度+" + gv + "，饥饿-" + bonus,
      win: false,
      chips: chips
    };
  }

  function resolveTiaotiao(ev) {
    var chips = [];
    var cap = 4 * state.strength + 2 * state.speed + state.stamina;
    var rate = Math.log(cap / 500 / 7 * (Math.E - 1) + 1) / 2;
    var text, medal = null;
    if (Math.random() < rate) {
      var winGain = addGains({ gains: [{ k: "strength", n: 10 }] }, chips);
      state.medals.brave = (state.medals.brave || 0) + 1;
      medal = "brave";
      chips.push({ text: "获得 见义勇为奖章", tone: "medal" });
      text = ev.intro + ev.winText.replace("{gain}", winGain);
    } else {
      changeHunger(-10, chips);
      var loseGain = addGains({ gains: [{ k: "strength", n: 10 }] }, chips);
      text = ev.intro + ev.loseText.replace("{gain}", loseGain);
    }
    return { text: text, chips: chips, medal: medal, extra: ev.extra || 0 };
  }

  function resolveFight(ev) {
    var f = ev.fight;
    var chips = [];
    var slot = state.battle[f.key];
    if (slot) slot.enc += 1;
    var r = fightResult(f.mCap, f.bonus);
    if (r.win && slot) slot.win += 1;
    chips = r.chips;
    return { text: ev.intro + r.text, chips: chips, medal: null, extra: ev.extra || 0 };
  }

  function resolveContest(ev) {
    var chips = [];
    var rate;
    if (ev.kind === "ski") {
      rate = Math.log(state.speed / 1500 * (Math.E - 1) + 1) / 2;
    } else {
      var cap = state.strength + state.speed + state.stamina;
      rate = Math.log(cap / 3000 * (Math.E - 1) + 1) / 2;
    }
    var win = Math.random() < rate;
    var text = ev.intro + (win ? ev.winText : ev.loseText);
    var medal = null;
    if (win && ev.medal) {
      state.medals[ev.medal] = (state.medals[ev.medal] || 0) + 1;
      medal = ev.medal;
      var m = MEDALS.find(function (x) { return x.key === ev.medal; });
      chips.push({ text: "获得 " + m.name, tone: "medal" });
    }
    if (ev.speedGain) text += addGains({ gains: [{ k: "speed", n: ev.speedGain }] }, chips);
    return { text: text, chips: chips, medal: medal, extra: ev.extra || 0 };
  }

  function resolveWhale(ev) {
    var chips = [];
    if (ev.fishCount) state.fishCount += 1;
    var rate = Math.log(state.strength / 1000 * (Math.E - 1) + 1) / 2;
    state.noWhaleCount += 1;
    var text = (ev.intro || "") + (ev.text || "");
    if (Math.random() < rate) {
      state.whaleCount += 1;
      changeHunger(100, chips);
      var g = addGains({ gains: [{ k: "strength", n: 10 }] }, chips);
      text += "终于钓起来了！饥饿+100！" + g;
    } else {
      text += "还是没钓起来";
    }
    return { text: text, chips: chips, medal: null, extra: ev.extra || 0 };
  }

  function resolveDragon(ev) {
    var chips = [];
    var boss = state.warriorMedal === 1 ? "blue" : "red";
    state.dragonEnc += 1;
    var r = fightResult(7000, 16);
    chips = r.chips;
    var text = (boss === "blue" ? ev.blueIntro : ev.redIntro) + r.text.substring(1);
    var medal = null;
    if (r.win) {
      state.dragonWin += 1;
      state.warriorMedal = boss === "red" ? 1 : 0;
      changeHunger(100, chips);
      state.stamina += 100;
      state.strength += 100;
      state.speed += 100;
      chips.push({ text: "力量 +100", tone: "up" });
      chips.push({ text: "体力 +100", tone: "up" });
      chips.push({ text: "速度 +100", tone: "up" });
      text += (boss === "blue" ? ev.blueWinBody : ev.redWinBody).replace("{name}", state.name);
      state.medals.dragon = (state.medals.dragon || 0) + 1;
      medal = "dragon";
      chips.push({ text: "获得 拉姆勇士勋章", tone: "medal" });
    } else {
      text += ev.loseBody;
    }
    return { text: text, chips: chips, medal: medal, extra: ev.extra || 0 };
  }

  function resolveEvent(ev) {
    var chips = [];
    var text = "";
    var medal = null;
    var extra = ev.extra || 0;

    if (ev.dragon) {
      return resolveDragon(ev);
    }
    if (ev.tiaotiao) {
      return resolveTiaotiao(ev);
    }
    if (ev.fight) {
      return resolveFight(ev);
    }
    if (ev.contest) {
      return resolveContest(ev);
    }
    if (ev.whale) {
      return resolveWhale(ev);
    }

    text = (ev.intro || "") + (ev.text || "");
    var gainStr = addGains(ev, chips);
    if (ev.gainAt) text = text.replace("{gain}", gainStr);
    else text += gainStr;

    if (ev.hunger) changeHunger(ev.hunger, chips);
    if (ev.counter === "lahmKing") {
      state.lahmKingCount += 1;
      chips.push({ text: "遇见拉姆王", tone: "up" });
    }
    if (ev.medal) {
      state.medals[ev.medal] = (state.medals[ev.medal] || 0) + 1;
      medal = ev.medal;
      var m = MEDALS.find(function (x) { return x.key === ev.medal; });
      chips.push({ text: "获得 " + m.name, tone: "medal" });
    }
    if (ev.cap != null && state.hunger > ev.cap) {
      var before = state.hunger;
      state.hunger = ev.cap;
      chips.push({ text: "饥饿 -" + Math.round(before - ev.cap), tone: "down" });
    }
    if (ev.fishCount) state.fishCount += 1;

    return { text: text, chips: chips, medal: medal, extra: extra };
  }

  function explore() {
    if (state.dead) { toast("你的拉姆处于死亡状态，不能探险哦"); return; }
    if (state.hunger < 25) { toast("你的拉姆处于饥饿状态，不能探险哦"); return; }

    var loc = pickWeighted(LOCATIONS);
    var ev = pickWeighted(loc.events);
    var lv0 = levelOf(state), st0 = stageOf(state);

    state.exploreCount += 1;
    var res = resolveEvent(ev);
    var lv1 = levelOf(state), st1 = stageOf(state);

    // 原版：先结算事件，再按结算后的体力计算旅行消耗。
    var cost = travelCost(res.extra);
    changeHunger(-cost, null);
    state.exploreHungerCost += cost;

    save();
    render();

    var tip = "";
    if (st1 > st0 && st1 <= DATA.maxStage) tip = "进化了！\n";
    else if (lv1 > lv0) tip = "升级了！\n";

    var pages = paginate(tip + res.text, 220);
    var go = { idx: 0 };
    go.draw = function () {
      var body = '<div class="result-cost">消耗 ' + cost + " 点饥饿</div>" +
        '<div class="result-text">' + esc(pages[go.idx]) + "</div>";
      if (go.idx === pages.length - 1 && res.chips.length) {
        body += '<div class="effect-chips">' + res.chips.map(function (c) {
          return '<span class="chip ' + (c.tone || "") + '">' + esc(c.text) + "</span>";
        }).join("") + "</div>";
      }
      if (pages.length > 1) {
        body += '<div class="pager"><span>第 ' + (go.idx + 1) + " / " + pages.length + " 页</span></div>";
      }
      openSheet({
        kicker: "探险结果",
        title: loc.name,
        body: body,
        foot: pagerFoot(go.idx, pages.length),
        noFocus: true
      });
      wirePager(pages.length, go);
    };
    go.draw();
  }

  // ---------- 喂养 ----------
  function feed() {
    if (state.dead) { tryRevive(); return; }
    var total = sumPending(state.pending);
    if (total <= 0) {
      toast("多走动一下吧");
      return;
    }

    var cap = hungerMax();
    var lv0 = levelOf(state), st0 = stageOf(state);
    var e = state.pending.stamina;
    var s = state.pending.strength;
    var sp = state.pending.speed;

    state.stamina += e;
    state.strength += s;
    state.speed += sp;
    state.pending = { stamina: 0, strength: 0, speed: 0 };

    var hungerAdd = (e + s + sp) * 5;
    var lv1 = levelOf(state), st1 = stageOf(state);
    var word;
    if (st1 > st0 && st1 <= DATA.maxStage) word = "主人，我进化了！";
    else if (lv1 > lv0) word = "主人，我升级了！";
    else if (hungerAdd <= 0) word = "多走动一下吧";
    else if (state.hunger >= cap) word = "小肚皮已经撑不下了";
    else word = pick(DATA.feedWords);

    if (state.hunger + hungerAdd > cap) hungerAdd = cap - state.hunger;
    state.hunger += hungerAdd;

    state.feedCount += 1;
    state.feedHungerGain += hungerAdd;
    state.feedStaminaGain += e;
    state.feedStrengthGain += s;
    state.feedSpeedGain += sp;

    save();
    render();

    var text = word + "\n\n饥饿+" + hungerAdd + "\n体力+" + e + "\n力量+" + s + "\n速度+" + sp;
    showPaged("喂养结果", "拉姆说", paginate(text, 220));
  }

  function tryRevive() {
    if (state.reviveProgress < 1) {
      toast("你的拉姆已死亡，完成 1 次牧场活动后点击喂养来复活");
      return;
    }
    state.dead = false;
    state.deathAt = 0;
    state.hunger = 100;
    state.hungerAcc = 0;
    state.reviveProgress = 0;
    state.reviveCount += 1;
    save();
    render();
    toast("复活成功！以后可要好好善待你的拉姆哦", 3000);
  }

  // ---------- 牧场活动 ----------
  function doActivity(key) {
    var a = ACTIVITIES.find(function (x) { return x.key === key; });
    if (!a) return;
    var now = Date.now();
    if (now < (state.cooldowns[key] || 0)) { toast("还在冷却中，请稍后再来"); return; }
    if (!state.dead && state.pending[key] >= PENDING_CAP) {
      toast("这项活动值已经满了，先喂养吧");
      return;
    }
    state.cooldowns[key] = now + a.cd;

    if (state.dead) {
      state.reviveProgress = Math.min(1, state.reviveProgress + 1);
      toast("拉姆感受到了你的陪伴 · 可以复活了");
    } else {
      state.pending[key] += a.gain;
      toast(a.name + "完成 · " + a.label + "活动值 +" + a.gain);
    }
    save();
    render();
    if (activeSheet === "activities") updateActivityUI();
  }

  function updateActivityUI() {
    var now = Date.now();
    ACTIVITIES.forEach(function (a) {
      var btn = document.getElementById("act-" + a.key);
      var cd = document.getElementById("cd-" + a.key);
      var pend = document.getElementById("pend-" + a.key);
      if (!btn || !cd || !pend) return;

      if (state.dead) {
        pend.textContent = "复活 " + state.reviveProgress + " / 1";
      } else {
        pend.textContent = "活动值 " + state.pending[a.key] + " / " + PENDING_CAP;
      }
      var left = Math.ceil(((state.cooldowns[a.key] || 0) - now) / 1000);
      var full = !state.dead && state.pending[a.key] >= PENDING_CAP;
      if (left > 0) {
        btn.disabled = true;
        btn.textContent = "冷却 " + (left >= 60 ? Math.ceil(left / 60) + " 分" : left + " 秒");
      } else if (full) {
        btn.disabled = true;
        btn.textContent = "已满";
      } else {
        btn.disabled = false;
        btn.textContent = state.dead ? "陪伴" : "开始";
      }
    });
    var feed = document.getElementById("sheetFeed");
    if (feed) {
      var t = state.dead ? state.reviveProgress : sumPending(state.pending);
      feed.textContent = state.dead ? (state.reviveProgress >= 1 ? "点击复活" : "喂养") : "喂养（" + t + "）";
      feed.disabled = state.dead ? state.reviveProgress < 1 : t <= 0;
    }
  }

  function showActivities() {
    activeSheet = "activities";
    var rows = ACTIVITIES.map(function (a) {
      return '<div class="activity-item">' +
        '<div class="activity-icon">' + (ICONS[a.key] || "") + "</div>" +
        '<div class="activity-main">' +
          '<div class="t">' + a.name + "</div>" +
          '<div class="d">' + a.desc + "</div>" +
        "</div>" +
        '<div class="activity-side">' +
          '<div class="p" id="pend-' + a.key + '">活动值 0 / ' + PENDING_CAP + "</div>" +
          '<button data-act="' + a.key + '" id="act-' + a.key + '">开始</button>' +
          '<div class="d" id="cd-' + a.key + '" style="font-size:10px;color:var(--muted);margin-top:4px"></div>' +
        "</div>" +
      "</div>";
    }).join("");

    openSheet({
      kicker: "替代原版手环运动数据",
      title: "牧场活动",
      body: rows +
        '<div class="note">原版通过手环记录的<b>站立 / 卡路里 / 步数</b>喂养：站立→体力，卡路里→力量，步数→速度。<br>H5 版改为：先做牧场活动积累<b>活动值</b>，再点「喂养」一次性转化为体力 / 力量 / 速度，并增加饥饿。<br>活动值上限 ' + PENDING_CAP + '，每项活动冷却 1 小时。</div>',
      foot: '<button class="btn ghost" data-close>关闭</button><button class="btn" id="sheetFeed">喂养</button>'
    });

    document.querySelectorAll("[data-act]").forEach(function (b) {
      b.addEventListener("click", function () { doActivity(b.dataset.act); });
    });
    var sf = document.getElementById("sheetFeed");
    sf.addEventListener("click", function () {
      if (state.dead && state.reviveProgress >= 1) { closeSheet(); tryRevive(); }
      else if (!state.dead) { closeSheet(); feed(); }
    });

    updateActivityUI();
    clearInterval(activityTimer);
    activityTimer = setInterval(updateActivityUI, 500);
  }

  // ---------- 对话 ----------
  function showContent(kicker, title, text) {
    var pages = paginate(text, 220);
    showPaged(title, kicker, pages);
  }

  function showPoemAt(index) {
    var p = DATA.poems[index] || pick(DATA.poems);
    var pages = paginate(p.body, 200);
    var go = { idx: 0 };
    go.draw = function () {
      var body = '<div class="poem-title">' + esc(p.title) + "</div>" +
        (p.author ? '<div class="poem-author">' + esc(p.author) + "</div>" : "") +
        '<div class="poem-body">' + esc(pages[go.idx]) + "</div>";
      if (pages.length > 1) {
        body += '<div class="pager"><span>第 ' + (go.idx + 1) + " / " + pages.length + " 页</span></div>";
      }
      openSheet({
        kicker: "拉姆念诗",
        title: "诗词",
        body: body,
        foot: pagerFoot(go.idx, pages.length),
        noFocus: true
      });
      wirePager(pages.length, go);
    };
    go.draw();
  }

  function talk() {
    state.talkCount += 1;
    var D = DATA;
    if (state.dead) {
      save();
      showContent("拉姆的最后一句话", "已离开", "所以爱是会消失的对吗？");
      return;
    }
    if (state.hunger < 25) {
      save(); render();
      var hungerPool = D.hungerWords.concat(D.hungerWordsEng);
      showContent("拉姆说", "饥饿", pick(hungerPool));
      return;
    }

    // V1.2.1：所有台词放进同一个池，按“条”等概率抽取。
    var words = D.words.concat(D.wordsEng).filter(Boolean);
    var total = words.length + D.poems.length + D.wonders.length + D.knowledges.length + D.jokes.length;
    var i = Math.floor(Math.random() * total);
    if (i < words.length) {
      showContent("拉姆说", "日常", words[i]);
    } else if ((i -= words.length) < D.poems.length) {
      showPoemAt(i);
    } else if ((i -= D.poems.length) < D.wonders.length) {
      showContent("拉姆的奇思妙想", "奇思妙想", D.wonders[i]);
    } else if ((i -= D.wonders.length) < D.knowledges.length) {
      showContent("拉姆的科普", "科普", D.knowledges[i]);
    } else {
      i -= D.knowledges.length;
      showContent("拉姆讲笑话", "笑话", D.jokes[i]);
    }
    save(); render();
  }

  // ---------- 信息 ----------
  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  function infoRow(k, v) {
    return '<div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div>";
  }

  function showInfo() {
    var s = state;
    var age = Math.max(0, Math.floor((Date.now() - s.bornAt) / 86400000));
    var lv = levelOf(s), stage = stageOf(s);

    var rows = "";
    rows += infoRow("生日", fmtDate(s.bornAt));
    rows += infoRow("年龄", age + " 天");
    rows += infoRow("等级 / 阶段", lv + " 级 · 阶段 " + stage);
    rows += infoRow("饥饿上限", hungerMax());
    rows += infoRow("喂养次数", s.feedCount);
    rows += infoRow("喂养增加饥饿", Math.round(s.feedHungerGain));
    rows += infoRow("喂养增加力量", s.feedStrengthGain);
    rows += infoRow("喂养增加速度", s.feedSpeedGain);
    rows += infoRow("喂养增加体力", s.feedStaminaGain);
    rows += infoRow("自然减少饥饿", Math.round(s.naturalHungerLoss));
    rows += infoRow("对话次数", s.talkCount);
    rows += infoRow("探险次数", s.exploreCount);
    rows += infoRow("探险消耗饥饿", Math.round(s.exploreHungerCost));
    rows += infoRow("遇见拉姆王次数", s.lahmKingCount);

    var medals = MEDALS.map(function (m) {
      var n = s.medals[m.key] || 0;
      return '<div class="medal-row ' + (n > 0 ? "on" : "") + '">' +
        '<span class="m"><span class="medal-dot"></span>' + m.name + "</span>" +
        '<span class="n">× ' + n + "</span></div>";
    }).join("");

    var battles = "";
    battles += infoRow("击败食人花", s.battle.flower.win + " / " + s.battle.flower.enc);
    battles += infoRow("击败小怪兽", s.battle.small.win + " / " + s.battle.small.enc);
    battles += infoRow("击败大怪兽", s.battle.big.win + " / " + s.battle.big.enc);
    battles += infoRow("遭遇红龙（胜 / 遇）", s.dragonWin + " / " + s.dragonEnc);
    battles += infoRow("钓鱼次数", s.fishCount);
    battles += infoRow("钓到白白鲸数", s.whaleCount + " / " + (s.whaleCount + s.noWhaleCount));
    battles += infoRow("复活次数", s.reviveCount);

    openSheet({
      kicker: "对照原版 V1.2.1 信息页字段",
      title: "信息",
      body:
        '<div class="info-grid">' + rows + "</div>" +
        '<div class="info-section">奖章</div>' + medals +
        '<div class="info-section">战绩与统计</div><div class="info-grid">' + battles + "</div>" +
        '<div class="note">战斗统计按“击败数 / 遭遇数”展示，与原版信息页一致。V1.2.1 中拉姆勇士勋章为隐藏标记：首次战胜红龙后解锁蓝龙，战胜蓝龙后标记清零。</div>' +
        '<div class="note">原版说明：饥饿每 4 小时自然 -1；单次探险最多消耗 28 点饥饿（海报文案，实际按体力分档 + 随机 + 事件额外值计算）。</div>',
      foot: '<button class="btn ghost" data-close>关闭</button>'
    });
  }

  // ---------- 设置 ----------
  function showSettings() {
    var speeds = [1, 30, 120];
    var seg = speeds.map(function (v) {
      return '<button data-speed="' + v + '" class="' + (state.speedMultiplier === v ? "on" : "") + '">' +
        (v === 1 ? "1× 原版" : v + "×") + "</button>";
    }).join("");

    // 纯静态托管（GitHub Pages 等）没有后端时，account.js 会把 LAM_ACCOUNT 置为 false。
    var accountField = window.LAM_ACCOUNT === false ? "" :
      '<div class="field"><label>账号</label><button class="btn" type="button" data-account>登录 / 注册</button><div class="account-hint" id="accountHint">未登录 · 存档仅在本机</div></div>';
    var storageNote = window.LAM_ACCOUNT === false
      ? "存档只保存在当前浏览器 localStorage。清除浏览器数据会丢失存档。"
      : "未登录时存档只保存在当前浏览器 localStorage；登录后会同步到云端。清除浏览器数据会丢失本地存档。";

    openSheet({
      kicker: "本地存档",
      title: "设置",
      body:
        '<div class="field"><label>拉姆名字</label><input id="nameInput" maxlength="12" value="' + esc(state.name) + '"></div>' +
        accountField +
        '<div class="field"><label>时间流速（V1.2.1 为每 4 小时 -1 饥饿）</label><div class="seg" id="speedSeg">' + seg + "</div></div>" +
        '<div class="note">H5 版把原版“读取手环运动数据”替换为牧场活动：伸展→体力，搬草垛→力量，散步→速度；活动值通过「喂养」转化。<br>事件文案、抽取概率、旅行消耗、战斗公式、属性递减与等级曲线均按 V1.2.1 源码还原。<br>诗词、笑话、科普、奇思妙想与台词均来自原版 assets/config.json。</div>' +
        '<div class="note" style="border-color:rgba(255,111,125,.25)">' + storageNote + '</div>',
      foot: '<button class="btn ghost" data-close>关闭</button><button class="btn warn" id="resetBtn">重新开始</button><button class="btn" id="saveName">保存名字</button>'
    });

    document.getElementById("speedSeg").addEventListener("click", function (e) {
      var b = e.target.closest("[data-speed]");
      if (!b) return;
      state.speedMultiplier = Number(b.dataset.speed);
      state.lastTick = Date.now();
      state.hungerAcc = 0;
      save();
      document.querySelectorAll("#speedSeg button").forEach(function (x) { x.classList.toggle("on", x === b); });
      toast("时间流速已切换为 " + (state.speedMultiplier === 1 ? "原版 1×" : state.speedMultiplier + "×"));
    });

    document.getElementById("saveName").addEventListener("click", function () {
      var v = document.getElementById("nameInput").value.trim();
      state.name = v || "你的拉姆";
      save(); render(); toast("名字已保存");
    });

    document.getElementById("resetBtn").addEventListener("click", function () {
      if (!confirm("确定重新开始？当前存档会被清除。")) return;
      try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
      state = defaultState();
      save(); render(); closeSheet(); toast("已经重新开始");
    });
  }

  // ---------- 事件绑定 ----------
  $("exploreBtn").addEventListener("click", explore);
  $("feedBtn").addEventListener("click", feed);
  $("scene").addEventListener("click", talk);
  $("scene").setAttribute("role", "button");
  $("scene").setAttribute("tabindex", "0");
  $("scene").addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); talk(); }
  });
  $("activityBtn").addEventListener("click", showActivities);
  $("infoBtn").addEventListener("click", showInfo);
  $("settingsBtn").addEventListener("click", showSettings);

  // ---------- 启动 ----------
  if (/[?&]debug=1/.test(location.search)) {
    window.LAM_DEBUG = {
      get state() { return state; },
      patch: function (p) { Object.assign(state, p); save(); render(); },
      setHunger: function (v) { state.hunger = v; if (v <= 0) die(); save(); render(); },
      explore: explore,
      talk: talk,
      feed: feed,
      doActivity: doActivity,
      showInfo: showInfo,
      showActivities: showActivities,
      resolveEvent: resolveEvent,
      settle: settle,
      locations: LOCATIONS
    };
  }

  // 供 account.js 使用的最小桥接；不暴露内部函数。
  window.LAM_APP = {
    get state() { return state; },
    get hasLocalSave() {
      try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
    },
    replaceState: function (raw) {
      state = mergeState(raw);
      save();
      render();
    },
    save: save,
    render: render,
    toast: toast,
    openSheet: openSheet,
    closeSheet: closeSheet,
    unlockSheet: function () { sheetLocked = false; }
  };

  var lost = settle();
  if (state.dead) {
    toast("你的拉姆已经死亡，完成 1 次牧场活动后点击喂养来复活", 3600);
  } else if (lost > 0) {
    toast("离开的这段时间，拉姆自然消耗了 " + lost + " 点饥饿", 2800);
  }
  if (lost > 0) save();
  else persist();
  render();

  setInterval(function () {
    var l = settle();
    if (l > 0) { save(); render(); }
  }, 5000);

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      var l = settle();
      if (l > 0) { save(); render(); }
    } else {
      persist();
    }
  });
  window.addEventListener("beforeunload", persist);
})();
