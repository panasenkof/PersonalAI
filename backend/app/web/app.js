
const $ = (id) => document.getElementById(id);
const AUTH_PATHS = new Set(["/v1/auth/token", "/v1/auth/register", "/v1/auth/refresh", "/v1/auth/password", "/v1/auth/2fa/disable", "/v1/auth/password/request", "/v1/auth/password/reset", "/v1/auth/email/request", "/v1/auth/email/verify"]);
let token = localStorage.getItem("pia_token") || "";
let conversations = [];
let currentConv = null;
let busy = false;
let authBusy = false;
let attachment = null;
let uploading = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logout() {
  token = "";
  localStorage.removeItem("pia_token");
  localStorage.removeItem("pia_refresh");
  document.querySelector("main").inert = document.querySelector("header").inert = true;
  $("authView").classList.remove("hidden");
  $("settingsView").classList.add("hidden");
  $("msgs").replaceChildren(); $("convList").replaceChildren();
  $("password").value = ""; $("otp").value = "";
  for (const id of ["currentPass","newPass","passwordOtp","sKey","offPass","offCode","twofaCode","dataPass","dataOtp","deleteEmail"]) $(id).value = "";
  for (const id of ["recoveryBox","twofaSecret","linkBox"]) { $(id).textContent = ""; }
  $("input").value = "";
  currentConv = null;
  clearAttachment();
  closeChats();
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
  if (opts.body && typeof opts.body !== "string" && !(opts.body instanceof FormData)) {
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

function friendlyError(message) {
  if (message.includes("email_not_verified")) return "Подтвердите email по ссылке из письма. Повторно запросить письмо можно через «Подтвердить email».";
  if (message.includes("email_service_unavailable")) return "Почтовый сервис пока не настроен. Обратитесь к владельцу сервера.";
  if (message.includes("stop_active_jobs")) return "Сначала остановите или дождитесь завершения всех задач аккаунта.";
  if (message.includes("type_email_to_confirm")) return "Для удаления введите email своего аккаунта.";
  if (message.includes("export_too_large")) return "Архив слишком большой для самостоятельного экспорта. Обратитесь в поддержку.";
  if (message.includes("file_too_large")) return "Файл слишком большой. Уменьшите его размер или уточните лимит у владельца сервера.";
  if (message.includes("invalid_credentials")) return "Неверный email или пароль";
  if (message.includes("invalid_otp")) return "Неверный код подтверждения";
  if (message.includes("email_taken")) return "Этот email уже зарегистрирован. Нажмите «Войти».";
  if (/fetch|network|offline/i.test(message)) return "Не удалось связаться с сервером. Проверьте интернет и повторите.";
  if (/value_error|string_too|422/.test(message)) return "Проверьте email и пароль. Для регистрации нужно минимум 8 символов.";
  return message;
}
function closeChats() {
  document.body.classList.remove("chats-open");
  $("btnChats").setAttribute("aria-expanded", "false");
}
async function loginOrRegister(register) {
  if (authBusy) return;
  if (!$("email").checkValidity() || !$("email").value || !$("password").value || (register && $("password").value.length < 8)) {
    $("authErr").textContent = "Укажите корректный email и пароль. Для регистрации нужно минимум 8 символов."; return;
  }
  authBusy = true;
  $("btnLogin").disabled = $("btnRegister").disabled = true;
  $("authErr").textContent = "";
  try {
    const path = register ? "/v1/auth/register" : "/v1/auth/token";
    const body = { email: $("email").value.trim(), password: $("password").value };
    if (!$("otp").classList.contains("hidden") && $("otp").value.trim()) body.otp = $("otp").value.trim();
    const data = await api(path, { method: "POST", body });
    if (data.email_verification_required) {
      $("authErr").textContent = "Письмо для подтверждения email отправлено. Подтвердите адрес, затем войдите.";
      return;
    }
    token = data.access_token;
    localStorage.setItem("pia_token", token);
    if (data.refresh_token) localStorage.setItem("pia_refresh", data.refresh_token);
    document.querySelector("main").inert = document.querySelector("header").inert = false;
    $("authView").classList.add("hidden");
    $("otp").value = ""; $("otp").classList.add("hidden");
    $("password").value = "";
    await boot();
  } catch (e) {
    const m = String(e.message || e);
    if (m.includes("otp_required")) {
      $("otp").classList.remove("hidden"); $("otp").focus();
      $("authErr").textContent = "Введите код двухфакторной аутентификации";
    } else if (m.includes("too_many_failed_attempts")) {
      $("authErr").textContent = "Слишком много неудачных попыток — попробуйте позже";
    } else { $("authErr").textContent = friendlyError(m); }
  }
  finally { authBusy = false; $("btnLogin").disabled = $("btnRegister").disabled = false; }
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
    const d = document.createElement("button");
    d.className = "conv ghost" + (currentConv && currentConv.id === c.id ? " active" : "");
    const s = document.createElement("span");
    s.textContent = c.title || "Без названия";
    d.appendChild(s);
    d.title = c.title || "";
    d.onclick = () => openConversation(c).catch(e => addMeta(friendlyError(e.message)));
    box.appendChild(d);
  });
}

