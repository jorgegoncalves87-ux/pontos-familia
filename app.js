import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, onSnapshot,
  query, orderBy, limit, runTransaction, serverTimestamp, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------- Firebase ----------
// ?emulator abre a app contra os emuladores locais (apenas para testes).
const useEmulator = new URLSearchParams(location.search).has("emulator");
const config = useEmulator ? { apiKey: "demo", projectId: "demo-pontos", authDomain: "localhost" } : firebaseConfig;
const configured = useEmulator || !String(firebaseConfig.apiKey).startsWith("COLOCA");

let auth, db;
if (configured) {
  const fbApp = initializeApp(config);
  auth = getAuth(fbApp);
  db = getFirestore(fbApp);
  if (useEmulator) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
}

// ---------- Estado ----------
const S = {
  user: null,
  fam: undefined, // undefined = a carregar, null = família por configurar
  kids: [], tasks: [], rewards: [], log: [],
  kidsLoaded: false,
  role: null, // "parent" | id do filho
  tab: null,
  unsub: [],
};

const DAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const EMOJIS = ["🦁", "🐯", "🐼", "🦊", "🐸", "🐵", "🦄", "🐙", "🐧", "🐶", "🐱", "🚀", "⚽", "🎨", "🌟"];
const LOG_LIMIT = 500;

const famDoc = () => doc(db, "families", S.user.uid);
const col = (name) => collection(db, "families", S.user.uid, name);
const app = document.getElementById("app");

// ---------- Utilitários ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dateStr();
const fmtDate = (s) => { const [y, m, d] = s.split("-"); return `${d}/${m}`; };
const ptsHtml = (n) => `<span class="pts ${n >= 0 ? "plus" : "minus"}">${n > 0 ? "+" : ""}${n}</span>`;
const kidById = (id) => S.kids.find((k) => k.id === id);
const kidName = (id) => { const k = kidById(id); return k ? `${k.emoji} ${k.name}` : "?"; };
const STATUS_LABEL = { pending: "Por validar", approved: "Aprovado", rejected: "Rejeitado" };
const statusPill = (s) => `<span class="pill ${s}">${STATUS_LABEL[s]}</span>`;

async function hashPin(pin) {
  const data = new TextEncoder().encode(`${S.user.uid}:${pin}`);
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const validPin = (p) => /^\d{4,6}$/.test(p);

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

async function guard(fn) {
  try { await fn(); } catch (e) { console.error(e); toast(e.message || "Ocorreu um erro."); }
}

// ---------- Modal ----------
const modal = document.getElementById("modal");
function closeModal() { modal.classList.add("hidden"); modal.innerHTML = ""; }
/** Abre um formulário; onSubmit recebe os valores e pode lançar erro para mostrar na própria janela. */
function openForm(title, bodyHtml, onSubmit, submitLabel = "Guardar") {
  modal.innerHTML = `<form class="sheet"><h2 style="margin-top:0">${esc(title)}</h2>${bodyHtml}
    <div class="err"></div>
    <div class="actions"><button type="button" data-close>Cancelar</button><button class="primary" type="submit">${esc(submitLabel)}</button></div></form>`;
  modal.classList.remove("hidden");
  const form = modal.querySelector("form");
  form.querySelector("[data-close]").onclick = closeModal;
  const first = form.querySelector("input:not([type=checkbox]):not([type=radio]), select, textarea");
  if (first) setTimeout(() => first.focus(), 50);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      await onSubmit(new FormData(form), form);
      closeModal();
    } catch (e) {
      console.error(e);
      form.querySelector(".err").textContent = e.message || "Ocorreu um erro.";
      btn.disabled = false;
    }
  };
  return form;
}
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

function askPin(title, check) {
  openForm(title, `<input name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="PIN" style="font-size:1.6rem;text-align:center;letter-spacing:.4em">`,
    async (fd) => { await check(fd.get("pin")); }, "Entrar");
}

// ---------- Ciclo de vida ----------
function stopListeners() { S.unsub.forEach((u) => u()); S.unsub = []; }

function startListeners() {
  stopListeners();
  const onErr = (e) => { console.error(e); toast("Erro a ler dados: " + e.code); };
  S.unsub.push(onSnapshot(famDoc(), (snap) => { S.fam = snap.exists() ? snap.data() : null; render(); }, onErr));
  S.unsub.push(onSnapshot(col("kids"), (snap) => {
    S.kidsLoaded = true;
    S.kids = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
    render();
  }, onErr));
  S.unsub.push(onSnapshot(col("tasks"), (snap) => {
    S.tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.title.localeCompare(b.title));
    render();
  }, onErr));
  S.unsub.push(onSnapshot(col("rewards"), (snap) => {
    S.rewards = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0));
    render();
  }, onErr));
  S.unsub.push(onSnapshot(query(col("log"), orderBy("createdAt", "desc"), limit(LOG_LIMIT)), (snap) => {
    S.log = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, onErr));
}

