
const $ = (id) => document.getElementById(id);
const AUTH_PATHS = new Set(["/v1/auth/token", "/v1/auth/register", "/v1/auth/refresh"]);
let token = localStorage.getItem("pia_token") || "";
let conversations = [];
let currentConv = null;
let busy = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logout() {
  token = "";
  localStorage.removeItem("pia_token");
  localStorage.removeItem("pia_refresh");
  $("authView").classList.remove("hidden");
}

async function tryRefresh() {
  const rt = localStorage.getItem("pia_refresh");
  if (!rt) return false;
  try {
    const r = await fetch("/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    token = j.access_token;
    localStorage.setItem("pia_token", token);
    if (j.refresh_token) localStorage.setItem("pia_refresh", j.refresh_token);
    return true;
  } catch (e) { return false; }
}

async function api(path, opts = {}, allowRefresh = true) {
  opts = { ...opts, headers: { ...(opts.headers || {}) } };
  if (token) opts.headers["Authorization"] = "Bearer " + token;
  if (opts.body && typeof opts.body !== "string") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, opts);
  if (r.status === 401 && allowRefresh && !AUTH_PATHS.has(path)) {
    if (await tryRefresh()) return api(path, opts, false);
    logout();
    throw new Error("сессия истекла — войдите снова");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail ? JSON.stringify(data.detail) : ("HTTP " + r.status));
  return data;
}

async function loginOrRegister(register) {
  $("authErr").textContent = "";
  try {
    const path = register ? "/v1/auth/register" : "/v1/auth/token";
    const body = { email: $("email").value.trim(), password: $("password").value };
    if (!$("otp").classList.contains("hidden") && $("otp").value.trim()) body.otp = $("otp").value.trim();
    const data = await api(path, { method: "POST", body });
    token = data.access_token;
    localStorage.setItem("pia_token", token);
    if (data.refresh_token) localStorage.setItem("pia_refresh", data.refresh_token);
    $("authView").classList.add("hidden");
    $("otp").value = ""; $("otp").classList.add("hidden");
    await boot();
  } catch (e) {
    const m = String(e.message || e);
    if (m.includes("otp_required")) {
      $("otp").classList.remove("hidden"); $("otp").focus();
      $("authErr").textContent = "Введите код двухфакторной аутентификации";
    } else if (m.includes("too_many_failed_attempts")) {
      $("authErr").textContent = "Слишком много неудачных попыток — попробуйте позже";
    } else { $("authErr").textContent = m; }
  }
}

// ---------- rendering ----------
function renderRich(text) {
  // escape first, then apply a tiny markdown subset (**bold** `code` *italic*)
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
}