function newChat() {
  if (busy) return;
  currentConv = null;
  $("msgs").innerHTML = "";
  closeChats();
  const welcome = document.createElement("div"); welcome.className = "welcome"; welcome.id = "welcome";
  welcome.innerHTML = '<h1>С чего начнём?</h1><p>Задайте вопрос или сохраните заметку. История чатов сохраняется автоматически.</p><div class="examples"></div><p>Перед первым сообщением проверьте модель в «Настройках». Ответы ИИ могут содержать ошибки.</p>';
  for (const example of ["Что ты умеешь?", "Запомни: я предпочитаю краткие ответы", "Найди мои сохранённые заметки"]) {
    const button = document.createElement("button"); button.className = "ghost"; button.textContent = example;
    button.onclick = () => { $("input").value = example; $("input").focus(); }; welcome.querySelector(".examples").append(button);
  }
  $("msgs").append(welcome);
  setChatbar();
  loadConversations().catch(e => addMeta(friendlyError(e.message)));
}

async function openConversation(c) {
  if (busy) return;
  closeChats();
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
  $("btnNew").disabled = $("btnDelete").disabled = $("btnLogout").disabled = on;
  $("btnAttach").disabled = on || uploading;
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
  if (uploading) return;
  if (busy) { stopGeneration(); return; }
  const text = $("input").value.trim();
  if (!text && !attachment) return;
  $("welcome")?.remove();
  setBusy(true);
  $("input").value = "";
  const file = attachment;
  clearAttachment();
  const userBubble = addMsg("user", text || "📎 " + file.filename);
  let accepted = false;
  showThinking();
  try {
    const body = { text, channel: "web", attachments: file ? [file] : [] };
    if (currentConv) body.conversation_id = currentConv.id;
    const res = await api("/v1/messages", { method: "POST", body });
    accepted = true;
    if (res.conversation_id && (!currentConv || currentConv.id !== res.conversation_id)) {
      currentConv = { id: res.conversation_id, title: (text || file?.filename || "Документ").slice(0, 80) };
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
    if (!accepted) {
      userBubble.remove();
      if (!$("input").value) $("input").value = text;
      if (file) showAttachment(file);
    }
    addMeta(m.includes("rate_limited") ? "Слишком много запросов — подождите минуту" : "Ошибка: " + friendlyError(m));
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

async function loadPrivacySettings() {
  const msg = $("privacyMessage");
  try {
    const [collections, history, integrations] = await Promise.all([
      api("/v1/privacy/collections"),
      api("/v1/privacy/conversation"),
      api("/v1/privacy/integrations"),
    ]);
    $("privacyHistory").checked = history.allow_cloud_history;
    $("privacySTT").checked = integrations.allow_remote_stt;
    $("privacyMCP").checked = integrations.allow_mcp_access;
    const host = $("privacyCollections");
    host.replaceChildren();
    const controls = [
      ["allow_cloud_llm", "Чтение знаний облачной LLM"],
      ["allow_remote_embeddings", "Внешние эмбеддинги"],
      ["allow_remote_extraction", "Внешний разбор файлов и изображений, поиск"],
      ["allow_messenger_reminders", "Напоминания в мессенджерах"],
    ];
    const categories = [
      ["unclassified", "Не определено"],
      ["standard", "Обычные данные"],
      ["sensitive", "Чувствительные"],
      ["secret", "Секретные"],
    ];
    for (const item of collections) {
      const section = document.createElement("section");
      section.className = "sec";
      const title = document.createElement("h4");
      title.textContent = item.slug;
      section.append(title);
      const select = document.createElement("select");
      select.setAttribute("aria-label", "Категория " + item.slug);
      for (const [key, label] of categories) {
        const opt = document.createElement("option");
        opt.value = key; opt.textContent = label;
        select.append(opt);
      }
      select.value = item.sensitivity;
      section.append(select);
      const switches = {};
      for (const [key, label] of controls) {
        const row = document.createElement("label");
        row.className = "privacy-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox"; checkbox.checked = Boolean(item[key]);
        checkbox.setAttribute("aria-label", item.slug + ": " + label);
        switches[key] = checkbox;
        row.append(checkbox, document.createTextNode(" " + label));
        section.append(row);
      }
      const applyClassification = () => {
        const locked = ["unclassified", "secret"].includes(select.value);
        for (const input of Object.values(switches)) {
          input.disabled = locked;
          if (locked) input.checked = false;
        }
      };
      select.addEventListener("change", applyClassification);
      applyClassification();
      const save = document.createElement("button");
      save.type = "button"; save.textContent = "Сохранить разрешения " + item.slug;
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await api("/v1/privacy/collections/" + encodeURIComponent(item.slug), {
            method: "PUT",
            body: {
              sensitivity: select.value,
              ...Object.fromEntries(controls.map(([key]) => [key, switches[key].checked])),
            },
          });
          msg.className = "ok"; msg.textContent = "Разрешения " + item.slug + " сохранены.";
        } catch (err) { msg.className = "err"; msg.textContent = friendlyError(err.message); }
        finally { save.disabled = false; }
      });
      section.append(save);
      host.append(section);
    }
    msg.textContent = "";
  } catch (err) {
    msg.className = "err"; msg.textContent = friendlyError(err.message);
  }
}
async function saveGlobalPrivacySettings() {
  const button = $("btnSavePrivacyGlobal");
  button.disabled = true;
  try {
    await api("/v1/privacy/conversation", {
      method: "PUT", body: { allow_cloud_history: $("privacyHistory").checked },
    });
    await api("/v1/privacy/integrations", {
      method: "PUT", body: {
        allow_remote_stt: $("privacySTT").checked,
        allow_mcp_access: $("privacyMCP").checked,
      },
    });
    $("privacyMessage").className = "ok"; $("privacyMessage").textContent = "Общие разрешения сохранены.";
  } catch (err) {
    $("privacyMessage").className = "err"; $("privacyMessage").textContent = friendlyError(err.message);
  } finally { button.disabled = false; }
}