const roleKey = () => `pf-role-${S.user.uid}`;
function setRole(role) {
  S.role = role;
  S.tab = null;
  // Só o perfil de filho fica lembrado no aparelho; o modo pai exige sempre o PIN.
  try { role && role !== "parent" ? localStorage.setItem(roleKey(), role) : localStorage.removeItem(roleKey()); } catch {}
  render();
}

if (configured) {
  onAuthStateChanged(auth, (user) => {
    S.user = user;
    S.fam = undefined;
    S.kids = []; S.tasks = []; S.rewards = []; S.log = [];
    S.kidsLoaded = false;
    S.role = null;
    if (user) {
      try { S.role = localStorage.getItem(roleKey()); } catch {}
      startListeners();
    } else {
      stopListeners();
    }
    render();
  });
} else {
  renderNotConfigured();
}

// ---------- Render principal ----------
function render() {
  if (!configured) return renderNotConfigured();
  if (!S.user) return renderLogin();
  if (S.fam === undefined) { app.innerHTML = `<div class="center muted">A carregar…</div>`; return; }
  if (S.fam === null) return renderSetup();
  if (S.role && S.role !== "parent" && !kidById(S.role)) {
    // O perfil guardado já não existe (ou os filhos ainda estão a carregar).
    if (S.kidsLoaded) setRole(null);
    else { app.innerHTML = `<div class="center muted">A carregar…</div>`; }
    return;
  }
  if (!S.role) return renderProfiles();
  if (S.role === "parent") return renderParent();
  return renderKid(kidById(S.role));
}

function renderNotConfigured() {
  app.innerHTML = `<div class="card"><h1>⭐ Pontos da Família</h1>
    <p>Falta ligar a app ao Firebase. Edita o ficheiro <b>firebase-config.js</b> com a configuração do teu projeto — os passos estão no README.</p></div>`;
}

function renderLogin() {
  app.innerHTML = `<div style="max-width:420px;margin:40px auto 0">
    <h1 style="text-align:center">⭐ Pontos da Família</h1>
    <p class="muted" style="text-align:center">Entra com a conta da família. Só é preciso fazer isto uma vez em cada aparelho.</p>
    <form class="card" id="loginForm">
      <label>Email</label><input name="email" type="email" autocomplete="username" required>
      <label>Password</label><input name="password" type="password" autocomplete="current-password" required minlength="6">
      <div class="err" id="loginErr"></div>
      <button class="primary block" type="submit" data-mode="login">Entrar</button>
      <button class="block" type="submit" data-mode="register" style="margin-top:8px">Criar conta da família</button>
      <button class="link" type="button" id="forgot" style="margin-top:8px">Esqueci-me da password</button>
    </form></div>`;
  const form = document.getElementById("loginForm");
  const err = document.getElementById("loginErr");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const mode = ev.submitter?.dataset.mode || "login";
    const email = form.email.value.trim(), pw = form.password.value;
    err.textContent = "";
    try {
      if (mode === "register") await createUserWithEmailAndPassword(auth, email, pw);
      else await signInWithEmailAndPassword(auth, email, pw);
    } catch (e) {
      err.textContent = authError(e.code);
    }
  };
  document.getElementById("forgot").onclick = async () => {
    const email = form.email.value.trim();
    if (!email) { err.textContent = "Escreve primeiro o email."; return; }
    try { await sendPasswordResetEmail(auth, email); toast("Enviámos um email para recuperares a password."); }
    catch (e) { err.textContent = authError(e.code); }
  };
}

function authError(code) {
  return ({
    "auth/invalid-credential": "Email ou password errados.",
    "auth/wrong-password": "Email ou password errados.",
    "auth/user-not-found": "Email ou password errados.",
    "auth/email-already-in-use": "Já existe uma conta com este email. Usa \"Entrar\".",
    "auth/weak-password": "A password tem de ter pelo menos 6 caracteres.",
    "auth/invalid-email": "Email inválido.",
    "auth/too-many-requests": "Demasiadas tentativas. Tenta daqui a pouco.",
    "auth/operation-not-allowed": "Ativa o login por Email/Password na consola do Firebase.",
  })[code] || `Erro: ${code}`;
}