function addMsg(role, text, when) {
  const d = document.createElement("div");
  d.className = "msg " + role;
  if (role === "meta") {
    d.textContent = text;
  } else {
    d.innerHTML = renderRich(text);
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = new Date(when || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    d.appendChild(ts);
    d.title = new Date(when || Date.now()).toLocaleString();
  }
  $("msgs").appendChild(d);
  $("msgs").scrollTop = $("msgs").scrollHeight;
  return d;
}
function addMeta(text) { return addMsg("meta", text); }

function setChatbar() {
  $("chatTitle").textContent = currentConv ? (currentConv.title || "Чат") : "Новый чат";
  $("btnDelete").classList.toggle("hidden", !currentConv);
}

// ---------- conversations ----------
async function loadConversations() {
  conversations = await api("/v1/conversations");
  const box = $("convList");
  box.innerHTML = "";
  conversations.forEach((c) => {
    const d = document.createElement("div");
    d.className = "conv" + (currentConv && currentConv.id === c.id ? " active" : "");
    const s = document.createElement("span");
    s.textContent = c.title || "Без названия";
    d.appendChild(s);
    d.title = c.title || "";
    d.onclick = () => openConversation(c);
    box.appendChild(d);
  });
}

function newChat() {
  currentConv = null;
  $("msgs").innerHTML = "";
  addMeta("Новый чат — история сохраняется автоматически");
  setChatbar();
  loadConversations();
}

async function openConversation(c) {
  currentConv = c;
  $("msgs").innerHTML = "";
  setChatbar();
  const turns = await api(`/v1/conversations/${c.id}/messages`);
  turns.forEach((t) => addMsg(t.role, t.content, t.created_at));
  await loadConversations();
}

async function deleteCurrent() {
  if (!currentConv) return;
  if (!confirm("Удалить чат «" + (currentConv.title || "Без названия") + "»?")) return;
  try {
    await api(`/v1/conversations/${currentConv.id}`, { method: "DELETE" });
    newChat();
  } catch (e) { addMeta("Ошибка удаления: " + (e.message || e)); }
}

async function boot() {
  try { await api("/v1/settings/llm"); } catch (e) {}
  await loadConversations();
  newChat();
  try {
    const f = await api("/v1/facts");
    if (f.facts && f.facts.length) { addMeta("Ожидают вашего подтверждения:"); renderFacts(f.facts); }
  } catch (e) {}
}

// ---------- sending + streaming ----------
function showThinking() {
  const d = document.createElement("div");
  d.className = "msg meta thinking";
  d.id = "thinking";
  d.textContent = "думаю";
  $("msgs").appendChild(d);
  $("msgs").scrollTop = $("msgs").scrollHeight;
  return d;
}
function hideThinking() { const t = $("thinking"); if (t) t.remove(); }

let activeJob = null;

function setBusy(on, jobId) {
  busy = on;
  activeJob = on ? (jobId || activeJob) : null;
  const b = $("btnSend");
  if (on && activeJob) { b.textContent = "⏹ Стоп"; b.classList.add("stop"); b.disabled = false; }
  else { b.textContent = "Отправить"; b.classList.remove("stop"); b.disabled = on; }
}

async function stopGeneration() {
  if (!activeJob) return;
  const id = activeJob;
  $("btnSend").disabled = true;
  try { await api(`/v1/jobs/${id}/cancel`, { method: "POST" }); } catch (e) { addMeta("Не удалось остановить: " + (e.message || e)); }
}

function renderFacts(facts) {
  (facts || []).forEach((f) => {
    const box = document.createElement("div");
    box.className = "fact";
    const t = document.createElement("div");
    t.innerHTML = "📝 <b>Проверьте распознанные данные</b><br>" + renderRich(f.summary || f.kind || "");
    const actions = document.createElement("div");
    actions.className = "actions";
    const state = document.createElement("div");
    state.className = "state";
    const act = async (kind) => {
      actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await api(`/v1/facts/${f.id}/${kind}`, { method: "POST" });
        actions.remove();
        state.textContent = kind === "confirm" ? "✅ Сохранено в базе знаний" : "❌ Отклонено";
      } catch (e) {
        actions.querySelectorAll("button").forEach((b) => (b.disabled = false));
        state.textContent = "Ошибка: " + (e.message || e);
      }
    };
    const ok = document.createElement("button"); ok.textContent = "✅ Подтвердить"; ok.onclick = () => act("confirm");
    const no = document.createElement("button"); no.className = "ghost"; no.textContent = "❌ Отклонить"; no.onclick = () => act("reject");
    actions.append(ok, no);
    box.append(t, actions, state);
    $("msgs").appendChild(box);
  });
  $("msgs").scrollTop = $("msgs").scrollHeight;
}

