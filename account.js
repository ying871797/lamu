/* 账号 UI 与云存档同步
 * 依赖 game.js 暴露的 window.LAM_APP。
 * 密码在浏览器端做 PBKDF2；服务端只做 HMAC，避免 Workers 免费 CPU 超限。
 */
(function () {
  "use strict";

  var app = window.LAM_APP;
  if (!app) return;

  var PBKDF2_ITERATIONS = 210000;
  var SESSION_HINT = "未登录 · 存档仅在本机";
  var RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  var account = {
    user: null,
    available: true,
    baseVersion: 0,
    cloud: null,
    syncing: false,
    pending: false,
    offline: false,
    conflict: false,
    applying: false,
    timer: null,
    turnstileKey: "",
    turnstileToken: "",
    turnstileLoading: false,
    turnstileFailed: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  // ---------- 编码与密码 ----------
  function bytesToB64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlToBytes(text) {
    var s = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var raw = atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function randomSalt() {
    return bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
  }

  function randomRecoveryCode() {
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    var chars = [];
    for (var i = 0; i < 16; i++) chars.push(RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length]);
    var c = chars.join("");
    return [c.slice(0, 4), c.slice(4, 8), c.slice(8, 12), c.slice(12, 16)].join("-");
  }

  function normalizeRecovery(code) {
    return String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "")
      .replace(/[IL]/g, "1").replace(/O/g, "0");
  }

  async function derive(password, saltB64) {
    var enc = new TextEncoder();
    var key = await crypto.subtle.importKey(
      "raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]
    );
    var bits = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      salt: b64urlToBytes(saltB64),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    }, key, 256);
    return bytesToB64url(new Uint8Array(bits));
  }

  // ---------- API ----------
  async function api(path, opts) {
    opts = opts || {};
    var options = {
      method: opts.method || "GET",
      credentials: "include",
      headers: Object.assign({}, opts.headers || {})
    };
    if (opts.body != null) {
      options.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      options.headers["content-type"] = "application/json";
    }
    var res = await fetch("/api" + path, options);
    var data;
    try {
      data = await res.json();
    } catch (e) {
      data = { ok: false, code: "BAD_RESPONSE", message: "响应格式错误" };
    }
    if (!res.ok || data.ok === false) {
      var err = new Error(data.message || "请求失败");
      err.code = data.code;
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------- 状态 ----------
  function setStatus(text, tone) {
    var el = $("syncStatus");
    if (el) {
      el.textContent = text;
      el.className = "sync-status" + (tone ? " " + tone : "");
    }
    var hint = $("accountHint");
    if (hint) hint.textContent = text;
  }

  function fmtDate(ts) {
    if (!ts) return "未知";
    var d = new Date(ts);
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  function hasProgress(s) {
    if (!s) return false;
    return !!(s.feedCount > 0 || s.exploreCount > 0 || s.talkCount > 0 ||
      s.stamina > 28 || s.strength > 8 || s.speed > 23 ||
      s.hunger < 100 || s.dead);
  }

  function fingerprint(s) {
    if (!s) return "";
    var copy = JSON.parse(JSON.stringify(s));
    // 这些字段只是时钟/结算游标，不代表玩家进度。
    delete copy.updatedAt;
    delete copy.lastTick;
    delete copy.hungerAcc;
    return JSON.stringify(copy);
  }

  function showError(message) {
    var el = $("accError");
    if (el) {
      el.textContent = message || "";
      el.style.display = message ? "block" : "none";
    } else if (message) {
      app.toast(message, 3200);
    }
  }

  function busy(button, text) {
    if (!button) return;
    button.disabled = true;
    button.dataset.label = button.textContent;
    button.textContent = text || "处理中…";
  }

  function unbusy(button) {
    if (!button) return;
    button.disabled = false;
    if (button.dataset.label) button.textContent = button.dataset.label;
  }

  // ---------- 同步 ----------
  function scheduleSync() {
    if (!account.user) return;
    clearTimeout(account.timer);
    account.timer = setTimeout(function () { syncNow(false); }, 2000);
  }

  async function syncNow(force) {
    if (!account.user) return false;
    if (account.syncing) { account.pending = true; return false; }
    if (account.conflict && !force) return false;
    account.syncing = true;
    setStatus("同步中…", "sync");
    var snapshot = JSON.parse(JSON.stringify(app.state));
    try {
      var res = await api("/save", {
        method: "PUT",
        body: { baseVersion: account.baseVersion, state: snapshot, force: !!force }
      });
      account.baseVersion = res.version;
      account.cloud = { state: snapshot, version: res.version, updatedAt: res.updatedAt };
      account.pending = false;
      account.offline = false;
      account.conflict = false;
      setStatus("已同步", "online");
      return true;
    } catch (err) {
      if (err.status === 401) {
        account.user = null;
        setStatus(SESSION_HINT, "");
      } else if (err.code === "VERSION_CONFLICT") {
        account.cloud = err.data.save;
        account.baseVersion = err.data.save.version;
        account.conflict = true;
        setStatus("冲突", "warn");
        showConflict(err.data.save);
      } else {
        account.pending = true;
        account.offline = true;
        setStatus("离线 · 本地已保存", "offline");
      }
      return false;
    } finally {
      account.syncing = false;
      if (account.pending && account.user && !account.offline) scheduleSync();
    }
  }

  function applyRemote(raw) {
    account.conflict = false;
    account.applying = true;
    app.replaceState(raw);
    account.applying = false;
  }

  async function loadCloud() {
    var res = await api("/save");
    account.cloud = res.save;
    account.baseVersion = res.save ? res.save.version : 0;
    return res.save;
  }

  async function afterLogin(interactive) {
    account.conflict = false;
    var cloud = await loadCloud();
    var local = app.state;
    var localHas = hasProgress(local);
    if (!cloud) {
      account.baseVersion = 0;
      if (localHas) await syncNow(true);
      setStatus("已同步", "online");
      return;
    }
    if (!localHas) {
      applyRemote(cloud.state);
      account.baseVersion = cloud.version;
      setStatus("已同步", "online");
      return;
    }
    if (fingerprint(local) === fingerprint(cloud.state)) {
      account.baseVersion = cloud.version;
      setStatus("已同步", "online");
      return;
    }
    var localAt = Number(local.updatedAt) || 0;
    var cloudAt = Number(cloud.updatedAt) || 0;
    if (!interactive) {
      if (localAt > cloudAt + 1500) {
        account.baseVersion = cloud.version;
        await syncNow(true);
      } else {
        applyRemote(cloud.state);
        account.baseVersion = cloud.version;
        setStatus("已同步", "online");
      }
      return;
    }
    if (Math.abs(localAt - cloudAt) < 1500) {
      account.baseVersion = cloud.version;
      setStatus("已同步", "online");
      return;
    }
    showMigration(local, cloud, localAt >= cloudAt);
  }

  // ---------- 账号弹层 ----------
  function openAccount() {
    if (account.user) showPanel();
    else showAuth("login");
  }

  function authShell(tab, body, foot) {
    return '<div class="account-tabs">' +
      '<button type="button" data-auth-tab="login" class="' + (tab === "login" ? "on" : "") + '">登录</button>' +
      '<button type="button" data-auth-tab="register" class="' + (tab === "register" ? "on" : "") + '">注册</button>' +
      "</div>" + body + (foot || "");
  }

  function bindAuthTabs() {
    document.querySelectorAll("[data-auth-tab]").forEach(function (b) {
      b.addEventListener("click", function () { showAuth(b.dataset.authTab); });
    });
  }

  function showAuth(tab) {
    account.turnstileToken = "";
    var isReg = tab === "register";
    var body = authShell(tab,
      '<form id="authForm" class="account-form" autocomplete="on">' +
        '<div class="field"><label>账号名</label><input id="authUser" maxlength="20" autocomplete="username" placeholder="3–20 位字母、数字或下划线"></div>' +
        '<div class="field"><label>密码</label><input id="authPass" type="password" maxlength="72" autocomplete="' + (isReg ? "new-password" : "current-password") + '" placeholder="至少 8 位"></div>' +
        (isReg ? '<div class="field"><label>确认密码</label><input id="authPass2" type="password" maxlength="72" autocomplete="new-password"></div>' : "") +
        (isReg ? '<div class="account-hint">注册成功后会显示一次性恢复码，请务必保存。忘记密码只能靠它找回。</div>' : "") +
        '<div class="account-hint">账号仅用于登录与云存档，不用于广告或分析。</div>' +
        '<div id="turnstile" class="turnstile"></div>' +
        '<div class="account-error" id="accError" style="display:none"></div>' +
        '<button class="btn" id="authSubmit" type="submit">' + (isReg ? "注册并登录" : "登录") + "</button>" +
      "</form>" +
      '<div class="account-links"><button type="button" class="link" id="forgotBtn">忘记密码？</button></div>'
    );
    app.openSheet({ kicker: "云存档", title: isReg ? "注册账号" : "登录", body: body, foot: '<button class="btn ghost" data-close>关闭</button>', noFocus: true });

    bindAuthTabs();
    renderTurnstile();
    var forgot = $("forgotBtn");
    if (forgot) forgot.addEventListener("click", showRecover);

    var form = $("authForm");
    if (!form) return;
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      showError("");
      var btn = $("authSubmit");
      var username = ($("authUser").value || "").trim();
      var pass = $("authPass").value || "";
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) { showError("账号名需为 3–20 位字母、数字或下划线"); return; }
      if (pass.length < 8) { showError("密码至少 8 位"); return; }
      if (isReg && pass !== ($("authPass2").value || "")) { showError("两次密码不一致"); return; }

      busy(btn, isReg ? "注册中…" : "登录中…");
      try {
        if (isReg) {
          var salt = randomSalt();
          var hash = await derive(pass, salt);
          var recovery = randomRecoveryCode();
          var reg = await api("/register", {
            method: "POST",
            body: {
              username: username,
              kdfSalt: salt,
              passwordHash: hash,
              recoveryCode: normalizeRecovery(recovery),
              turnstileToken: account.turnstileToken || ""
            }
          });
          account.user = reg.user;
          showRecoveryCode(reg.recoveryCode || recovery, async function () {
            await afterLogin(true);
            app.toast("注册成功，已登录", 2600);
          });
        } else {
          var saltRes = await api("/salt?username=" + encodeURIComponent(username));
          var loginHash = await derive(pass, saltRes.kdfSalt);
          var out = await api("/login", {
            method: "POST",
            body: { username: username, passwordHash: loginHash, turnstileToken: account.turnstileToken || "" }
          });
          account.user = out.user;
          app.closeSheet();
          await afterLogin(true);
          app.toast("登录成功", 2200);
        }
      } catch (err) {
        showError(err.message || "操作失败");
        if (window.turnstile) window.turnstile.reset();
        unbusy(btn);
      }
    });
  }

  function showRecoveryCode(code, next) {
    var body =
      '<div class="account-hint">这是找回密码的唯一凭证。关闭后不再显示，请复制或下载保存。</div>' +
      '<div class="recovery-code" id="recoveryCode">' + esc(code) + "</div>" +
      '<label class="account-check"><input type="checkbox" id="savedRecoveryChk"> 我已经保存好恢复码</label>' +
      '<div class="account-actions"><button class="btn ghost" type="button" id="copyRecovery">复制</button></div>';
    app.openSheet({
      kicker: "账号安全",
      title: "保存恢复码",
      body: body,
      foot: '<button class="btn" id="savedRecovery" type="button" disabled>继续</button>',
      noFocus: false,
      locked: true
    });
    var closeBtn = $("sheetClose");
    if (closeBtn) closeBtn.style.display = "none";
    var chk = $("savedRecoveryChk");
    var nextBtn = $("savedRecovery");
    chk.addEventListener("change", function () { nextBtn.disabled = !chk.checked; });
    $("copyRecovery").addEventListener("click", async function () {
      try {
        await navigator.clipboard.writeText(code);
        app.toast("已复制恢复码", 1800);
      } catch (e) {
        app.toast("复制失败，请手动选择文本", 2400);
      }
    });
    nextBtn.addEventListener("click", function () {
      if (!chk.checked) return;
      app.unlockSheet();
      app.closeSheet();
      if (next) next();
    });
  }

  function showPanel() {
    var u = account.user;
    var body =
      '<div class="account-kv"><span>账号</span><b>' + esc(u.username) + "</b></div>" +
      '<div class="account-kv"><span>注册时间</span><b>' + esc(fmtDate(u.createdAt)) + "</b></div>" +
      '<div class="account-kv"><span>同步状态</span><b id="panelSync">' + esc($("syncStatus") ? $("syncStatus").textContent : "—") + "</b></div>" +
      '<div class="account-actions">' +
        '<button class="btn" type="button" id="syncNowBtn">立即同步</button>' +
        '<button class="btn ghost" type="button" id="exportBtn">导出存档</button>' +
        '<button class="btn ghost" type="button" id="changePwBtn">修改密码</button>' +
        '<button class="btn ghost" type="button" id="logoutBtn">退出登录</button>' +
        '<button class="btn warn" type="button" id="deleteBtn">删除账号</button>' +
      "</div>" +
      '<div class="account-hint">账号仅用于登录与云存档，不用于广告或分析。退出登录后本地存档会保留；删除账号会永久删除云端数据。</div>';
    app.openSheet({
      kicker: "云存档",
      title: "账号",
      body: body,
      foot: '<button class="btn ghost" data-close>关闭</button>',
      noFocus: true
    });

    $("syncNowBtn").addEventListener("click", async function () {
      var ok = await syncNow(false);
      if (ok) {
        app.toast("同步完成", 1800);
        showPanel();
      }
    });
    $("exportBtn").addEventListener("click", exportData);
    $("changePwBtn").addEventListener("click", showChangePassword);
    $("logoutBtn").addEventListener("click", logout);
    $("deleteBtn").addEventListener("click", showDelete);
  }

  async function logout() {
    try { await api("/logout", { method: "POST" }); } catch (e) { /* 忽略 */ }
    account.user = null;
    account.cloud = null;
    account.baseVersion = 0;
    account.conflict = false;
    setStatus(SESSION_HINT, "");
    app.closeSheet();
    app.toast("已退出登录，本地存档已保留", 2400);
  }

  function showChangePassword() {
    var body =
      '<form id="pwForm" class="account-form">' +
        '<div class="field"><label>当前密码</label><input id="pwCurrent" type="password" maxlength="72" autocomplete="current-password"></div>' +
        '<div class="field"><label>新密码</label><input id="pwNew" type="password" maxlength="72" autocomplete="new-password"></div>' +
        '<div class="field"><label>确认新密码</label><input id="pwNew2" type="password" maxlength="72" autocomplete="new-password"></div>' +
        '<div class="account-error" id="accError" style="display:none"></div>' +
        '<button class="btn" id="pwSubmit" type="submit">保存</button>' +
      "</form>";
    app.openSheet({
      kicker: "账号安全", title: "修改密码", body: body,
      foot: '<button class="btn ghost" data-close>关闭</button>', noFocus: true
    });
    $("pwForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      showError("");
      var cur = $("pwCurrent").value || "";
      var next = $("pwNew").value || "";
      var next2 = $("pwNew2").value || "";
      if (next.length < 8) { showError("新密码至少 8 位"); return; }
      if (next !== next2) { showError("两次新密码不一致"); return; }
      var btn = $("pwSubmit");
      busy(btn, "保存中…");
      try {
        var saltRes = await api("/salt?username=" + encodeURIComponent(account.user.username));
        var currentHash = await derive(cur, saltRes.kdfSalt);
        var newSalt = randomSalt();
        var newHash = await derive(next, newSalt);
        await api("/password", { method: "POST", body: { currentHash: currentHash, newSalt: newSalt, newHash: newHash } });
        app.toast("密码已修改，其他设备已退出", 2600);
        app.closeSheet();
      } catch (err) {
        showError(err.message || "修改失败");
        unbusy(btn);
      }
    });
  }

  function showDelete() {
    var body =
      '<div class="account-hint">删除后账号、会话和云端存档会永久删除，无法恢复。建议先导出存档。</div>' +
      '<form id="deleteForm" class="account-form">' +
        '<div class="field"><label>当前密码</label><input id="delPass" type="password" maxlength="72" autocomplete="current-password"></div>' +
        '<div class="field"><label>输入账号名确认</label><input id="delUser" maxlength="20" autocomplete="off" placeholder="' + esc(account.user.username) + '"></div>' +
        '<div class="account-error" id="accError" style="display:none"></div>' +
        '<div class="account-actions">' +
          '<button class="btn ghost" type="button" id="delExport">先导出</button>' +
          '<button class="btn warn" id="delSubmit" type="submit">确认删除</button>' +
        "</div>" +
      "</form>";
    app.openSheet({
      kicker: "危险操作", title: "删除账号", body: body,
      foot: '<button class="btn ghost" data-close>取消</button>', noFocus: true
    });
    $("delExport").addEventListener("click", exportData);
    $("deleteForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      showError("");
      var pass = $("delPass").value || "";
      var confirmUser = ($("delUser").value || "").trim();
      if (confirmUser.toLowerCase() !== account.user.username.toLowerCase()) { showError("账号名不一致"); return; }
      var btn = $("delSubmit");
      busy(btn, "删除中…");
      try {
        var saltRes = await api("/salt?username=" + encodeURIComponent(account.user.username));
        var hash = await derive(pass, saltRes.kdfSalt);
        await api("/account", { method: "DELETE", body: { passwordHash: hash, confirmUsername: confirmUser } });
        account.user = null;
        account.cloud = null;
        account.baseVersion = 0;
        account.conflict = false;
        setStatus(SESSION_HINT, "");
        app.closeSheet();
        app.toast("账号已删除，本地存档已保留", 3000);
      } catch (err) {
        showError(err.message || "删除失败");
        unbusy(btn);
      }
    });
  }

  function showRecover() {
    var body =
      '<form id="recoverForm" class="account-form">' +
        '<div class="field"><label>账号名</label><input id="recUser" maxlength="20" autocomplete="username"></div>' +
        '<div class="field"><label>恢复码</label><input id="recCode" maxlength="24" autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX"></div>' +
        '<div class="field"><label>新密码</label><input id="recPass" type="password" maxlength="72" autocomplete="new-password"></div>' +
        '<div class="field"><label>确认新密码</label><input id="recPass2" type="password" maxlength="72" autocomplete="new-password"></div>' +
        '<div class="account-error" id="accError" style="display:none"></div>' +
        '<button class="btn" id="recSubmit" type="submit">重置密码</button>' +
      "</form>";
    app.openSheet({
      kicker: "账号安全", title: "找回密码", body: body,
      foot: '<button class="btn ghost" data-close>关闭</button>', noFocus: true
    });
    $("recoverForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      showError("");
      var username = ($("recUser").value || "").trim();
      var code = $("recCode").value || "";
      var pass = $("recPass").value || "";
      var pass2 = $("recPass2").value || "";
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) { showError("账号名格式不正确"); return; }
      if (normalizeRecovery(code).length !== 16) { showError("恢复码应为 16 位"); return; }
      if (pass.length < 8) { showError("新密码至少 8 位"); return; }
      if (pass !== pass2) { showError("两次新密码不一致"); return; }
      var btn = $("recSubmit");
      busy(btn, "重置中…");
      try {
        var newSalt = randomSalt();
        var newHash = await derive(pass, newSalt);
        var newRecovery = randomRecoveryCode();
        var out = await api("/recover", {
          method: "POST",
          body: {
            username: username,
            recoveryCode: normalizeRecovery(code),
            newSalt: newSalt,
            newHash: newHash,
            newRecoveryCode: normalizeRecovery(newRecovery)
          }
        });
        showRecoveryCode(out.recoveryCode || newRecovery, function () { showAuth("login"); });
      } catch (err) {
        showError(err.message || "重置失败");
        unbusy(btn);
      }
    });
  }

  function showMigration(local, cloud, localNewer) {
    var localLevel = Math.floor(((local.stamina || 0) + (local.strength || 0) + (local.speed || 0)) / 100);
    var body =
      '<div class="account-hint">检测到本地和云端都有存档。请选择保留哪一份；覆盖前会先保留一份本地备份。</div>' +
      '<div class="migration-grid">' +
        '<div class="migration-card ' + (localNewer ? "recommend" : "") + '">' +
          '<b>本地存档</b><span>' + esc(fmtDate(local.updatedAt)) + "</span>" +
          '<small>等级 ' + localLevel + " · 饥饿 " + Math.floor(local.hunger || 0) + "</small>" +
        "</div>" +
        '<div class="migration-card ' + (!localNewer ? "recommend" : "") + '">' +
          '<b>云端存档</b><span>' + esc(fmtDate(cloud.updatedAt)) + "</span>" +
          "<small>版本 v" + cloud.version + "</small>" +
        "</div>" +
      "</div>" +
      '<div class="account-actions">' +
        '<button class="btn" type="button" id="useLocal">用本地</button>' +
        '<button class="btn ghost" type="button" id="useCloud">用云端</button>' +
        '<button class="btn ghost" type="button" id="exportLocal">先导出本地</button>' +
      "</div>" +
      '<div class="account-hint">' + (localNewer ? "本地存档较新，推荐用本地。" : "云端存档较新，推荐用云端。") + "</div>";
    app.openSheet({
      kicker: "存档迁移", title: "选择存档", body: body,
      foot: '<button class="btn ghost" data-close>稍后再说</button>', noFocus: true
    });
    $("useLocal").addEventListener("click", async function () {
      account.baseVersion = cloud.version;
      account.conflict = false;
      app.closeSheet();
      await syncNow(true);
      app.toast("已用本地存档覆盖云端", 2400);
    });
    $("useCloud").addEventListener("click", function () {
      applyRemote(cloud.state);
      account.baseVersion = cloud.version;
      setStatus("已同步", "online");
      app.closeSheet();
      app.toast("已使用云端存档", 2200);
    });
    $("exportLocal").addEventListener("click", function () { exportData(); });
  }

  function showConflict(cloud) {
    var body =
      '<div class="account-hint">云端存档已经更新（版本 v' + cloud.version + '），本地还有未同步的修改。</div>' +
      '<div class="account-actions">' +
        '<button class="btn" type="button" id="conflictCloud">用云端</button>' +
        '<button class="btn ghost" type="button" id="conflictLocal">覆盖云端</button>' +
        '<button class="btn ghost" type="button" id="conflictExport">先导出本地</button>' +
      "</div>";
    app.openSheet({
      kicker: "同步冲突", title: "云端有更新", body: body,
      foot: '<button class="btn ghost" data-close>稍后再说</button>', noFocus: true
    });
    $("conflictCloud").addEventListener("click", function () {
      applyRemote(cloud.state);
      account.baseVersion = cloud.version;
      setStatus("已同步", "online");
      app.closeSheet();
    });
    $("conflictLocal").addEventListener("click", async function () {
      account.conflict = false;
      app.closeSheet();
      await syncNow(true);
      app.toast("已用本地覆盖云端", 2200);
    });
    $("conflictExport").addEventListener("click", function () { exportData(); });
  }

  function download(filename, data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function exportData() {
    try {
      if (account.user) {
        var out = await api("/export");
        download("lamu-export-" + account.user.username + ".json", out);
      } else {
        download("lamu-local.json", {
          exportedAt: Date.now(),
          user: null,
          save: { state: app.state, version: 0, updatedAt: app.state.updatedAt }
        });
      }
      app.toast("导出已开始", 1800);
    } catch (err) {
      app.toast(err.message || "导出失败", 2600);
    }
  }

  // ---------- Turnstile ----------
  function renderTurnstile() {
    if (!account.turnstileKey) return;
    var box = $("turnstile");
    if (!box) return;
    if (!window.turnstile) {
      if (account.turnstileLoading) return;
      account.turnstileLoading = true;
      var s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.defer = true;
      s.onload = function () { account.turnstileLoading = false; renderTurnstile(); };
      s.onerror = function () { account.turnstileLoading = false; account.turnstileFailed = true; };
      document.head.appendChild(s);
      return;
    }
    try {
      window.turnstile.render(box, {
        sitekey: account.turnstileKey,
        theme: "dark",
        callback: function (token) { account.turnstileToken = token; },
        "expired-callback": function () { account.turnstileToken = ""; }
      });
    } catch (e) {
      account.turnstileFailed = true;
    }
  }

  // ---------- 初始化 ----------
  // game.js 在渲染设置页时会读这个标记；没有后端（例如纯静态托管）时隐藏账号入口。
  window.LAM_ACCOUNT = true;

  function hideAccountUi() {
    account.available = false;
    window.LAM_ACCOUNT = false;
    var btn = document.querySelector("[data-account]");
    if (btn) {
      var field = btn.closest(".field");
      (field || btn).remove();
    }
    var line = document.querySelector(".account-line");
    if (line) line.remove();
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-account]")) {
      e.preventDefault();
      if (account.available) openAccount();
    }
  });

  window.addEventListener("lamu:save", function () {
    if (account.applying) return;
    scheduleSync();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (account.user) syncNow(false);
    } else if (account.pending && account.user) {
      syncNow(false);
    }
  });

  window.addEventListener("online", function () {
    account.offline = false;
    if (account.user) syncNow(false);
  });

  (async function init() {
    // 静态托管在 api-config.js 里把 LAMU_API 置为 false，直接跳过探测，避免 404 请求。
    if (window.LAMU_API === false) {
      hideAccountUi();
      return;
    }
    try {
      var cfg = await api("/config");
      account.turnstileKey = cfg.turnstileSiteKey || "";
    } catch (e) {
      // 纯静态托管（如 GitHub Pages）没有 /api，直接隐藏账号功能，游戏仍可游客玩。
      hideAccountUi();
      return;
    }
    try {
      var me = await api("/me");
      account.user = me.user;
      await afterLogin(false);
    } catch (e) {
      if (e.status === 401) setStatus(SESSION_HINT, "");
      else setStatus("离线 · 本地已保存", "offline");
    }
  })();
})();