function renderSetup() {
  app.innerHTML = `<div style="max-width:480px;margin:20px auto 0">
    <h1>Configurar a família</h1>
    <p class="muted">O PIN do pai/mãe protege a área de gestão. Os filhos não o devem saber.</p>
    <form class="card" id="setupForm">
      <label>PIN do pai/mãe (4 a 6 dígitos)</label>
      <input name="pin" type="password" inputmode="numeric" maxlength="6" required>
      <label>Repetir PIN</label>
      <input name="pin2" type="password" inputmode="numeric" maxlength="6" required>
      <div class="err" id="setupErr"></div>
      <button class="primary block" type="submit">Continuar</button>
    </form>
    <button class="link" id="logout">Sair da conta</button></div>`;
  document.getElementById("logout").onclick = () => signOut(auth);
  const form = document.getElementById("setupForm");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const pin = form.pin.value, pin2 = form.pin2.value;
    const err = document.getElementById("setupErr");
    if (!validPin(pin)) { err.textContent = "O PIN tem de ter 4 a 6 dígitos."; return; }
    if (pin !== pin2) { err.textContent = "Os PINs não coincidem."; return; }
    await guard(async () => {
      await setDoc(famDoc(), { parentPinHash: await hashPin(pin), createdAt: serverTimestamp() });
      setRole("parent");
      S.tab = "kids";
      render();
      toast("Família criada! Agora adiciona os teus filhos.");
    });
  };
}

function renderProfiles() {
  app.innerHTML = `<div class="header"><h1>Quem és tu?</h1><button class="link" id="logout">Sair</button></div>
    <div class="profiles">
      ${S.kids.map((k) => `<button class="profile" data-kid="${k.id}"><span class="emoji">${esc(k.emoji)}</span>${esc(k.name)}</button>`).join("")}
      <button class="profile" data-parent><span class="emoji">🔐</span>Pai / Mãe</button>
    </div>
    ${S.kids.length ? "" : `<p class="muted" style="margin-top:16px">Ainda não há filhos. Entra como pai/mãe para os adicionar.</p>`}`;
  document.getElementById("logout").onclick = () => { if (confirm("Sair da conta da família neste aparelho?")) signOut(auth); };
  app.querySelector("[data-parent]").onclick = () => askPin("PIN do pai/mãe", async (pin) => {
    if ((await hashPin(pin)) !== S.fam.parentPinHash) throw new Error("PIN errado.");
    setRole("parent");
  });
  app.querySelectorAll("[data-kid]").forEach((b) => (b.onclick = () => {
    const kid = kidById(b.dataset.kid);
    askPin(`Olá ${kid.name}! Qual é o teu PIN?`, async (pin) => {
      if ((await hashPin(pin)) !== kid.pinHash) throw new Error("PIN errado.");
      setRole(kid.id);
    });
  }));
}

function renderTabs(tabs) {
  if (!S.tab || !tabs.some((t) => t.id === S.tab)) S.tab = tabs[0].id;
  return `<nav class="tabs">${tabs.map((t) =>
    `<button data-tab="${t.id}" class="${S.tab === t.id ? "active" : ""}"><span class="ic">${t.icon}</span><span>${t.label}${t.badge ? ` <span class="badge">${t.badge}</span>` : ""}</span></button>`).join("")}</nav>`;
}

function bindTabs() {
  app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));
}

// ---------- Regras de negócio ----------
function tasksFor(kidId, date) {
  const dow = new Date(date + "T12:00:00").getDay();
  return S.tasks.filter((t) => t.active !== false
    && (t.recurring ? (!t.days?.length || t.days.includes(dow)) : t.date === date)
    && (!t.kidIds?.length || t.kidIds.includes(kidId)));
}

/** Registo mais recente de uma tarefa para um filho num dia. */
const taskEntry = (kidId, taskId, date) =>
  S.log.find((e) => e.type === "task" && e.kidId === kidId && e.taskId === taskId && e.date === date);

const pendingRewardCost = (kidId) => S.log
  .filter((e) => e.type === "reward" && e.kidId === kidId && e.status === "pending")
  .reduce((s, e) => s + Math.abs(e.points), 0);

const available = (kid) => (kid.points || 0) - pendingRewardCost(kid.id);

/** Aprova um registo pendente e aplica os pontos ao saldo (que nunca desce abaixo de 0). */
async function approveEntry(entryId) {
  await runTransaction(db, async (tx) => {
    const eRef = doc(col("log"), entryId);
    const e = await tx.get(eRef);
    if (!e.exists() || e.data().status !== "pending") throw new Error("Este pedido já foi tratado.");
    const entry = e.data();
    const kRef = doc(col("kids"), entry.kidId);
    const k = await tx.get(kRef);
    if (!k.exists()) throw new Error("Este filho já não existe.");
    const cur = k.data().points || 0;
    if (entry.type === "reward" && cur < Math.abs(entry.points)) throw new Error("Saldo insuficiente para esta recompensa.");
    const next = Math.max(0, cur + entry.points);
    tx.update(kRef, { points: next });
    tx.update(eRef, { status: "approved", applied: next - cur, decidedAt: serverTimestamp() });
  });
}