async function loadSettings() {
  try {
    const s = await api("/v1/settings/llm");
    $("sVision").checked = s.supports_vision;
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
  if (busy || uploading) { $("setMsg").textContent = "Дождитесь завершения отправки или остановите генерацию перед выходом."; return; }
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
    supports_vision: $("sVision").checked,
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

function clearAttachment() {
  attachment = null; $("fileInput").value = ""; $("attachmentBar").classList.add("hidden");
}
function showAttachment(file) {
  attachment = file; $("attachmentName").textContent = file.filename; $("attachmentBar").classList.remove("hidden");
}
$("btnAttach").onclick = () => $("fileInput").click();
$("btnRemoveFile").onclick = clearAttachment;
$("fileInput").onchange = async () => {
  const file = $("fileInput").files[0]; if (!file || busy || uploading) return;
  uploading = true; $("btnAttach").disabled = $("btnSend").disabled = $("btnLogout").disabled = true;
  try {
    const form = new FormData(); form.append("file", file);
    const result = await api("/v1/blobs", { method: "POST", body: form });
    showAttachment({ storage_key: result.storage_key, mime: result.mime, filename: file.name });
  } catch(e) { addMeta(friendlyError(e.message)); }
  finally { uploading = false; $("btnAttach").disabled = $("btnSend").disabled = $("btnLogout").disabled = false; $("fileInput").value = ""; }
};

// ---------- wiring ----------
$("btnChangePassword").onclick = async () => {
  const button = $("btnChangePassword"); if (button.disabled) return;
  if (!$("currentPass").value || $("newPass").value.length < 8) { $("setMsg").textContent = "Введите текущий пароль и новый пароль (от 8 символов)."; return; }
  button.disabled = true;
  try {
    const result = await api("/v1/auth/password", {method:"POST",body:{current_password:$("currentPass").value,new_password:$("newPass").value,otp:$("passwordOtp").value || undefined}});
    token = result.access_token; localStorage.setItem("pia_token",token);
    if (result.refresh_token) localStorage.setItem("pia_refresh",result.refresh_token); else localStorage.removeItem("pia_refresh");
    $("currentPass").value = $("newPass").value = $("passwordOtp").value = "";
    $("setMsg").className = "ok"; $("setMsg").textContent = "Пароль изменён. Остальные устройства вышли из аккаунта.";
  } catch(e) { $("setMsg").className="err"; $("setMsg").textContent=friendlyError(e.message); }
  finally { button.disabled=false; }
};
$("btnLogin").onclick = () => loginOrRegister(false);
$("btnRegister").onclick = () => loginOrRegister(true);
$("btnSend").onclick = send;
$("btnNew").onclick = newChat;
$("btnDelete").onclick = deleteCurrent;
$("btnLogout").onclick = logout;
$("btnSettings").onclick = () => { $("settingsView").classList.remove("hidden"); $("setMsg").className = ""; $("btnCloseSettings").focus(); loadSettings(); loadSecurity(); loadPrivacySettings(); };
$("btn2faSetup").onclick = twofaSetup;
$("btn2faEnable").onclick = twofaEnable;
$("btn2faDisable").onclick = twofaDisable;
$("btnLogoutAll").onclick = logoutAll;
$("btnLinkCode").onclick = linkCode;
$("btnCloseSettings").onclick = () => { $("settingsView").classList.add("hidden"); for (const id of ["sKey","currentPass","newPass","passwordOtp","offPass","offCode","twofaCode","dataPass","dataOtp","deleteEmail"]) $(id).value = ""; $("btnSettings").focus(); };
$("btnSaveSettings").onclick = saveSettings;
$("btnSavePrivacyGlobal").onclick = saveGlobalPrivacySettings;
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

$("btnChats").onclick = () => { const open = document.body.classList.toggle("chats-open"); $("btnChats").setAttribute("aria-expanded", String(open)); };
$("btnPassword").onclick = () => {
  const visible = $("password").type === "password";
  $("password").type = visible ? "text" : "password";
  $("btnPassword").textContent = visible ? "Скрыть пароль" : "Показать пароль";
  $("btnPassword").setAttribute("aria-pressed", String(visible));
};
for (const id of ["email", "password", "otp"]) $(id).addEventListener("keydown", e => { if (e.key === "Enter") loginOrRegister(false); });
let installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; $("btnInstall").classList.remove("hidden"); });
$("btnInstall").onclick = async () => { if (installPrompt) { await installPrompt.prompt(); installPrompt = null; $("btnInstall").classList.add("hidden"); } };
window.addEventListener("appinstalled", () => { installPrompt = null; $("btnInstall").classList.add("hidden"); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
if (token) { $("authView").classList.add("hidden"); boot().catch(e => addMeta(friendlyError(e.message))); }

document.querySelector("main").inert = document.querySelector("header").inert = !token;
document.addEventListener("keydown", e => {
  const overlay = !$("authView").classList.contains("hidden") ? $("authView") : !$("settingsView").classList.contains("hidden") ? $("settingsView") : null;
  if (!overlay) return;
  if (e.key === "Escape" && overlay.id === "settingsView") { $("btnCloseSettings").click(); return; }
  if (e.key !== "Tab") return;
  const controls = Array.from(overlay.querySelectorAll('button, input, select, a[href]')).filter(element => !element.disabled && !element.classList.contains('hidden') && !element.closest('.hidden'));
  const first = controls[0], last = controls[controls.length - 1];
  if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
});


function downloadFile(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const link = document.createElement("a"); link.href=url; link.download=filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function accountAction(path, body, isExport) {
  const request = () => fetch(path, {method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(body)});
  let response = await request();
  if (response.status === 401 && await tryRefresh()) response = await request();
  if (!response.ok) { const error=await response.json().catch(()=>({})); throw new Error(error.detail || "HTTP "+response.status); }
  if (isExport) downloadFile(await response.blob(), "pia-account.zip", "application/zip");
  return response;
}
let dataBusy=false;
async function handleDataAction(remove) {
  if (dataBusy || busy || uploading) return;
  if (!$("dataPass").value) { $("setMsg").textContent="Укажите пароль для подтверждения."; return; }
  if (remove && !confirm("Удалить аккаунт, историю, знания и файлы без возможности восстановления?")) return;
  dataBusy=true; $("btnExport").disabled=$("btnDeleteAccount").disabled=true;
  try {
    await accountAction(remove ? "/v1/account/delete" : "/v1/account/export", {password:$("dataPass").value,otp:$("dataOtp").value || undefined,...(remove?{confirmation:$("deleteEmail").value.trim()}: {})}, !remove);
    $("dataPass").value=$("dataOtp").value="";
    if(remove) logout(); else { $("setMsg").className="ok";$("setMsg").textContent="Архив скачан. Храните его в безопасном месте."; }
  } catch(e) {$("setMsg").className="err";$("setMsg").textContent=friendlyError(e.message);}
  finally {dataBusy=false;$("btnExport").disabled=$("btnDeleteAccount").disabled=false;}
}
$("btnExport").onclick=()=>handleDataAction(false);
$("btnDeleteAccount").onclick=()=>handleDataAction(true);
$("btnDiagnostics").onclick=async()=>{try{const data=await api("/v1/service/diagnostics");downloadFile(JSON.stringify(data,null,2),"pia-diagnostics.json","application/json");}catch(e){$("setMsg").textContent=friendlyError(e.message);}};
$("btnTestModel").onclick=async()=>{
  const button=$("btnTestModel");if(button.disabled)return;button.disabled=true;
  $("setMsg").textContent="Проверяем сохранённые настройки модели…";
  try{const result=await api("/v1/settings/llm/test",{method:"POST"});$("setMsg").className="ok";$("setMsg").textContent=result.message;}
  catch(e){$("setMsg").className="err";$("setMsg").textContent=friendlyError(e.message);}
  finally{button.disabled=false;}
};
api("/v1/service/info").then(info=>{$("serviceInfo").textContent="Версия "+info.version+(info.support_email?" · Поддержка: "+info.support_email:"");}).catch(()=>{});