async function send() {
  if (busy) { stopGeneration(); return; }
  const text = $("input").value.trim();
  if (!text) return;
  setBusy(true);
  $("input").value = "";
  addMsg("user", text);
  showThinking();
  try {
    const body = { text, channel: "mobile" };
    if (currentConv) body.conversation_id = currentConv.id;
    const res = await api("/v1/messages", { method: "POST", body });
    if (res.conversation_id && (!currentConv || currentConv.id !== res.conversation_id)) {
      currentConv = { id: res.conversation_id, title: text.slice(0, 80) };
      setChatbar();
      loadConversations();
    }
    if (res.assistant_text) {
      hideThinking();
      addMsg("assistant", res.assistant_text);
      renderFacts(res.pending_facts);
    } else if (res.job_id) {
      hideThinking();
      setBusy(true, res.job_id);
      await streamJob(res.job_id);
    }
  } catch (e) {
    hideThinking();
    const m = String(e.message || e);
    addMeta(m.includes("rate_limited") ? "Слишком много запросов — подождите минуту" : "Ошибка: " + m);
  } finally {
    hideThinking();
    setBusy(false);
    $("input").focus();
  }
}

function bubbleText(bubble) {
  return Array.from(bubble.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
}
function clearBubble(bubble) {
  Array.from(bubble.childNodes).forEach((n) => { if (n.nodeType === 3) n.remove(); });
}

async function pollJob(jobId, bubble) {
  // Fallback when SSE drops: poll the job until it reaches a terminal state.
  if (!bubbleText(bubble)) clearBubble(bubble), bubble.insertBefore(document.createTextNode("(соединение прервано — переключаюсь на опрос…)"), bubble.querySelector(".ts"));
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    let job;
    try { job = await api(`/v1/jobs/${jobId}`); } catch (e) { continue; }
    if (job.status === "completed" || job.status === "awaiting_confirm") {
      const text = job.result && job.result.assistant_text;
      if (text) { clearBubble(bubble); bubble.insertBefore(document.createTextNode(text), bubble.querySelector(".ts")); }
      renderFacts(job.pending_facts);
      return;
    }
    if (job.status === "cancelled") { addMeta("Остановлено"); return; }
    if (job.status === "failed") {
      bubble.textContent = "Ошибка: " + (job.error || "задача не удалась");
      return;
    }
  }
  bubble.textContent = "Таймаут: ответ не пришёл за 3 минуты";
}

// EventSource cannot send an Authorization header, and tokens in URLs end up in proxy/access logs.
// This is a tiny header-authenticated SSE client over fetch() with the same listener API.
class HeaderEventSource {
  constructor(url) {
    this.listeners = {};
    this.closed = false;
    this.ctrl = new AbortController();
    this._run(url);
  }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  close() { this.closed = true; this.ctrl.abort(); }
  _emit(name, data) {
    if (this.closed) return;
    for (const fn of this.listeners[name] || []) fn({ data });
  }
  async _run(url) {
    try {
      const open = () => fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "text/event-stream" }, signal: this.ctrl.signal });
      let r = await open();
      if (r.status === 401 && (await tryRefresh())) r = await open();
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let name = "message";
          const data = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (data.length) this._emit(name, data.join("\n"));
        }
      }
    } catch (e) { /* network error or abort: fall through */ }
    this._emit("error", undefined); // stream ended without a terminal event → caller falls back to polling
  }
}