async function rejectEntry(entryId) {
  await updateDoc(doc(col("log"), entryId), { status: "rejected", decidedAt: serverTimestamp() });
}

/** Bónus ou penalização dada pelo pai: entra logo como aprovada. */
async function adjustPoints(kidId, points, title) {
  await runTransaction(db, async (tx) => {
    const kRef = doc(col("kids"), kidId);
    const k = await tx.get(kRef);
    if (!k.exists()) throw new Error("Este filho já não existe.");
    const cur = k.data().points || 0;
    const next = Math.max(0, cur + points);
    tx.update(kRef, { points: next });
    tx.set(doc(col("log")), {
      kidId, type: points < 0 ? "penalty" : "bonus", title, points, applied: next - cur,
      date: today(), status: "approved", createdAt: serverTimestamp(), decidedAt: serverTimestamp(),
    });
  });
}

function historyItem(e, showKid) {
  const icon = { task: "✅", reward: "🎁", penalty: "⚠️", bonus: "🌟" }[e.type] || "•";
  const floorNote = e.status === "approved" && e.applied !== undefined && e.applied !== e.points
    ? `<div class="small muted">Aplicado: ${e.applied} (o saldo não desce abaixo de 0)</div>` : "";
  return `<div class="card row">
    <div style="font-size:1.4rem">${icon}</div>
    <div class="grow"><div><b>${esc(e.title)}</b></div>
      <div class="small muted">${fmtDate(e.date)}${showKid ? " · " + esc(kidName(e.kidId)) : ""}</div>${floorNote}</div>
    <div style="text-align:right">${ptsHtml(e.points)}<div>${statusPill(e.status)}</div></div></div>`;
}

// ---------- Vista do filho ----------
function renderKid(kid) {
  const tabs = [
    { id: "today", icon: "📋", label: "Hoje" },
    { id: "rewards", icon: "🎁", label: "Prémios" },
    { id: "history", icon: "📜", label: "Histórico" },
  ];
  const nav = renderTabs(tabs);
  let body = "";
  if (S.tab === "today") body = kidToday(kid);
  if (S.tab === "rewards") body = kidRewards(kid);
  if (S.tab === "history") {
    const items = S.log.filter((e) => e.kidId === kid.id);
    body = items.length ? items.map((e) => historyItem(e, false)).join("") : `<div class="empty">Ainda não há nada no histórico.</div>`;
  }
  const pending = S.log.filter((e) => e.kidId === kid.id && e.type === "task" && e.status === "pending")
    .reduce((s, e) => s + e.points, 0);
  app.innerHTML = `<div class="header"><h1>${esc(kid.emoji)} ${esc(kid.name)}</h1><button class="link" id="switch">Trocar</button></div>
    <div class="balance"><div class="big">⭐ ${kid.points || 0}</div><div>pontos${pending ? ` · +${pending} por validar` : ""}</div></div>
    ${body}${nav}`;
  document.getElementById("switch").onclick = () => setRole(null);
  bindTabs();
  bindKidActions(kid);
}

function kidToday(kid) {
  const date = today();
  const tasks = tasksFor(kid.id, date);
  if (!tasks.length) return `<div class="empty">Não há tarefas para hoje. 🎉</div>`;
  return `<p class="muted">Toca nas tarefas que fizeste hoje. O pai/mãe depois valida.</p>` + tasks.map((t) => {
    const e = taskEntry(kid.id, t.id, date);
    const st = e?.status || "";
    const mark = { pending: "⏳", approved: "✓", rejected: "✕" }[st] || "";
    return `<button class="task ${st}" data-task="${t.id}">
      <span class="check">${mark}</span>
      <span class="grow"><b>${esc(t.title)}</b>${st ? `<br><span class="small muted">${STATUS_LABEL[st]}${st === "pending" ? " · toca para desmarcar" : ""}</span>` : ""}</span>
      ${ptsHtml(t.points)}</button>`;
  }).join("");
}

function kidRewards(kid) {
  const active = S.rewards.filter((r) => r.status === "active");
  const mine = S.rewards.filter((r) => r.suggestedBy === kid.id && r.status !== "active");
  const requests = S.log.filter((e) => e.kidId === kid.id && e.type === "reward" && e.status === "pending");
  const avail = available(kid);
  return `${requests.length ? `<h2>Pedidos à espera</h2>${requests.map((e) => historyItem(e, false)).join("")}` : ""}
    <h2>Prémios</h2>
    ${active.length ? active.map((r) => {
      const can = avail >= r.cost;
      return `<div class="card row"><div class="grow"><b>${esc(r.title)}</b>
        <div class="small muted">${can ? "Já tens pontos suficientes!" : `Faltam ${r.cost - avail} pontos`}</div></div>
        <span class="pts">⭐ ${r.cost}</span>
        <button class="primary" data-claim="${r.id}" ${can ? "" : "disabled"}>Pedir</button></div>`;
    }).join("") : `<div class="empty">Ainda não há prémios. Sugere um!</div>`}
    <h2>Sugerir um prémio</h2>
    <form class="card row" id="suggestForm"><input name="title" placeholder="O que gostavas de ganhar?" required maxlength="80" class="grow">
      <button class="primary" type="submit">Sugerir</button></form>
    ${mine.length ? `<h2>As minhas sugestões</h2>${mine.map((r) => `<div class="card row"><div class="grow">${esc(r.title)}</div>
      <span class="pill ${r.status === "rejected" ? "rejected" : "pending"}">${r.status === "rejected" ? "Recusada" : "À espera do preço"}</span></div>`).join("")}` : ""}`;
}

function bindKidActions(kid) {
  app.querySelectorAll("[data-task]").forEach((b) => (b.onclick = () => guard(async () => {
    const t = S.tasks.find((x) => x.id === b.dataset.task);
    const date = today();
    const e = taskEntry(kid.id, t.id, date);
    if (!e) {
      await addDoc(col("log"), {
        kidId: kid.id, type: "task", taskId: t.id, title: t.title, points: t.points,
        date, status: "pending", createdAt: serverTimestamp(),
      });
      toast("Boa! Agora o pai/mãe tem de validar.");
    } else if (e.status === "pending") {
      await deleteDoc(doc(col("log"), e.id));
    } else {
      toast(e.status === "approved" ? "Esta já está aprovada. 👍" : "Esta foi rejeitada hoje.");
    }
  })));
  app.querySelectorAll("[data-claim]").forEach((b) => (b.onclick = () => guard(async () => {
    const r = S.rewards.find((x) => x.id === b.dataset.claim);
    if (available(kid) < r.cost) throw new Error("Ainda não tens pontos suficientes.");
    if (!confirm(`Pedir "${r.title}" por ${r.cost} pontos?`)) return;
    await addDoc(col("log"), {
      kidId: kid.id, type: "reward", rewardId: r.id, title: r.title, points: -r.cost,
      date: today(), status: "pending", createdAt: serverTimestamp(),
    });
    toast("Pedido enviado ao pai/mãe!");
  })));
  const sf = document.getElementById("suggestForm");
  if (sf) sf.onsubmit = (ev) => {
    ev.preventDefault();
    const title = sf.title.value.trim();
    if (!title) return;
    guard(async () => {
      await addDoc(col("rewards"), { title, status: "suggested", suggestedBy: kid.id, cost: null, createdAt: serverTimestamp() });
      toast("Sugestão enviada!");
    });
  };
}

// ---------- Vista do pai ----------
function renderParent() {
  const pending = S.log.filter((e) => e.status === "pending");
  const suggestions = S.rewards.filter((r) => r.status === "suggested");
  const tabs = [
    { id: "validate", icon: "✔️", label: "Validar", badge: pending.length + suggestions.length },
    { id: "kids", icon: "👧", label: "Filhos" },
    { id: "tasks", icon: "📋", label: "Tarefas" },
    { id: "rewards", icon: "🎁", label: "Prémios" },
    { id: "history", icon: "📜", label: "Histórico" },
  ];
  const nav = renderTabs(tabs);
  const views = { validate: parentValidate, kids: parentKids, tasks: parentTasks, rewards: parentRewards, history: parentHistory };
  app.innerHTML = `<div class="header"><h1>🔐 Pai / Mãe</h1>
    <div><button class="link" id="settings">⚙️</button><button class="link" id="switch">Trocar</button></div></div>
    ${views[S.tab]()}${nav}`;
  document.getElementById("switch").onclick = () => setRole(null);
  document.getElementById("settings").onclick = openSettings;
  bindTabs();
  bindParentActions();
}