function streamJob(jobId) {
  return new Promise((resolve) => {
    let settled = false;
    const bubble = addMsg("assistant", "");
    const chips = {}; // index/name → chip element (live tool-call construction)
    let lastChip = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { es.close(); } catch (e) {}
      if (!bubbleText(bubble).trim() && !bubble.classList.contains("err")) bubble.remove();
      resolve();
    };
    let es;
    const parse = (ev) => { try { return JSON.parse(ev.data); } catch (e) { return {}; } };
    const scroll = () => { $("msgs").scrollTop = $("msgs").scrollHeight; };
    const chipFor = (key) => {
      let chip = chips[key];
      if (!chip) {
        chip = document.createElement("div");
        chip.className = "tool-chip run";
        (lastChip || bubble).after(chip);
        lastChip = chip;
        chips[key] = chip;
      }
      return chip;
    };
    try {
      es = new HeaderEventSource(`/v1/jobs/${jobId}/events`);
    } catch (e) {
      pollJob(jobId, bubble).then(finish);
      return;
    }
    es.addEventListener("token", (ev) => {
      if (settled) return;
      bubble.insertBefore(document.createTextNode(parse(ev).content || ""), bubble.querySelector(".ts"));
      scroll();
    });
    es.addEventListener("reset", () => clearBubble(bubble));
    // the model is composing a tool call: name + arguments appear while they stream in
    const args = {};
    es.addEventListener("tool_call", (ev) => {
      if (settled) return;
      const d = parse(ev);
      const key = "call" + d.index;
      args[key] = (args[key] || "") + (d.arguments_delta || "");
      const chip = chipFor(key);
      chip.textContent = "⚙ " + (d.name || "…") + " " + args[key].slice(0, 80);
      scroll();
    });
    es.addEventListener("tool_start", (ev) => {
      if (settled) return;
      const d = parse(ev);
      clearBubble(bubble); // text before a tool call is a preamble; the final answer follows
      // reuse the chip created from streamed deltas, otherwise create a new one
      const key = Object.keys(chips).find((k) => chips[k].dataset.name === undefined && chips[k].textContent.includes(d.name)) || ("t" + Date.now() + Math.random());
      const chip = chipFor(key);
      chip.dataset.name = d.name;
      chip.dataset.key = key;
      chip.className = "tool-chip run";
      chip.textContent = "⏳ " + d.name + " " + (d.arguments || "").slice(0, 80);
      scroll();
    });
    es.addEventListener("tool", (ev) => {
      if (settled) return;
      const d = parse(ev);
      const running = Object.values(chips).find((c) => c.dataset.name === d.name && c.classList.contains("run"));
      const chip = running || chipFor("done" + Date.now() + Math.random());
      chip.className = "tool-chip " + (d.ok === false ? "bad" : "ok");
      chip.innerHTML = "";
      chip.append((d.ok === false ? "✖ " : "✔ ") + d.name + (d.summary ? " — " + d.summary : ""));
      if (d.ms != null) { const m = document.createElement("small"); m.textContent = d.ms + " мс"; chip.append(m); }
      scroll();
    });
    es.addEventListener("done", (ev) => {
      if (settled) return;
      const d = parse(ev);
      if (d.text && !bubbleText(bubble).trim()) bubble.insertBefore(document.createTextNode(d.text), bubble.querySelector(".ts"));
      renderFacts(d.pending_facts);
      finish();
    });
    es.addEventListener("cancelled", () => {
      if (settled) return;
      addMeta("⏹ Остановлено" + (bubbleText(bubble).trim() ? " — частичный ответ сохранён" : ""));
      finish();
    });
    es.addEventListener("error", (ev) => {
      if (settled) return;
      if (ev.data) {
        // server-sent error event (has payload)
        bubble.textContent = "Ошибка: " + (parse(ev).text || "неизвестная ошибка");
        bubble.classList.add("err");
        finish();
        return;
      }
      // native connection error / stream EOF → poll as a fallback
      try { es.close(); } catch (e) {}
      pollJob(jobId, bubble).then(finish);
    });
  });
}

// ---------- settings ----------
async function loadSettings() {
  try {
    const s = await api("/v1/settings/llm");
    $("sProvider").value = s.provider_kind;
    $("sBase").value = s.base_url;
    $("sModel").value = s.default_model;
    $("sEmb").value = s.embedding_model || "";
  } catch (e) {}
  try {
    const st = await api("/v1/stats");
    const u = st.usage_tokens || {};
    $("setStats").innerHTML =
      "📊 Статистика: джобов — <b>" + Object.values(st.jobs || {}).reduce((a, b) => a + b, 0) +
      "</b>, чатов — <b>" + st.conversations +
      "</b>, сообщений — <b>" + st.chat_turns +
      "</b>, сущностей — <b>" + st.entities +
      "</b>, наблюдений — <b>" + st.observations +
      "</b><br>Токены: prompt <b>" + u.prompt + "</b> / completion <b>" + u.completion + "</b>";
  } catch (e) { $("setStats").textContent = ""; }
}