function parentValidate() {
  const pending = S.log.filter((e) => e.status === "pending");
  const suggestions = S.rewards.filter((r) => r.status === "suggested");
  if (!pending.length && !suggestions.length) return `<div class="empty">Nada por validar. ✨</div>`;
  let html = "";
  for (const kid of S.kids) {
    const items = pending.filter((e) => e.kidId === kid.id).sort((a, b) => a.date.localeCompare(b.date));
    if (!items.length) continue;
    const taskCount = items.filter((e) => e.type === "task").length;
    html += `<div class="row spread"><h2>${esc(kid.emoji)} ${esc(kid.name)} <span class="muted small">· saldo ${kid.points || 0}</span></h2>
      ${taskCount > 1 ? `<button class="good" data-approve-all="${kid.id}">Aprovar tarefas (${taskCount})</button>` : ""}</div>`;
    html += items.map((e) => `<div class="card row wrap">
      <div style="font-size:1.3rem">${e.type === "reward" ? "🎁" : "✅"}</div>
      <div class="grow"><b>${esc(e.title)}</b><div class="small muted">${e.type === "reward" ? "Pedido de prémio" : "Tarefa"} · ${fmtDate(e.date)}</div></div>
      ${ptsHtml(e.points)}
      <button class="good" data-approve="${e.id}" aria-label="Aprovar">✓</button>
      <button class="bad" data-reject="${e.id}" aria-label="Rejeitar">✕</button></div>`).join("");
  }
  if (suggestions.length) {
    html += `<h2>Prémios sugeridos</h2>` + suggestions.map((r) => `<div class="card row wrap">
      <div class="grow"><b>${esc(r.title)}</b><div class="small muted">Sugerido por ${esc(kidName(r.suggestedBy))}</div></div>
      <button class="good" data-price="${r.id}">Dar preço</button>
      <button class="bad" data-decline="${r.id}">Recusar</button></div>`).join("");
  }
  return html;
}

function parentKids() {
  return (S.kids.length ? S.kids.map((k) => `<div class="card">
      <div class="row"><div style="font-size:2rem">${esc(k.emoji)}</div>
        <div class="grow"><h3>${esc(k.name)}</h3><div class="muted small">${pendingRewardCost(k.id) ? `${pendingRewardCost(k.id)} pts em pedidos de prémio` : ""}</div></div>
        <div class="pts" style="font-size:1.4rem">⭐ ${k.points || 0}</div></div>
      <div class="row wrap" style="margin-top:10px">
        <button class="bad" data-penalty="${k.id}">− Mau comportamento</button>
        <button class="good" data-bonus="${k.id}">+ Bónus</button>
        <button data-edit-kid="${k.id}">Editar</button></div></div>`).join("")
    : `<div class="empty">Ainda não adicionaste filhos.</div>`)
    + `<button class="primary block" id="addKid">+ Adicionar filho</button>`;
}

function parentTasks() {
  const active = S.tasks.filter((t) => t.active !== false);
  const desc = (t) => {
    const when = t.recurring ? (t.days?.length && t.days.length < 7 ? t.days.map((d) => DAYS[d]).join(", ") : "Todos os dias") : `Só em ${fmtDate(t.date)}`;
    const who = t.kidIds?.length ? t.kidIds.map(kidName).join(", ") : "Todos";
    return `${when} · ${who}`;
  };
  return `<button class="primary block" id="addTask" style="margin-bottom:12px">+ Nova tarefa</button>`
    + (active.length ? active.map((t) => `<div class="card row">
      <div class="grow"><b>${esc(t.title)}</b><div class="small muted">${esc(desc(t))}</div></div>
      ${ptsHtml(t.points)}<button data-edit-task="${t.id}">Editar</button></div>`).join("")
      : `<div class="empty">Cria a primeira tarefa — por exemplo "Fazer a cama", 5 pontos, todos os dias.</div>`);
}

function parentRewards() {
  const active = S.rewards.filter((r) => r.status === "active");
  return `<button class="primary block" id="addReward" style="margin-bottom:12px">+ Novo prémio</button>`
    + (active.length ? active.map((r) => `<div class="card row">
      <div class="grow"><b>${esc(r.title)}</b>${r.suggestedBy ? `<div class="small muted">Sugerido por ${esc(kidName(r.suggestedBy))}</div>` : ""}</div>
      <span class="pts">⭐ ${r.cost}</span><button data-edit-reward="${r.id}">Editar</button></div>`).join("")
      : `<div class="empty">Ainda não há prémios.</div>`);
}

function parentHistory() {
  const items = S.log.filter((e) => e.status !== "pending");
  return items.length ? items.slice(0, 200).map((e) => historyItem(e, true)).join("") : `<div class="empty">Ainda não há histórico.</div>`;
}

function bindParentActions() {
  const on = (sel, fn) => app.querySelectorAll(sel).forEach((b) => (b.onclick = () => fn(b)));
  on("[data-approve]", (b) => guard(() => approveEntry(b.dataset.approve)));
  on("[data-reject]", (b) => guard(() => rejectEntry(b.dataset.reject)));
  on("[data-approve-all]", (b) => guard(async () => {
    const ids = S.log.filter((e) => e.status === "pending" && e.type === "task" && e.kidId === b.dataset.approveAll).map((e) => e.id);
    for (const id of ids) await approveEntry(id);
    toast(`${ids.length} tarefas aprovadas.`);
  }));
  on("[data-price]", (b) => rewardForm(S.rewards.find((r) => r.id === b.dataset.price)));
  on("[data-decline]", (b) => guard(() => updateDoc(doc(col("rewards"), b.dataset.decline), { status: "rejected" })));
  on("[data-penalty]", (b) => pointsForm(b.dataset.penalty, -1));
  on("[data-bonus]", (b) => pointsForm(b.dataset.bonus, 1));
  on("[data-edit-kid]", (b) => kidForm(kidById(b.dataset.editKid)));
  on("[data-edit-task]", (b) => taskForm(S.tasks.find((t) => t.id === b.dataset.editTask)));
  on("[data-edit-reward]", (b) => rewardForm(S.rewards.find((r) => r.id === b.dataset.editReward)));
  on("#addKid", () => kidForm(null));
  on("#addTask", () => taskForm(null));
  on("#addReward", () => rewardForm(null));
}

function readPoints(v, { allowZero = false } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 10000) throw new Error("Os pontos têm de ser um número inteiro positivo.");
  return n;
}

function pointsForm(kidId, sign) {
  const kid = kidById(kidId);
  const title = sign < 0 ? `Mau comportamento — ${kid.name}` : `Bónus — ${kid.name}`;
  openForm(title, `<label>Motivo</label><input name="title" required maxlength="100" placeholder="${sign < 0 ? "Ex: Bateu no irmão" : "Ex: Ajudou sem ninguém pedir"}">
    <label>Pontos</label><input name="points" type="number" inputmode="numeric" min="1" required>
    ${sign < 0 ? `<p class="small muted">Saldo atual: ${kid.points || 0}. O saldo nunca desce abaixo de 0.</p>` : ""}`,
  async (fd) => {
    const pts = readPoints(fd.get("points"));
    await adjustPoints(kidId, sign * pts, fd.get("title").trim());
    toast(sign < 0 ? "Penalização registada." : "Bónus atribuído!");
  }, sign < 0 ? "Retirar pontos" : "Dar pontos");
}

function kidForm(kid) {
  const emoji = kid?.emoji || EMOJIS[S.kids.length % EMOJIS.length];
  const form = openForm(kid ? `Editar ${kid.name}` : "Novo filho", `
    <label>Nome</label><input name="name" required maxlength="30" value="${esc(kid?.name || "")}">
    <label>Avatar</label><select name="emoji">${EMOJIS.map((e) => `<option ${e === emoji ? "selected" : ""}>${e}</option>`).join("")}</select>
    <label>${kid ? "Novo PIN (deixa vazio para manter)" : "PIN (4 a 6 dígitos)"}</label>
    <input name="pin" type="password" inputmode="numeric" maxlength="6" ${kid ? "" : "required"} autocomplete="off">
    ${kid ? `<button type="button" class="bad" id="delKid" style="margin-top:16px">Remover ${esc(kid.name)}</button>` : ""}`,
  async (fd) => {
    const name = fd.get("name").trim(), pin = fd.get("pin");
    if (!name) throw new Error("Escreve o nome.");
    const data = { name, emoji: fd.get("emoji") };
    if (pin || !kid) {
      if (!validPin(pin)) throw new Error("O PIN tem de ter 4 a 6 dígitos.");
      data.pinHash = await hashPin(pin);
    }
    if (kid) await updateDoc(doc(col("kids"), kid.id), data);
    else await addDoc(col("kids"), { ...data, points: 0, order: S.kids.length, createdAt: serverTimestamp() });
  });
  const del = form.querySelector("#delKid");
  if (del) del.onclick = () => guard(async () => {
    if (!confirm(`Remover ${kid.name}? Perde os ${kid.points || 0} pontos. O histórico fica guardado.`)) return;
    await deleteDoc(doc(col("kids"), kid.id));
    closeModal();
  });
}