async function loadSecurity() {
  try {
    const me = await api("/v1/auth/me");
    $("secStatus").textContent = "2FA: " + (me.totp_enabled ? "включена" : "выключена") + " · роль: " + me.role;
    $("btn2faSetup").classList.toggle("hidden", me.totp_enabled);
    $("twofaOff").classList.toggle("hidden", !me.totp_enabled);
    $("twofaBox").classList.add("hidden");
  } catch (e) {}
}
async function twofaSetup() {
  try {
    const r = await api("/v1/auth/2fa/setup", { method: "POST" });
    $("twofaSecret").textContent = r.secret + "\n" + r.otpauth_uri;
    $("twofaBox").classList.remove("hidden");
  } catch (e) { $("setMsg").className = "err"; $("setMsg").textContent = String(e.message || e); }
}
async function twofaEnable() {
  try {
    const r = await api("/v1/auth/2fa/enable", { method: "POST", body: { code: $("twofaCode").value.trim() } });
    $("recoveryBox").textContent = "Резервные коды (сохраните, каждый работает один раз):\n" + r.recovery_codes.join("\n");
    $("recoveryBox").classList.remove("hidden");
    $("twofaCode").value = "";
    await loadSecurity();
  } catch (e) { $("setMsg").className = "err"; $("setMsg").textContent = String(e.message || e); }
}
async function twofaDisable() {
  try {
    await api("/v1/auth/2fa/disable", { method: "POST", body: { password: $("offPass").value, code: $("offCode").value.trim() } });
    $("offPass").value = ""; $("offCode").value = "";
    $("recoveryBox").classList.add("hidden");
    await loadSecurity();
  } catch (e) { $("setMsg").className = "err"; $("setMsg").textContent = String(e.message || e); }
}
async function logoutAll() {
  try { await api("/v1/auth/logout-all", { method: "POST" }); } catch (e) {}
  logout();
  $("settingsView").classList.add("hidden");
}
async function linkCode() {
  try {
    const r = await api(`/v1/channels/${$("chSel").value}/link-code`, { method: "POST" });
    $("linkBox").textContent = r.code + "\n" + (r.instructions || "");
    $("linkBox").classList.remove("hidden");
  } catch (e) { $("setMsg").className = "err"; $("setMsg").textContent = String(e.message || e); }
}

async function saveSettings() {
  const msg = $("setMsg");
  msg.className = ""; msg.textContent = "";
  const body = {
    provider_kind: $("sProvider").value,
    base_url: $("sBase").value.trim(),
    default_model: $("sModel").value.trim(),
    embedding_model: $("sEmb").value.trim() || null,
  };
  const key = $("sKey").value.trim();
  if (key) body.api_key = key;
  try {
    await api("/v1/settings/llm", { method: "PATCH", body });
    msg.className = "ok";
    msg.textContent = "Сохранено ✔";
    $("sKey").value = "";
    loadSettings();
  } catch (e) { msg.className = "err"; msg.textContent = String(e.message || e); }
}

// ---------- wiring ----------
$("btnLogin").onclick = () => loginOrRegister(false);
$("btnRegister").onclick = () => loginOrRegister(true);
$("btnSend").onclick = send;
$("btnNew").onclick = newChat;
$("btnDelete").onclick = deleteCurrent;
$("btnLogout").onclick = logout;
$("btnSettings").onclick = () => { $("settingsView").classList.remove("hidden"); $("setMsg").className = ""; loadSettings(); loadSecurity(); };
$("btn2faSetup").onclick = twofaSetup;
$("btn2faEnable").onclick = twofaEnable;
$("btn2faDisable").onclick = twofaDisable;
$("btnLogoutAll").onclick = logoutAll;
$("btnLinkCode").onclick = linkCode;
$("btnCloseSettings").onclick = () => $("settingsView").classList.add("hidden");
$("btnSaveSettings").onclick = saveSettings;
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });

if (token) { $("authView").classList.add("hidden"); boot(); }