function taskForm(task) {
  const recurring = task ? !!task.recurring : true;
  const days = task?.days?.length ? task.days : [0, 1, 2, 3, 4, 5, 6];
  const form = openForm(task ? "Editar tarefa" : "Nova tarefa", `
    <label>Tarefa</label><input name="title" required maxlength="80" value="${esc(task?.title || "")}" placeholder="Ex: Fazer a cama">
    <label>Pontos</label><input name="points" type="number" inputmode="numeric" min="1" required value="${task?.points ?? ""}">
    <label>Quando</label>
    <label class="inline"><input type="radio" name="kind" value="rec" ${recurring ? "checked" : ""}> Repete</label>
    <label class="inline"><input type="radio" name="kind" value="once" ${recurring ? "" : "checked"}> Só um dia</label>
    <div id="recBox">${DAYS.map((d, i) => `<label class="inline"><input type="checkbox" name="days" value="${i}" ${days.includes(i) ? "checked" : ""}> ${d}</label>`).join("")}</div>
    <div id="onceBox"><input name="date" type="date" value="${task?.date || today()}"></div>
    <label>Para quem</label>
    ${S.kids.length ? S.kids.map((k) => `<label class="inline"><input type="checkbox" name="kids" value="${k.id}" ${!task?.kidIds?.length || task.kidIds.includes(k.id) ? "checked" : ""}> ${esc(k.emoji)} ${esc(k.name)}</label>`).join("") : `<p class="small muted">Todos os filhos.</p>`}
    ${task ? `<button type="button" class="bad" id="delTask" style="margin-top:16px">Apagar tarefa</button>` : ""}`,
  async (fd) => {
    const title = fd.get("title").trim();
    if (!title) throw new Error("Escreve o nome da tarefa.");
    const isRec = fd.get("kind") === "rec";
    const selDays = fd.getAll("days").map(Number);
    if (isRec && !selDays.length) throw new Error("Escolhe pelo menos um dia.");
    if (!isRec && !fd.get("date")) throw new Error("Escolhe o dia.");
    const selKids = fd.getAll("kids");
    if (S.kids.length && !selKids.length) throw new Error("Escolhe pelo menos um filho.");
    const data = {
      title, points: readPoints(fd.get("points")), recurring: isRec,
      days: isRec && selDays.length < 7 ? selDays : [],
      date: isRec ? null : fd.get("date"),
      // Lista vazia = todos os filhos (incluindo os que forem adicionados depois).
      kidIds: selKids.length === S.kids.length ? [] : selKids,
      active: true,
    };
    if (task) await updateDoc(doc(col("tasks"), task.id), data);
    else await addDoc(col("tasks"), { ...data, createdAt: serverTimestamp() });
  });
  const sync = () => {
    const rec = form.querySelector("[name=kind]:checked").value === "rec";
    form.querySelector("#recBox").classList.toggle("hidden", !rec);
    form.querySelector("#onceBox").classList.toggle("hidden", rec);
  };
  form.querySelectorAll("[name=kind]").forEach((r) => (r.onchange = sync));
  sync();
  const del = form.querySelector("#delTask");
  // Arquivar em vez de apagar mantém o histórico coerente.
  if (del) del.onclick = () => guard(async () => {
    if (!confirm("Apagar esta tarefa?")) return;
    await updateDoc(doc(col("tasks"), task.id), { active: false });
    closeModal();
  });
}

function rewardForm(reward) {
  const isSuggestion = reward?.status === "suggested";
  const form = openForm(isSuggestion ? "Dar preço à sugestão" : reward ? "Editar prémio" : "Novo prémio", `
    <label>Prémio</label><input name="title" required maxlength="80" value="${esc(reward?.title || "")}" placeholder="Ex: 30 min extra de consola">
    <label>Custa quantos pontos?</label><input name="cost" type="number" inputmode="numeric" min="1" required value="${reward?.cost ?? ""}">
    ${reward && !isSuggestion ? `<button type="button" class="bad" id="delReward" style="margin-top:16px">Apagar prémio</button>` : ""}`,
  async (fd) => {
    const title = fd.get("title").trim();
    if (!title) throw new Error("Escreve o nome do prémio.");
    const data = { title, cost: readPoints(fd.get("cost")), status: "active" };
    if (reward) await updateDoc(doc(col("rewards"), reward.id), data);
    else await addDoc(col("rewards"), { ...data, suggestedBy: null, createdAt: serverTimestamp() });
  }, isSuggestion ? "Aprovar" : "Guardar");
  const del = form.querySelector("#delReward");
  if (del) del.onclick = () => guard(async () => {
    if (!confirm("Apagar este prémio?")) return;
    await updateDoc(doc(col("rewards"), reward.id), { status: "archived" });
    closeModal();
  });
}

function openSettings() {
  const form = openForm("Definições", `
    <label>Mudar PIN do pai/mãe</label>
    <input name="pin" type="password" inputmode="numeric" maxlength="6" placeholder="Novo PIN (deixa vazio para manter)" autocomplete="off">
    <p class="small muted">Conta: ${esc(S.user.email)}</p>
    <button type="button" class="bad" id="logoutAll" style="margin-top:8px">Sair da conta neste aparelho</button>`,
  async (fd) => {
    const pin = fd.get("pin");
    if (!pin) return;
    if (!validPin(pin)) throw new Error("O PIN tem de ter 4 a 6 dígitos.");
    await updateDoc(famDoc(), { parentPinHash: await hashPin(pin) });
    toast("PIN alterado.");
  });
  form.querySelector("#logoutAll").onclick = () => { closeModal(); signOut(auth); };
}
