import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, signInAnonymously, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch,
  arrayUnion, arrayRemove,
  query, orderBy, limit, runTransaction, serverTimestamp, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported as messagingSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { firebaseConfig, vapidKey } from "./firebase-config.js";

// ---------- Firebase ----------
// ?emulator abre a app contra os emuladores locais (apenas para testes).
const useEmulator = new URLSearchParams(location.search).has("emulator");
const config = useEmulator ? { apiKey: "demo", projectId: "demo-pontos", authDomain: "localhost" } : firebaseConfig;
const configured = useEmulator || !String(firebaseConfig.apiKey).startsWith("COLOCA");

let auth, db, fbApp;
if (configured) {
  fbApp = initializeApp(config);
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
  familyId: null, // = uid da conta da família; nos aparelhos dos filhos vem do link de ligação
  linkError: null, // "invalid" | "revoked" quando o aparelho não está ligado
  joining: false,
  fam: undefined, // undefined = a carregar, null = família por configurar
  kids: [], tasks: [], rewards: [], log: [],
  kidsLoaded: false,
  role: null, // "parent" | id do filho
  tab: null,
  kidDate: null, // dia escolhido pelo filho para marcar tarefas
  unsub: [],
};

const DAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const EMOJIS = ["🦁", "🐯", "🐼", "🦊", "🐸", "🐵", "🦄", "🐙", "🐧", "🐶", "🐱", "🚀", "⚽", "🎨", "🌟"];
const LOG_LIMIT = 500;

const famDoc = () => doc(db, "families", S.familyId);
const col = (name) => collection(db, "families", S.familyId, name);
const FAMILY_KEY = "pf-family";
const isDevice = () => !!S.user?.isAnonymous; // aparelho ligado por link (sem email/password)

// Link de ligação: #join=<familyId>.<código>
let JOIN = (() => {
  const m = location.hash.match(/^#join=([A-Za-z0-9_-]+)\.([a-f0-9]{16,})$/);
  return m ? { familyId: m[1], token: m[2] } : null;
})();
const joinLink = (token) => `${location.origin}${location.pathname}#join=${S.familyId}.${token}`;
/** Esquece o link do endereço (para não voltar a ligar o aparelho sozinho). */
function forgetJoinLink() {
  JOIN = null;
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}
const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const app = document.getElementById("app");

// ---------- Utilitários ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dateStr();
const fmtDate = (s) => { const [y, m, d] = s.split("-"); return `${d}/${m}`; };
const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); return dateStr(new Date(y, m - 1, d + n)); };
const weekday = (s) => DAYS[new Date(s + "T12:00:00").getDay()];
/** "Hoje", "Ontem" ou "Qua 14/10". */
const dayLabel = (s) => (s === today() ? "Hoje" : s === addDays(today(), -1) ? "Ontem" : `${weekday(s)} ${fmtDate(s)}`);
const DEFAULT_BACK_DAYS = 3;
const MAX_BACK_DAYS = 14;
/** Quantos dias para trás os filhos podem marcar tarefas (definido pelo pai/mãe). */
const backDays = () => Math.min(MAX_BACK_DAYS, Math.max(0, S.fam?.maxBackDays ?? DEFAULT_BACK_DAYS));
const ptsHtml = (n) => `<span class="pts ${n >= 0 ? "plus" : "minus"}">${n > 0 ? "+" : ""}${n}</span>`;
const kidById = (id) => S.kids.find((k) => k.id === id);
const kidName = (id) => { const k = kidById(id); return k ? `${k.emoji} ${k.name}` : "?"; };
const PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
/** Foto do filho (se houver) ou o emoji. */
/** Foto do perfil Pai/Mãe (se houver) ou o cadeado. */
const parentAvatar = (cls = "") => avatar({ photo: S.fam?.parentPhoto, emoji: "🔐" }, cls);
const avatar = (k, cls = "") => (k.photo && PHOTO_RE.test(k.photo)
  ? `<img class="avatar ${cls}" src="${k.photo}" alt="">`
  : `<span class="avatar-emoji ${cls}">${esc(k.emoji)}</span>`);
const STATUS_LABEL = { pending: "Por validar", approved: "Aprovado", rejected: "Rejeitado" };
const statusPill = (s) => `<span class="pill ${s}">${STATUS_LABEL[s]}</span>`;

async function hashPin(pin) {
  const data = new TextEncoder().encode(`${S.familyId}:${pin}`);
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
// Fecha ao tocar fora da janela, mas só se o toque também começou fora. No telemóvel, o teclado
// a abrir desloca a janela e o "click" de um toque num campo pode cair no fundo escurecido.
let downOnBackdrop = false;
modal.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === modal; });
modal.addEventListener("click", (e) => {
  if (e.target === modal && downOnBackdrop && !modal.contains(document.activeElement)) closeModal();
  downOnBackdrop = false;
});

function askPin(title, check) {
  openForm(title, `<input name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="PIN" style="font-size:1.6rem;text-align:center;letter-spacing:.4em">`,
    async (fd) => { await check(fd.get("pin")); }, "Entrar");
}

// ---------- Ciclo de vida ----------
function stopListeners() { S.unsub.forEach((u) => u()); S.unsub = []; }

/** Ordena sempre por pontos (do menor para o maior) e, em empate, por nome. */
const byValue = (field) => (a, b) => (a[field] ?? 0) - (b[field] ?? 0) || a.title.localeCompare(b.title, "pt");

function startListeners() {
  stopListeners();
  const onErr = (e) => {
    console.error(e);
    if (e.code === "permission-denied" && isDevice()) return unlinkDevice("revoked");
    toast("Erro a ler dados: " + e.code);
  };
  S.unsub.push(onSnapshot(famDoc(), (snap) => { S.fam = snap.exists() ? snap.data() : null; render(); }, onErr));
  S.unsub.push(onSnapshot(col("kids"), (snap) => {
    S.kidsLoaded = true;
    S.kids = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
    render();
  }, onErr));
  S.unsub.push(onSnapshot(col("tasks"), (snap) => {
    S.tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byValue("points"));
    render();
  }, onErr));
  S.unsub.push(onSnapshot(col("rewards"), (snap) => {
    S.rewards = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byValue("cost"));
    render();
  }, onErr));
  S.unsub.push(onSnapshot(query(col("log"), orderBy("createdAt", "desc"), limit(LOG_LIMIT)), (snap) => {
    S.log = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, onErr));
}

function setRole(role) {
  S.role = role;
  S.tab = null;
  S.kidDate = null;
  render();
}

/** Liga este aparelho à família do link (conta anónima + registo em members/). */
async function joinFamily(user) {
  S.joining = true;
  render();
  try {
    await setDoc(doc(db, "families", JOIN.familyId, "members", user.uid),
      { token: JOIN.token, joinedAt: serverTimestamp(), device: navigator.userAgent.slice(0, 150) }, { merge: true });
    try { localStorage.setItem(FAMILY_KEY, JOIN.familyId); } catch {}
    S.linkError = null;
    return JOIN.familyId;
  } catch (e) {
    console.error(e);
    S.linkError = "invalid";
    return null;
  } finally {
    S.joining = false;
  }
}

/** Desliga este aparelho (conta anónima) da família. */
async function unlinkDevice(reason = null) {
  stopListeners();
  try { localStorage.removeItem(FAMILY_KEY); } catch {}
  S.familyId = null;
  S.linkError = reason;
  S.fam = undefined;
  render();
}

if (configured) {
  onAuthStateChanged(auth, async (user) => {
    stopListeners();
    S.user = user;
    S.fam = undefined;
    S.kids = []; S.tasks = []; S.rewards = []; S.log = [];
    S.kidsLoaded = false;
    S.role = null;
    S.familyId = null;
    if (!user) {
      // Abriu um link de ligação: entra sem email nem password.
      if (JOIN) { S.joining = true; render(); await signInAnonymously(auth).catch((e) => { S.joining = false; S.linkError = "invalid"; console.error(e); render(); }); return; }
      return render();
    }
    if (!user.isAnonymous) {
      S.familyId = user.uid;
    } else {
      let saved = null;
      try { saved = localStorage.getItem(FAMILY_KEY); } catch {}
      // O link fica no endereço de propósito (o iPhone guarda-o no ícone do ecrã principal).
      S.familyId = JOIN ? await joinFamily(user) : saved;
      if (!S.familyId) return render();
    }
    // Nenhum perfil fica lembrado: ao abrir a app, cada um entra com o seu PIN.
    startListeners();
    render();
  });
} else {
  renderNotConfigured();
}

// ---------- Notificações ----------
// Cada aparelho guarda o seu token em families/<id>/pushTokens/<id>, com quem quer avisos:
// { parent: true } e/ou { kids: [ids] }. O envio é feito pelo notificador (notifier/notify.mjs).
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushKey = (who) => `pf-push-${S.familyId}-${who}`;
const pushOn = (who) => {
  try { return typeof Notification !== "undefined" && Notification.permission === "granted" && !!localStorage.getItem(pushKey(who)); }
  catch { return false; }
};

async function sha256hex(text) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pushToken() {
  if (!vapidKey) throw new Error("As notificações ainda não estão configuradas (falta a chave Web Push).");
  if (!(await messagingSupported().catch(() => false)) || !("serviceWorker" in navigator)) {
    throw new Error(isIOS() && !isStandalone()
      ? "No iPhone, primeiro adiciona a app ao ecrã principal (Partilhar → Adicionar ao ecrã principal) e abre-a a partir do ícone."
      : "Este navegador não suporta notificações.");
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("As notificações foram bloqueadas. Ativa-as nas definições do telemóvel para esta app.");
  const reg = await navigator.serviceWorker.register("./sw.js");
  const token = await getToken(getMessaging(fbApp), { vapidKey, serviceWorkerRegistration: reg });
  if (!token) throw new Error("Não foi possível ativar as notificações.");
  return token;
}

/** Liga ou desliga os avisos deste aparelho para o pai/mãe ("parent") ou para um filho (id). */
async function togglePush(who) {
  if (pushOn(who)) {
    const id = localStorage.getItem(pushKey(who));
    await updateDoc(doc(col("pushTokens"), id), who === "parent" ? { parent: false } : { kids: arrayRemove(who) }).catch(() => {});
    try { localStorage.removeItem(pushKey(who)); } catch {}
    toast("Notificações desligadas neste aparelho.");
  } else {
    const token = await pushToken();
    const id = (await sha256hex(token)).slice(0, 40);
    await setDoc(doc(col("pushTokens"), id), {
      token, updatedAt: serverTimestamp(), device: navigator.userAgent.slice(0, 150),
      ...(who === "parent" ? { parent: true } : { kids: arrayUnion(who) }),
    }, { merge: true });
    try { localStorage.setItem(pushKey(who), id); } catch {}
    toast("Notificações ligadas! 🔔");
  }
  render();
}
const bellButton = (who) => `<button class="link" id="bell" title="Notificações">${pushOn(who) ? "🔔" : "🔕"}</button>`;

// ---------- Render principal ----------
function render() {
  if (!(S.user && S.familyId && S.fam && S.role && (S.role === "parent" || kidById(S.role)))) {
    app.classList.remove("shell");
    delete app.dataset.view;
  }
  if (!configured) return renderNotConfigured();
  if (S.joining) { app.innerHTML = `<div class="center muted">A ligar este aparelho…</div>`; return; }
  if (!S.user) return renderLogin();
  if (!S.familyId) return renderNotLinked();
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

function renderNotLinked() {
  const msg = S.linkError === "revoked"
    ? "Este aparelho foi desligado pelo pai/mãe."
    : S.linkError === "invalid" ? "Este link de ligação já não é válido." : "Este aparelho ainda não está ligado à família.";
  app.innerHTML = `<div class="card" style="max-width:420px;margin:40px auto 0;text-align:center">
    <h1>⭐ Pontos da Família</h1><p>${msg}</p>
    <p class="muted">Pede ao pai/mãe um link novo: na app, ⚙️ Definições → <b>Ligar aparelho de um filho</b>.</p>
    <button class="link" id="toLogin">Sou o pai/mãe: entrar com email</button></div>`;
  document.getElementById("toLogin").onclick = () => { forgetJoinLink(); signOut(auth); };
}

function renderNotConfigured() {
  app.innerHTML = `<div class="card"><h1>⭐ Pontos da Família</h1>
    <p>Falta ligar a app ao Firebase. Edita o ficheiro <b>firebase-config.js</b> com a configuração do teu projeto — os passos estão no README.</p></div>`;
}

function renderLogin() {
  app.innerHTML = `<div style="max-width:420px;margin:40px auto 0">
    <h1 style="text-align:center">⭐ Pontos da Família</h1>
    <p class="muted" style="text-align:center">Pai/mãe: entra com a conta da família.<br>Filhos: abram o link que o pai/mãe vos enviou — não precisam de email.</p>
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
  app.innerHTML = `<div class="header"><h1>Quem és tu?</h1><button class="link" id="logout">${isDevice() ? "Desligar" : "Sair"}</button></div>
    <div class="profiles">
      ${S.kids.map((k) => `<button class="profile" data-kid="${k.id}"><span class="emoji">${avatar(k, "lg")}</span>${esc(k.name)}</button>`).join("")}
      <button class="profile" data-parent><span class="emoji">${parentAvatar("lg")}</span>Pai / Mãe</button>
    </div>
    ${S.kids.length ? "" : `<p class="muted" style="margin-top:16px">Ainda não há filhos. Entra como pai/mãe para os adicionar.</p>`}`;
  document.getElementById("logout").onclick = () => leaveDevice();
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

/**
 * Ecrãs com barra de separadores: o conteúdo tem scroll próprio e a barra fica sempre em baixo
 * (no iPad, uma barra "position: fixed" podia ficar a meio do ecrã). Mantém o scroll entre renders.
 */
function renderShell(content, nav) {
  const prev = app.querySelector(".scroll");
  const top = prev && app.classList.contains("shell") && app.dataset.view === `${S.role}:${S.tab}` ? prev.scrollTop : 0;
  app.classList.add("shell");
  app.dataset.view = `${S.role}:${S.tab}`;
  app.innerHTML = `<div class="scroll"><div class="inner">${content}</div></div>${nav}`;
  app.querySelector(".scroll").scrollTop = top;
}
const scrollToTop = () => { const el = app.querySelector(".scroll"); if (el) el.scrollTop = 0; else window.scrollTo(0, 0); };

function bindTabs() {
  app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; render(); scrollToTop(); }));
}

// ---------- Regras de negócio ----------
/**
 * Tarefas de um filho. Há dois tipos e ambos aparecem todos os dias:
 * recorrentes (para fazer sempre) e espontâneas (pontos extra quando acontecem).
 * Tarefas antigas "só um dia" passam a contar como espontâneas.
 */
function tasksFor(kidId) {
  return S.tasks.filter((t) => t.active !== false && !isSpecial(t) && (!t.kidIds?.length || t.kidIds.includes(kidId)));
}
const isRecurring = (t) => !!t.recurring;

// ---------- Missões (tarefas com prazo) ----------
// O pai/mãe define "até dia X". O filho pode dizer que já fez; no fim do prazo o pai/mãe decide
// se ganhou os pontos. Os registos têm type "special" e taskId.
const isSpecial = (t) => !!t.special && !!t.deadline;
/** Fim do prazo: 23:59:59 do dia escolhido, na hora do aparelho. */
const deadlineMs = (t) => { const [y, m, d] = t.deadline.split("-").map(Number); return new Date(y, m - 1, d, 23, 59, 59).getTime(); };
const isOver = (t) => Date.now() > deadlineMs(t);
const kidsOf = (t) => (t.kidIds?.length ? S.kids.filter((k) => t.kidIds.includes(k.id)) : S.kids);
/** Registo mais recente de um filho numa missão (S.log vem do mais recente para o mais antigo). */
const specialEntry = (kidId, taskId) => S.log.find((e) => e.type === "special" && e.kidId === kidId && e.taskId === taskId);
const specialsFor = (kidId) => S.tasks.filter((t) => t.active !== false && isSpecial(t) && (!t.kidIds?.length || t.kidIds.includes(kidId)));
/** Missões já terminadas em que este filho ainda não tem decisão. */
const undecidedSpecials = () => S.tasks.filter((t) => t.active !== false && isSpecial(t) && isOver(t))
  .flatMap((t) => kidsOf(t).filter((k) => !specialEntry(k.id, t.id)).map((k) => ({ t, k })));

function countdownText(ms) {
  if (ms <= 0) return "Terminou";
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${d ? `${d}d ` : ""}${pad(h)}h ${pad(m)}m ${pad(sec)}s`;
}
// Os contadores descem sozinhos; quando um chega a zero, o ecrã é redesenhado.
setInterval(() => {
  let ended = false;
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    const left = Number(el.dataset.deadline) - Date.now();
    if (left <= 0 && el.textContent !== "Terminou") ended = true;
    el.textContent = countdownText(left);
  });
  if (ended) render();
}, 1000);

/** O pai/mãe decide uma missão terminada em que o filho não chegou a dizer que fez. */
async function decideSpecial(task, kidId, won) {
  await runTransaction(db, async (tx) => {
    const kRef = doc(col("kids"), kidId);
    const k = await tx.get(kRef);
    if (!k.exists()) throw new Error("Este filho já não existe.");
    const cur = k.data().points || 0;
    const next = won ? Math.max(0, cur + task.points) : cur;
    if (won) tx.update(kRef, { points: next });
    tx.set(doc(col("log")), {
      kidId, type: "special", taskId: task.id, title: task.title, points: task.points, applied: next - cur,
      date: today(), status: won ? "approved" : "rejected", createdAt: serverTimestamp(), decidedAt: serverTimestamp(),
    });
  });
}

// Ideias para começar (o pai/mãe escolhe quais quer adicionar).
const TASK_IDEAS = [
  ["Fazer a cama", 5], ["Arrumar o quarto", 10], ["Lavar os dentes (manhã e noite)", 5],
  ["Vestir-se sozinho(a)", 3], ["Preparar a mochila para o dia seguinte", 5], ["Fazer os trabalhos de casa", 10],
  ["Ler 20 minutos", 10], ["Pôr a mesa", 5], ["Levantar a mesa", 5], ["Pôr a roupa suja no cesto", 3],
  ["Arrumar os brinquedos", 5], ["Tomar banho sem reclamar", 5], ["Comer a fruta e os legumes", 5],
  ["Dar comida e água ao animal", 5], ["Ir para a cama à hora combinada", 5], ["Arrumar sapatos e casaco ao chegar", 3],
  ["Levar o lixo ou a reciclagem", 5], ["Praticar instrumento ou desporto (15 min)", 10],
  ["Ajudar a arrumar a loiça", 5], ["Cumprir o limite de tempo de ecrã", 10],
];
const REWARD_IDEAS = [
  ["Escolher a sobremesa do jantar", 30], ["15 minutos extra de ecrã", 30], ["Escolher o filme da noite em família", 50],
  ["Deitar 30 min mais tarde (fim de semana)", 60], ["Gelado ou doce ao fim de semana", 60], ["Escolher o jantar de um dia", 80],
  ["Vale \"hoje não faço uma tarefa\"", 80], ["Pequeno-almoço na cama", 100], ["Noite de jogos de tabuleiro (escolhe o jogo)", 100],
  ["1 hora extra de consola ao fim de semana", 120], ["Convidar um amigo para brincar cá em casa", 150],
  ["Ir ao parque ou à praia à escolha", 150], ["Um livro novo", 250], ["Acampar na sala / dormida com amigo", 300],
  ["Uma tarde a sós com o pai ou a mãe", 300], ["Ida ao cinema", 400], ["Escolher o programa do fim de semana", 400],
  ["Brinquedo ou jogo até 15 €", 600], ["Ida ao zoo, aquário ou parque de diversões", 1000], ["Prenda maior à escolha (até 40 €)", 1500],
];

/** Registo mais recente de uma tarefa para um filho num dia. */
const taskEntry = (kidId, taskId, date) =>
  S.log.find((e) => e.type === "task" && e.kidId === kidId && e.taskId === taskId && e.date === date);

const pendingRewardCost = (kidId) => S.log
  .filter((e) => e.type === "reward" && e.kidId === kidId && e.status === "pending")
  .reduce((s, e) => s + Math.abs(e.points), 0);

const available = (kid) => (kid.points || 0) - pendingRewardCost(kid.id);

/** Aprova um registo pendente e aplica os pontos ao saldo (que nunca desce abaixo de 0). */
async function approveEntry(entryId, pointsOverride = null) {
  await runTransaction(db, async (tx) => {
    const eRef = doc(col("log"), entryId);
    const e = await tx.get(eRef);
    if (!e.exists() || e.data().status !== "pending") throw new Error("Este pedido já foi tratado.");
    const entry = e.data();
    const kRef = doc(col("kids"), entry.kidId);
    const k = await tx.get(kRef);
    if (!k.exists()) throw new Error("Este filho já não existe.");
    const cur = k.data().points || 0;
    // Nos extras sugeridos pelos filhos, os pontos são os que o pai/mãe decide ao aprovar.
    if (entry.type === "extra" && pointsOverride == null) throw new Error("Usa \"Dar pontos\" para decidir quantos pontos vale.");
    const points = pointsOverride ?? entry.points;
    if (entry.type === "reward" && cur < Math.abs(points)) throw new Error("Saldo insuficiente para esta recompensa.");
    const next = Math.max(0, cur + points);
    tx.update(kRef, { points: next });
    tx.update(eRef, { status: "approved", points, applied: next - cur, decidedAt: serverTimestamp() });
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

// ---------- Gráfico semanal ----------
/** Pontos ganhos e perdidos por dia (só registos aprovados; os prémios trocados não contam). */
function dailyPoints(kidId, days) {
  const map = Object.fromEntries(days.map((d) => [d, { gain: 0, loss: 0 }]));
  for (const e of S.log) {
    if (e.kidId !== kidId || e.status !== "approved" || e.type === "reward" || !map[e.date]) continue;
    const v = e.applied ?? e.points;
    if (v >= 0) map[e.date].gain += v; else map[e.date].loss -= v;
  }
  return map;
}

/** Barra com a ponta arredondada (4px) e quadrada junto à linha do zero. */
function barPath(x, y, w, h, up) {
  if (h <= 0) return "";
  const r = Math.min(4, h, w / 2);
  return up
    ? `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
    : `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}

function weekChart(kid) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today(), i - 6));
  const prevDays = Array.from({ length: 7 }, (_, i) => addDays(today(), i - 13));
  const cur = dailyPoints(kid.id, days), prev = dailyPoints(kid.id, prevDays);
  const net = (m) => Object.values(m).reduce((s, v) => s + v.gain - v.loss, 0);
  const week = net(cur), last = net(prev), diff = week - last;
  const maxG = Math.max(10, ...days.map((d) => cur[d].gain));
  const maxL = Math.max(0, ...days.map((d) => cur[d].loss));
  const W = 308, top = 14, labelH = 20, plotH = maxL ? 120 : 96, H = top + plotH + labelH;
  const k = plotH / (maxG + maxL), zeroY = top + maxG * k;
  const slot = W / 7, bw = Math.min(24, slot * 0.55);
  const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);
  const cols = days.map((d, i) => {
    const { gain, loss } = cur[d];
    const x = i * slot + (slot - bw) / 2;
    const gh = gain * k, lh = loss * k;
    const label = d === today() ? "Hoje" : weekday(d);
    return `<g>
      <path class="bar-gain" d="${barPath(x, zeroY - gh - 1, bw, gh, true)}"/>
      <path class="bar-loss" d="${barPath(x, zeroY + 1, bw, lh, false)}"/>
      <text x="${i * slot + slot / 2}" y="${H - 5}" text-anchor="middle" class="axis${d === today() ? " now" : ""}">${label}</text>
      <rect class="hit" x="${i * slot}" y="0" width="${slot}" height="${H}" data-chart-day data-kid="${kid.id}"
        data-text="${esc(`${dayLabel(d)}: ${gain ? `+${gain} ganhos` : "nada ganho"}${loss ? ` · −${loss} perdidos` : ""}`)}"/>
    </g>`;
  }).join("");
  const summary = `Últimos 7 dias: ${fmt(week)} pontos. ${days.map((d) => `${dayLabel(d)} +${cur[d].gain}${cur[d].loss ? ` −${cur[d].loss}` : ""}`).join(", ")}.`;
  return `<div class="chart">
    <div class="row spread wrap">
      <div><b>Últimos 7 dias: ${fmt(week)}</b>
        <div class="small muted">${diff === 0 ? "Igual aos 7 dias anteriores" : `${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)} vs. 7 dias anteriores (${fmt(last)})`}</div></div>
      <div class="legend small"><span><i class="sw gain"></i>Ganhos</span><span><i class="sw loss"></i>Perdidos</span></div>
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(summary)}">
      <line class="grid" x1="0" x2="${W}" y1="${top}" y2="${top}"/>
      <text class="axis" x="0" y="${top - 4}">${maxG}</text>
      ${cols}
      <line class="base" x1="0" x2="${W}" y1="${zeroY}" y2="${zeroY}"/>
    </svg>
    <div class="small muted chart-cap" id="cap-${kid.id}">Toca numa barra para ver o dia.</div>
  </div>`;
}

/** Pontos líquidos (ganhos − perdidos) de um filho nos últimos 7 dias. */
function weekNet(kidId) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today(), i - 6));
  return Object.values(dailyPoints(kidId, days)).reduce((s, v) => s + v.gain - v.loss, 0);
}

/**
 * Comparação dos irmãos nos últimos 7 dias. Com `me`, diz a esse filho quantos pontos
 * está acima ou abaixo de cada irmão.
 */
function siblingsSummary(me = null) {
  if (S.kids.length < 2) return "";
  const rows = S.kids.map((k) => ({ k, net: weekNet(k.id) })).sort((a, b) => b.net - a.net || a.k.name.localeCompare(b.k.name, "pt"));
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  const fmt = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");
  const myNet = me ? weekNet(me.id) : 0;
  const compare = (r) => {
    if (!me || r.k.id === me.id) return "";
    const d = myNet - r.net;
    return `<div class="small muted">${d === 0 ? `Estás empatado com ${esc(r.k.name)}` : `Estás <b>${d > 0 ? "▲" : "▼"} ${Math.abs(d)} pontos ${d > 0 ? "acima" : "abaixo"}</b> d${/a$/i.test(r.k.name) ? "a" : "o"} ${esc(r.k.name)}`}</div>`;
  };
  return `<div class="card sibs">
    <div class="small muted" style="margin-bottom:8px">Pontos ganhos menos perdidos nos últimos 7 dias</div>
    ${rows.map((r) => `<div class="sib ${me && r.k.id === me.id ? "me" : ""}">
      <div class="row">${avatar(r.k, "sm")}
        <div class="grow"><b>${esc(r.k.name)}${me && r.k.id === me.id ? " (tu)" : ""}</b>${compare(r)}</div>
        <span class="pts">${fmt(r.net)}</span></div>
      <div class="sib-track"><i class="${r.net < 0 ? "neg" : ""}" style="width:${Math.round((Math.abs(r.net) / max) * 100)}%"></i></div>
    </div>`).join("")}
  </div>`;
}

function bindCharts() {
  app.querySelectorAll("[data-chart-day]").forEach((el) => {
    const show = () => {
      const cap = document.getElementById(`cap-${el.dataset.kid}`);
      if (cap) cap.textContent = el.dataset.text;
      el.closest("svg").querySelectorAll(".hit.on").forEach((h) => h.classList.remove("on"));
      el.classList.add("on");
    };
    el.addEventListener("click", show);
    el.addEventListener("mouseenter", show);
  });
}

const CORRECTABLE = ["task", "extra", "bonus", "penalty", "special"];

function historyItem(e, showKid, editable = false) {
  const icon = { task: "✅", reward: "🎁", penalty: "⚠️", bonus: "🌟", extra: "💡", special: "🚀" }[e.type] || "•";
  const floorNote = e.status === "approved" && e.applied !== undefined && e.applied !== e.points
    ? `<div class="small muted">Aplicado: ${e.applied} (o saldo não desce abaixo de 0)</div>` : "";
  // Um extra à espera ainda não tem pontos: mostra os que o filho pediu.
  const pts = e.type === "extra" && e.status === "pending"
    ? `<span class="pts">${e.suggested ? `pede ${e.suggested}` : "?"}</span>` : ptsHtml(e.points);
  const canFix = editable && ["approved", "rejected"].includes(e.status) && CORRECTABLE.includes(e.type);
  return `<div class="card row">
    <div style="font-size:1.4rem">${icon}</div>
    <div class="grow"><div><b>${esc(e.title)}</b></div>
      <div class="small muted">${fmtDate(e.date)}${showKid ? " · " + esc(kidName(e.kidId)) : ""}${e.corrected ? " · corrigido" : ""}</div>${floorNote}
      ${canFix ? `<button class="link" style="padding:4px 0" data-fix="${e.id}">Corrigir pontos</button>` : ""}</div>
    <div style="text-align:right">${pts}<div>${statusPill(e.status)}</div></div></div>`;
}

/**
 * Corrige os pontos de um registo aprovado ou rejeitado e acerta o saldo pela diferença
 * (o saldo continua a não descer abaixo de 0). Com pontos > 0 fica aprovado; com 0 fica
 * rejeitado. O filho é avisado da correção.
 */
async function correctEntry(entryId, newPoints) {
  await runTransaction(db, async (tx) => {
    const eRef = doc(col("log"), entryId);
    const e = await tx.get(eRef);
    if (!e.exists() || !["approved", "rejected"].includes(e.data().status)) throw new Error("Este registo já não pode ser corrigido.");
    const entry = e.data();
    const kRef = doc(col("kids"), entry.kidId);
    const k = await tx.get(kRef);
    if (!k.exists()) throw new Error("Este filho já não existe.");
    const cur = k.data().points || 0;
    // Um registo rejeitado não mexeu no saldo.
    const base = entry.status === "approved" ? cur - (entry.applied ?? entry.points) : cur;
    const next = Math.max(0, base + newPoints);
    tx.update(kRef, { points: next });
    tx.update(eRef, {
      status: newPoints === 0 ? "rejected" : "approved", points: newPoints, applied: next - base,
      corrected: true, decidedAt: serverTimestamp(), notifiedKid: false,
    });
  });
}

function fixForm(e) {
  const isPenalty = e.type === "penalty";
  const rejected = e.status === "rejected";
  // Para um rejeitado, sugere os pontos da tarefa (ou os pedidos, num extra).
  const task = S.tasks.find((t) => t.id === e.taskId);
  const value = rejected ? (e.type === "extra" ? e.suggested ?? "" : task?.points ?? Math.abs(e.points)) : Math.abs(e.points);
  openForm(`Corrigir "${e.title}"`, `<p class="small muted">${esc(kidName(e.kidId))} · ${fmtDate(e.date)} · ${rejected ? "estava rejeitado" : `agora: ${e.points} pontos`}.
      O saldo é acertado pela diferença. Com 0 fica rejeitado.</p>
    <label>${isPenalty ? "Pontos a retirar" : "Pontos certos"}</label>
    <input name="points" type="number" inputmode="numeric" min="0" required value="${value}">`,
  async (fd) => {
    const n = readPoints(fd.get("points"), { allowZero: true });
    await correctEntry(e.id, isPenalty ? -n : n);
    toast("Pontos corrigidos.");
  }, "Corrigir");
}

// ---------- Vista do filho ----------
function renderKid(kid) {
  const tabs = [
    { id: "today", icon: "📋", label: "Tarefas" },
    { id: "rewards", icon: "🎁", label: "Prémios" },
    { id: "history", icon: "📜", label: "Histórico" },
  ];
  const nav = renderTabs(tabs);
  let body = "";
  if (S.tab === "today") body = kidToday(kid);
  if (S.tab === "rewards") body = kidRewards(kid);
  if (S.tab === "history") {
    const items = S.log.filter((e) => e.kidId === kid.id);
    body = `${S.kids.length > 1 ? `<h2>Eu e ${S.kids.length > 2 ? "os meus irmãos" : "o meu irmão"}</h2>${siblingsSummary(kid)}` : ""}<h2>A minha semana</h2>${weekChart(kid)}<h2>Histórico</h2>`
      + (items.length ? items.map((e) => historyItem(e, false)).join("") : `<div class="empty">Ainda não há nada no histórico.</div>`);
  }
  const pending = S.log.filter((e) => e.kidId === kid.id && e.type === "task" && e.status === "pending")
    .reduce((s, e) => s + e.points, 0);
  renderShell(`<div class="header"><h1 class="row"><button class="avatar-btn" id="myPhoto" aria-label="Mudar a minha foto">${avatar(kid, "md")}<span class="cam">📷</span></button> ${esc(kid.name)}</h1><div>${bellButton(kid.id)}<button class="link" id="switch">Trocar</button></div></div>
    <div class="balance"><div class="big">⭐ ${kid.points || 0}</div><div>pontos${pending ? ` · +${pending} por validar` : ""}</div></div>
    ${body}`, nav);
  document.getElementById("switch").onclick = () => setRole(null);
  bindTabs();
  document.getElementById("bell").onclick = () => guard(() => togglePush(kid.id));
  document.getElementById("myPhoto").onclick = () => photoForm(`A foto de ${kid.name}`, kid.photo, (photo) => updateDoc(doc(col("kids"), kid.id), { photo }));
  bindKidActions(kid);
  bindCharts();
}

/** Dias que o filho pode marcar, do mais recente para o mais antigo. */
const markableDays = () => Array.from({ length: backDays() + 1 }, (_, i) => addDays(today(), -i));

/** Tarefas do dia ainda por marcar. */
/** Tarefas recorrentes do dia ainda por marcar. */
const unmarkedCount = (kidId, date) => tasksFor(kidId).filter((t) => isRecurring(t) && !taskEntry(kidId, t.id, date)).length;

function specialsBox(kid) {
  const now = Date.now();
  const list = specialsFor(kid.id).filter((t) => {
    const e = specialEntry(kid.id, t.id);
    // Depois de decidida, continua à vista mais 3 dias para o filho ver o resultado.
    return !isOver(t) || !e || e.status === "pending" || now < deadlineMs(t) + 3 * 86400000;
  }).sort((a, b) => deadlineMs(a) - deadlineMs(b));
  if (!list.length) return "";
  return `<h2>🚀 Missões</h2>` + list.map((t) => {
    const e = specialEntry(kid.id, t.id), over = isOver(t);
    let status;
    if (e?.status === "approved") status = `<div class="sp-result win">🎉 Ganhaste ${ptsHtml(e.applied ?? e.points)} pontos!</div>`;
    else if (e?.status === "rejected") status = `<div class="sp-result">😕 Desta vez não ganhaste.</div>`;
    else if (e?.status === "pending") status = `<div class="row spread"><span class="pill pending">⏳ À espera do pai/mãe</span>${over ? "" : `<button class="link" data-special-undo="${e.id}">Cancelar</button>`}</div>`;
    else if (over) status = `<div class="sp-result">⌛ Terminou — o pai/mãe vai decidir.</div>`;
    else status = `<button class="primary block" data-special-done="${t.id}">✋ Já fiz!</button>`;
    return `<div class="special ${over ? "over" : ""}">
      <div class="row spread"><b class="sp-title">${esc(t.title)}</b><span class="sp-pts">+${t.points}</span></div>
      <div class="small" style="font-weight:600">Até ${weekday(t.deadline)} ${fmtDate(t.deadline)}</div>
      ${over || ["approved", "rejected"].includes(e?.status) ? "" : `<div class="sp-count" data-deadline="${deadlineMs(t)}">${countdownText(deadlineMs(t) - now)}</div>`}
      ${status}
    </div>`;
  }).join("");
}

function kidToday(kid) {
  const special = specialsBox(kid);
  const days = markableDays();
  // Volta a hoje se o dia escolhido saiu da janela (mudou o dia ou o pai/mãe reduziu o limite).
  if (!days.includes(S.kidDate)) S.kidDate = today();
  const date = S.kidDate;
  const strip = days.length > 1 ? `<div class="days">${days.map((d) => {
    const left = unmarkedCount(kid.id, d);
    return `<button class="day ${d === date ? "active" : ""}" data-day="${d}">${dayLabel(d)}${left ? ` <span class="dot">${left}</span>` : ""}</button>`;
  }).join("")}</div>` : "";
  const tasks = tasksFor(kid.id);
  const isToday = date === today();
  if (!tasks.length) return special + strip + `<div class="empty">Ainda não há tarefas. 🎉</div>`;
  const rec = tasks.filter(isRecurring), extra = tasks.filter((t) => !isRecurring(t));
  const done = rec.filter((t) => taskEntry(kid.id, t.id, date)).length;
  const when = isToday ? "hoje" : date === addDays(today(), -1) ? "ontem" : `em ${dayLabel(date)}`;
  return special + strip + `<p class="muted">Toca nas tarefas que fizeste ${when}. O pai/mãe depois valida.</p>`
    + (rec.length ? `<h2>📅 Todos os dias <span class="muted small">· ${done}/${rec.length} feitas</span></h2>${rec.map((t) => taskButton(kid, t, date)).join("")}` : "")
    + (extra.length ? `<h2>✨ Espontâneas</h2><p class="small muted">Fizeste alguma destas? Ganha pontos extra!</p>${extra.map((t) => taskButton(kid, t, date)).join("")}` : "")
    + extraBox(kid, date);
}

/** Pedido de pontos por algo que não está na lista; o pai/mãe decide se aceita e quantos pontos vale. */
function extraBox(kid, date) {
  const mine = S.log.filter((e) => e.type === "extra" && e.kidId === kid.id && e.date === date);
  return `<h2>💡 Fizeste outra coisa?</h2>
    <p class="small muted">Conta o que fizeste que não está na lista. O pai/mãe decide se vale pontos e quantos.</p>
    ${mine.map((e) => `<div class="card row"><div class="grow"><b>${esc(e.title)}</b>
      ${e.status === "pending" ? `<div class="small muted">${e.suggested ? `Pediste ${e.suggested} pontos` : "À espera do pai/mãe"}</div>` : ""}</div>
      ${e.status === "approved" ? ptsHtml(e.points) : ""}${statusPill(e.status)}
      ${e.status === "pending" ? `<button class="link" data-undo-extra="${e.id}">Cancelar</button>` : ""}</div>`).join("")}
    <form class="card" id="extraForm">
      <input name="title" required maxlength="100" placeholder="Ex: Ajudei a vizinha com as compras">
      <div class="row" style="margin-top:8px">
        <input name="suggested" type="number" inputmode="numeric" min="1" placeholder="Pontos que achas que vale (opcional)" class="grow">
        <button class="primary" type="submit">Pedir</button>
      </div>
    </form>`;
}

function taskButton(kid, t, date) {
  const e = taskEntry(kid.id, t.id, date);
  const st = e?.status || "";
  const mark = { pending: "⏳", approved: "✓", rejected: "✕" }[st] || "";
  return `<button class="task ${st}" data-task="${t.id}">
    <span class="check">${mark}</span>
    <span class="grow"><b>${esc(t.title)}</b>${st ? `<br><span class="small muted">${STATUS_LABEL[st]}${st === "pending" ? " · toca para desmarcar" : ""}</span>` : ""}</span>
    ${ptsHtml(t.points)}</button>`;
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
  app.querySelectorAll("[data-day]").forEach((b) => (b.onclick = () => { S.kidDate = b.dataset.day; render(); }));
  app.querySelectorAll("[data-task]").forEach((b) => (b.onclick = () => guard(async () => {
    const t = S.tasks.find((x) => x.id === b.dataset.task);
    const date = S.kidDate || today();
    if (!markableDays().includes(date)) throw new Error("Já não dá para marcar tarefas deste dia.");
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
      toast(e.status === "approved" ? "Esta já está aprovada. 👍" : "Esta foi rejeitada.");
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
  app.querySelectorAll("[data-special-done]").forEach((b) => (b.onclick = () => guard(async () => {
    const t = S.tasks.find((x) => x.id === b.dataset.specialDone);
    if (!t || isOver(t)) throw new Error("O prazo desta missão já terminou.");
    if (specialEntry(kid.id, t.id)) return;
    await addDoc(col("log"), {
      kidId: kid.id, type: "special", taskId: t.id, title: t.title, points: t.points,
      date: today(), status: "pending", createdAt: serverTimestamp(),
    });
    toast("Boa! O pai/mãe vai ver. 🤞");
  })));
  app.querySelectorAll("[data-special-undo]").forEach((b) => (b.onclick = () => guard(() => deleteDoc(doc(col("log"), b.dataset.specialUndo)))));
  const xf = document.getElementById("extraForm");
  if (xf) xf.onsubmit = (ev) => {
    ev.preventDefault();
    const title = xf.title.value.trim();
    if (!title) return;
    const sug = xf.suggested.value ? Number(xf.suggested.value) : null;
    guard(async () => {
      if (sug !== null) readPoints(sug);
      await addDoc(col("log"), {
        kidId: kid.id, type: "extra", title, points: 0, suggested: sug,
        date: S.kidDate || today(), status: "pending", createdAt: serverTimestamp(),
      });
      toast("Pedido enviado! O pai/mãe vai decidir. 🤞");
    });
  };
  app.querySelectorAll("[data-undo-extra]").forEach((b) => (b.onclick = () => guard(() => deleteDoc(doc(col("log"), b.dataset.undoExtra)))));
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
    { id: "validate", icon: "✔️", label: "Validar", badge: pending.length + suggestions.length + undecidedSpecials().length },
    { id: "kids", icon: "👧", label: "Filhos" },
    { id: "tasks", icon: "📋", label: "Tarefas" },
    { id: "rewards", icon: "🎁", label: "Prémios" },
    { id: "history", icon: "📜", label: "Histórico" },
  ];
  const nav = renderTabs(tabs);
  const views = { validate: parentValidate, kids: parentKids, tasks: parentTasks, rewards: parentRewards, history: parentHistory };
  renderShell(`<div class="header"><h1 class="row"><button class="avatar-btn" id="myPhoto" aria-label="Mudar a foto do pai/mãe">${parentAvatar("md")}<span class="cam">📷</span></button> Pai / Mãe</h1>
    <div>${bellButton("parent")}<button class="link" id="settings">⚙️</button><button class="link" id="switch">Trocar</button></div></div>
    ${views[S.tab]()}`, nav);
  document.getElementById("switch").onclick = () => setRole(null);
  document.getElementById("settings").onclick = openSettings;
  bindTabs();
  document.getElementById("bell").onclick = () => guard(() => togglePush("parent"));
  document.getElementById("myPhoto").onclick = () => photoForm("Foto do pai/mãe", S.fam.parentPhoto, (photo) => updateDoc(famDoc(), { parentPhoto: photo }));
  bindParentActions();
  bindCharts();
}

function parentValidate() {
  const pending = S.log.filter((e) => e.status === "pending");
  const suggestions = S.rewards.filter((r) => r.status === "suggested");
  const ended = undecidedSpecials();
  if (!pending.length && !suggestions.length && !ended.length) return `<div class="empty">Nada por validar. ✨</div>`;
  let html = "";
  if (ended.length) {
    html += `<h2>🚀 Missões terminadas</h2><p class="small muted">O prazo acabou. Ganharam os pontos?</p>`
      + ended.map(({ t, k }) => `<div class="card row wrap">
        ${avatar(k, "sm")}
        <div class="grow"><b>${esc(t.title)}</b><div class="small muted">${esc(k.name)} · terminou ${fmtDate(t.deadline)}</div></div>
        <button class="good" data-special-win="${t.id}|${k.id}">Ganhou +${t.points}</button>
        <button class="bad" data-special-lose="${t.id}|${k.id}">Não</button></div>`).join("");
  }
  for (const kid of S.kids) {
    const items = pending.filter((e) => e.kidId === kid.id).sort((a, b) => a.date.localeCompare(b.date));
    if (!items.length) continue;
    const taskCount = items.filter((e) => e.type === "task").length;
    html += `<div class="row spread"><h2 class="row">${avatar(kid, "sm")} ${esc(kid.name)} <span class="muted small">· saldo ${kid.points || 0}</span></h2>
      ${taskCount > 1 ? `<button class="good" data-approve-all="${kid.id}">Aprovar tarefas (${taskCount})</button>` : ""}</div>`;
    html += items.map((e) => e.type === "special" ? `<div class="card row wrap special-row">
      <div style="font-size:1.3rem">🚀</div>
      <div class="grow"><b>${esc(e.title)}</b><div class="small muted">Missão · diz que já fez · ${dayLabel(e.date)}</div></div>
      ${ptsHtml(e.points)}
      <button class="good" data-approve="${e.id}" aria-label="Ganhou">✓</button>
      <button class="bad" data-reject="${e.id}" aria-label="Não ganhou">✕</button></div>` : e.type === "extra" ? `<div class="card row wrap">
      <div style="font-size:1.3rem">💡</div>
      <div class="grow"><b>${esc(e.title)}</b><div class="small muted">Extra fora da lista · ${dayLabel(e.date)}${e.suggested ? ` · pede ${e.suggested} pts` : ""}</div></div>
      <button class="good" data-give-extra="${e.id}">Dar pontos</button>
      <button class="bad" data-reject="${e.id}" aria-label="Rejeitar">✕</button></div>` : `<div class="card row wrap">
      <div style="font-size:1.3rem">${e.type === "reward" ? "🎁" : "✅"}</div>
      <div class="grow"><b>${esc(e.title)}</b><div class="small muted">${e.type === "reward" ? "Pedido de prémio" : "Tarefa"} · ${dayLabel(e.date)}</div></div>
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
  return (S.kids.length > 1 ? `<h2 style="margin-top:0">Comparação</h2>${siblingsSummary()}` : "")
    + (S.kids.length ? S.kids.map((k) => `<div class="card">
      <div class="row"><button class="avatar-btn" data-kid-photo="${k.id}" aria-label="Mudar a foto de ${esc(k.name)}">${avatar(k, "md")}<span class="cam">📷</span></button>
        <div class="grow"><h3>${esc(k.name)}</h3><div class="muted small">${pendingRewardCost(k.id) ? `${pendingRewardCost(k.id)} pts em pedidos de prémio` : ""}</div></div>
        <div class="pts" style="font-size:1.4rem">⭐ ${k.points || 0}</div></div>
      ${weekChart(k)}
      <div class="row wrap" style="margin-top:10px">
        <button class="bad" data-penalty="${k.id}">− Mau comportamento</button>
        <button class="good" data-bonus="${k.id}">+ Bónus</button>
        <button data-edit-kid="${k.id}">Editar</button></div></div>`).join("")
    : `<div class="empty">Ainda não adicionaste filhos.</div>`)
    + `<button class="primary block" id="addKid">+ Adicionar filho</button>`;
}

function parentTasks() {
  const active = S.tasks.filter((t) => t.active !== false);
  const row = (t) => `<div class="card row">
      <div class="grow"><b>${esc(t.title)}</b><div class="small muted">${esc(t.kidIds?.length ? t.kidIds.map(kidName).join(", ") : "Todos os filhos")}</div></div>
      ${ptsHtml(t.points)}<button data-edit-task="${t.id}">Editar</button></div>`;
  const specials = active.filter(isSpecial).sort((a, b) => deadlineMs(a) - deadlineMs(b));
  const rec = active.filter((t) => isRecurring(t) && !isSpecial(t)), extra = active.filter((t) => !isRecurring(t) && !isSpecial(t));
  const spRow = (t) => {
    const kids = kidsOf(t), decided = kids.filter((k) => ["approved", "rejected"].includes(specialEntry(k.id, t.id)?.status)).length;
    return `<div class="card row special-row">
      <div class="grow"><b>${esc(t.title)}</b><div class="small muted">Até ${fmtDate(t.deadline)} · ${esc(t.kidIds?.length ? t.kidIds.map(kidName).join(", ") : "Todos os filhos")}</div>
        <div class="small">${isOver(t) ? `Terminou · ${decided}/${kids.length} decididos` : `Faltam <span data-deadline="${deadlineMs(t)}">${countdownText(deadlineMs(t) - Date.now())}</span>`}</div></div>
      ${ptsHtml(t.points)}<button data-edit-task="${t.id}">Editar</button></div>`;
  };
  return `<button class="block" id="taskIdeas" style="margin-bottom:4px">💡 Ideias de tarefas</button>
    <div class="row spread"><h2>🚀 Missões <span class="muted small">· com prazo</span></h2><button class="primary" data-add-task="special">+ Nova</button></div>
    ${specials.length ? specials.map(spRow).join("") : `<div class="empty">Missões com data limite, como "Ler um livro até sexta". No fim decides se ganharam.</div>`}
    <div class="row spread"><h2>📅 Recorrentes <span class="muted small">· todos os dias</span></h2><button class="primary" data-add-task="rec">+ Nova</button></div>
    ${rec.length ? rec.map(row).join("") : `<div class="empty">Tarefas para fazer sempre, como "Fazer a cama".</div>`}
    <div class="row spread"><h2>✨ Espontâneas <span class="muted small">· quando acontecem</span></h2><button class="primary" data-add-task="extra">+ Nova</button></div>
    ${extra.length ? extra.map(row).join("") : `<div class="empty">Pontos extra para coisas que não são diárias, como "Ajudar a lavar o carro".</div>`}`;
}

function parentRewards() {
  const active = S.rewards.filter((r) => r.status === "active");
  return `<div class="row" style="margin-bottom:12px"><button class="grow" id="rewardIdeas">💡 Ideias</button><button class="primary grow" id="addReward">+ Novo prémio</button></div>`
    + (active.length ? active.map((r) => `<div class="card row">
      <div class="grow"><b>${esc(r.title)}</b>${r.suggestedBy ? `<div class="small muted">Sugerido por ${esc(kidName(r.suggestedBy))}</div>` : ""}</div>
      <span class="pts">⭐ ${r.cost}</span><button data-edit-reward="${r.id}">Editar</button></div>`).join("")
      : `<div class="empty">Ainda não há prémios.</div>`);
}

function parentHistory() {
  const items = S.log.filter((e) => e.status !== "pending");
  return items.length ? items.slice(0, 200).map((e) => historyItem(e, true, true)).join("") : `<div class="empty">Ainda não há histórico.</div>`;
}

function bindParentActions() {
  const on = (sel, fn) => app.querySelectorAll(sel).forEach((b) => (b.onclick = () => fn(b)));
  on("[data-approve]", (b) => guard(() => approveEntry(b.dataset.approve)));
  on("[data-fix]", (b) => fixForm(S.log.find((x) => x.id === b.dataset.fix)));
  on("[data-give-extra]", (b) => {
    const e = S.log.find((x) => x.id === b.dataset.giveExtra);
    openForm(`Pontos para "${e.title}"`, `<p class="small muted">${esc(kidName(e.kidId))}${e.suggested ? ` pediu ${e.suggested} pontos` : " não sugeriu pontos"}.</p>
      <label>Quantos pontos vale?</label><input name="points" type="number" inputmode="numeric" min="1" required value="${e.suggested ?? ""}">`,
    async (fd) => { await approveEntry(e.id, readPoints(fd.get("points"))); toast("Pontos dados! 🌟"); }, "Dar pontos");
  });
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
  on("[data-kid-photo]", (b) => { const k = kidById(b.dataset.kidPhoto); photoForm(`A foto de ${k.name}`, k.photo, (photo) => updateDoc(doc(col("kids"), k.id), { photo })); });
  on("[data-edit-task]", (b) => taskForm(S.tasks.find((t) => t.id === b.dataset.editTask)));
  on("[data-edit-reward]", (b) => rewardForm(S.rewards.find((r) => r.id === b.dataset.editReward)));
  on("#addKid", () => kidForm(null));
  on("[data-add-task]", (b) => taskForm(null, b.dataset.addTask));
  const decide = (b, won) => guard(async () => {
    const [tid, kid] = (won ? b.dataset.specialWin : b.dataset.specialLose).split("|");
    const t = S.tasks.find((x) => x.id === tid);
    if (specialEntry(kid, tid)) return;
    await decideSpecial(t, kid, won);
    toast(won ? "Pontos dados! 🌟" : "Registado.");
  });
  on("[data-special-win]", (b) => decide(b, true));
  on("[data-special-lose]", (b) => decide(b, false));
  on("#taskIdeas", () => ideasForm("tasks"));
  on("#rewardIdeas", () => ideasForm("rewards"));
  on("#addReward", () => rewardForm(null));
}

const MAX_POINTS = 1000000;

function readPoints(v, { allowZero = false } = {}) {
  const n = Number(v);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(n) || n < min || n > MAX_POINTS) {
    throw new Error(`Os pontos têm de ser um número inteiro entre ${min} e ${MAX_POINTS.toLocaleString("pt-PT")}.`);
  }
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

// ---------- Atualizações ----------
// Os telemóveis guardam a app em cache; ao abrir (e ao voltar à app) comparamos com version.json
// e, se houver versão nova, recarregamos os ficheiros. Atualiza APP_VERSION e version.json juntos.
const APP_VERSION = "2026-10-17.6";
async function checkForUpdate() {
  try {
    if (!modal.classList.contains("hidden")) return; // não interromper quem está a escrever
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    const { version } = await res.json();
    if (!version || version === APP_VERSION) return;
    // Evita ciclos se o servidor ainda estiver a servir a versão antiga.
    if (sessionStorage.getItem("pf-updated-to") === version) return;
    sessionStorage.setItem("pf-updated-to", version);
    await Promise.all(["./", "index.html", "app.js", "style.css", "firebase-config.js", "sw.js", "manifest.webmanifest"]
      .map((u) => fetch(u, { cache: "reload" }).catch(() => {})));
    location.reload();
  } catch { /* sem rede: tenta da próxima vez */ }
}
setTimeout(checkForUpdate, 1500);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });

const PHOTO_SIZE = 192;

/** Campos do recorte de foto (usados por photoEditor). */
const photoFieldHtml = () => `
    <div class="row wrap">
      <canvas id="photoCanvas" width="${PHOTO_SIZE}" height="${PHOTO_SIZE}" class="photo-edit hidden"></canvas>
      <div class="grow">
        <label class="btn" style="display:inline-block;margin:0;font-weight:400">📷 Escolher foto<input type="file" accept="image/*" id="photoFile" hidden></label>
        <button type="button" class="link hidden" id="photoRemove">Remover foto</button>
        <div id="photoZoomBox" class="hidden"><p class="small muted" style="margin:8px 0 2px">Arrasta para centrar a cara; usa a barra para aproximar.</p>
          <input type="range" id="photoZoom" min="1" max="4" step="0.01" value="1"></div>
      </div>
    </div>`;

/**
 * Recorte quadrado da foto: arrastar para mover, barra para aproximar.
 * Fica guardada como JPEG pequeno (~15 KB) nos dados da família — nunca no repositório público.
 */
function photoEditor(form, initial) {
  const canvas = form.querySelector("#photoCanvas"), ctx = canvas.getContext("2d");
  const zoomEl = form.querySelector("#photoZoom"), zoomBox = form.querySelector("#photoZoomBox");
  const removeBtn = form.querySelector("#photoRemove");
  const st = { img: null, zoom: 1, x: 0, y: 0, changed: false, removed: false };
  const draw = () => {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
    if (!st.img) return;
    const base = PHOTO_SIZE / Math.min(st.img.width, st.img.height);
    const w = st.img.width * base * st.zoom, h = st.img.height * base * st.zoom;
    // Não deixa aparecer fundo vazio à volta da foto.
    st.x = Math.min(0, Math.max(PHOTO_SIZE - w, st.x));
    st.y = Math.min(0, Math.max(PHOTO_SIZE - h, st.y));
    ctx.drawImage(st.img, st.x, st.y, w, h);
  };
  const show = (on) => {
    canvas.classList.toggle("hidden", !on);
    removeBtn.classList.toggle("hidden", !on);
  };
  const load = (src, editable) => {
    const img = new Image();
    img.onload = () => {
      st.img = img;
      st.zoom = 1;
      const base = PHOTO_SIZE / Math.min(img.width, img.height);
      st.x = (PHOTO_SIZE - img.width * base) / 2;
      st.y = (PHOTO_SIZE - img.height * base) / 2;
      zoomEl.value = 1;
      zoomBox.classList.toggle("hidden", !editable);
      show(true);
      draw();
    };
    img.src = src;
  };
  if (initial) load(initial, false);
  form.querySelector("#photoFile").onchange = (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    st.changed = true; st.removed = false;
    load(URL.createObjectURL(file), true);
  };
  zoomEl.oninput = () => {
    // Aproxima a partir do centro do recorte.
    const c = PHOTO_SIZE / 2, k = Number(zoomEl.value) / st.zoom;
    st.x = c - (c - st.x) * k; st.y = c - (c - st.y) * k;
    st.zoom = Number(zoomEl.value);
    draw();
  };
  let drag = null;
  canvas.onpointerdown = (e) => {
    if (zoomBox.classList.contains("hidden")) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    const scale = PHOTO_SIZE / canvas.getBoundingClientRect().width;
    st.x += (e.clientX - drag.x) * scale; st.y += (e.clientY - drag.y) * scale;
    drag = { x: e.clientX, y: e.clientY };
    draw();
  };
  canvas.onpointerup = canvas.onpointercancel = () => (drag = null);
  removeBtn.onclick = () => {
    st.img = null; st.changed = true; st.removed = true;
    zoomBox.classList.add("hidden");
    show(false);
  };
  return {
    get changed() { return st.changed; },
    dataUrl: () => (st.removed || !st.img ? null : canvas.toDataURL("image/jpeg", 0.82)),
  };
}

/** Janela só para mudar uma foto (abre ao tocar na foto). */
function photoForm(title, current, save) {
  const form = openForm(title, `${photoFieldHtml()}<p class="small muted" style="margin-top:10px">Toca em "Escolher foto" para tirar uma foto ou escolher da galeria.</p>`,
    async () => {
      if (!photo.changed) return;
      await save(photo.dataUrl());
      toast("Foto atualizada! 📸");
    });
  const photo = photoEditor(form, current && PHOTO_RE.test(current) ? current : null);
  // Abre logo a escolha da foto (no iPhone pode ser preciso tocar no botão).
  setTimeout(() => form.querySelector("#photoFile")?.click(), 50);
}

function kidForm(kid) {
  const emoji = kid?.emoji || EMOJIS[S.kids.length % EMOJIS.length];
  const form = openForm(kid ? `Editar ${kid.name}` : "Novo filho", `
    <label>Nome</label><input name="name" required maxlength="30" value="${esc(kid?.name || "")}">
    <label>Foto</label>${photoFieldHtml()}
    <label>Emoji (quando não há foto)</label><select name="emoji">${EMOJIS.map((e) => `<option ${e === emoji ? "selected" : ""}>${e}</option>`).join("")}</select>
    <label>${kid ? "Novo PIN (deixa vazio para manter)" : "PIN (4 a 6 dígitos)"}</label>
    <input name="pin" type="password" inputmode="numeric" maxlength="6" ${kid ? "" : "required"} autocomplete="off">
    ${kid ? `<button type="button" class="bad" id="delKid" style="margin-top:16px">Remover ${esc(kid.name)}</button>` : ""}`,
  async (fd) => {
    const name = fd.get("name").trim(), pin = fd.get("pin");
    if (!name) throw new Error("Escreve o nome.");
    const data = { name, emoji: fd.get("emoji") };
    if (photo.changed) data.photo = photo.dataUrl();
    if (pin || !kid) {
      if (!validPin(pin)) throw new Error("O PIN tem de ter 4 a 6 dígitos.");
      data.pinHash = await hashPin(pin);
    }
    if (kid) await updateDoc(doc(col("kids"), kid.id), data);
    else await addDoc(col("kids"), { ...data, points: 0, order: S.kids.length, createdAt: serverTimestamp() });
  });
  const photo = photoEditor(form, kid?.photo && PHOTO_RE.test(kid.photo) ? kid.photo : null);
  const del = form.querySelector("#delKid");
  if (del) del.onclick = () => guard(async () => {
    if (!confirm(`Remover ${kid.name}? Perde os ${kid.points || 0} pontos. O histórico fica guardado.`)) return;
    await deleteDoc(doc(col("kids"), kid.id));
    closeModal();
  });
}

function taskForm(task, kindDefault = "rec") {
  const kind = task ? (isSpecial(task) ? "special" : isRecurring(task) ? "rec" : "extra") : kindDefault;
  const placeholder = { rec: "Ex: Fazer a cama", extra: "Ex: Ajudar a lavar o carro", special: "Ex: Ler um livro inteiro" }[kind];
  const form = openForm(task ? "Editar tarefa" : "Nova tarefa", `
    <label>Tarefa</label><input name="title" required maxlength="80" value="${esc(task?.title || "")}" placeholder="${placeholder}">
    <label>Pontos</label><input name="points" type="number" inputmode="numeric" min="1" required value="${task?.points ?? ""}">
    <label>Tipo</label>
    <label class="inline"><input type="radio" name="kind" value="rec" ${kind === "rec" ? "checked" : ""}> 📅 Recorrente (todos os dias)</label>
    <label class="inline"><input type="radio" name="kind" value="extra" ${kind === "extra" ? "checked" : ""}> ✨ Espontânea (quando acontece)</label>
    <label class="inline"><input type="radio" name="kind" value="special" ${kind === "special" ? "checked" : ""}> 🚀 Missão (com prazo)</label>
    <div id="deadlineBox"><label>Até que dia?</label><input name="deadline" type="date" min="${today()}" value="${task?.deadline || addDays(today(), 7)}">
      <p class="small muted">Os filhos veem um contador até ao fim desse dia. No fim, decides se ganharam os pontos.</p></div>
    <label>Para quem</label>
    ${S.kids.length ? S.kids.map((k) => `<label class="inline"><input type="checkbox" name="kids" value="${k.id}" ${!task?.kidIds?.length || task.kidIds.includes(k.id) ? "checked" : ""}> ${avatar(k, "xs")} ${esc(k.name)}</label>`).join("") : `<p class="small muted">Todos os filhos.</p>`}
    ${task ? `<button type="button" class="bad" id="delTask" style="margin-top:16px">Apagar tarefa</button>` : ""}`,
  async (fd) => {
    const title = fd.get("title").trim();
    if (!title) throw new Error("Escreve o nome da tarefa.");
    const k = fd.get("kind");
    const deadline = fd.get("deadline");
    if (k === "special" && !/^\d{4}-\d{2}-\d{2}$/.test(deadline || "")) throw new Error("Escolhe até que dia.");
    if (k === "special" && deadline < today() && deadline !== task?.deadline) throw new Error("A data limite não pode ser no passado.");
    const selKids = fd.getAll("kids");
    if (S.kids.length && !selKids.length) throw new Error("Escolhe pelo menos um filho.");
    const data = {
      title, points: readPoints(fd.get("points")), recurring: k === "rec",
      special: k === "special", deadline: k === "special" ? deadline : null,
      days: [], date: null,
      // Lista vazia = todos os filhos (incluindo os que forem adicionados depois).
      kidIds: selKids.length === S.kids.length ? [] : selKids,
      active: true,
    };
    if (task) await updateDoc(doc(col("tasks"), task.id), data);
    else await addDoc(col("tasks"), { ...data, createdAt: serverTimestamp() });
  });
  const syncKind = () => form.querySelector("#deadlineBox").classList.toggle("hidden", form.querySelector("[name=kind]:checked").value !== "special");
  form.querySelectorAll("[name=kind]").forEach((r) => (r.onchange = syncKind));
  syncKind();
  const del = form.querySelector("#delTask");
  // Arquivar em vez de apagar mantém o histórico coerente.
  if (del) del.onclick = () => guard(async () => {
    if (!confirm("Apagar esta tarefa?")) return;
    await updateDoc(doc(col("tasks"), task.id), { active: false });
    closeModal();
  });
}

/** Lista de ideias para escolher e adicionar de uma vez (os pontos podem ser ajustados antes). */
function ideasForm(kind) {
  const isTasks = kind === "tasks";
  const existing = new Set((isTasks ? S.tasks.filter((t) => t.active !== false) : S.rewards.filter((r) => r.status === "active"))
    .map((x) => x.title.trim().toLowerCase()));
  const ideas = (isTasks ? TASK_IDEAS : REWARD_IDEAS).filter(([title]) => !existing.has(title.toLowerCase()))
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], "pt"));
  if (!ideas.length) { toast("Já adicionaste todas as ideias."); return; }
  const form = openForm(isTasks ? "Ideias de tarefas recorrentes" : "Ideias de prémios", `
    <p class="small muted">Escolhe as que queres e ajusta os pontos. ${isTasks ? "Ficam como recorrentes, para todos os filhos." : ""}</p>
    <label class="inline" style="font-weight:600"><input type="checkbox" id="pickAll"> Selecionar todas</label>
    ${ideas.map(([title, pts], i) => `<div class="row" style="margin:6px 0">
      <label class="inline grow" style="margin:0"><input type="checkbox" name="pick" value="${i}"> ${esc(title)}</label>
      <input name="pts${i}" type="number" inputmode="numeric" min="1" value="${pts}" style="width:80px">
    </div>`).join("")}`,
  async (fd) => {
    const picked = fd.getAll("pick").map(Number);
    if (!picked.length) throw new Error("Escolhe pelo menos uma.");
    const batch = writeBatch(db);
    for (const i of picked) {
      const pts = readPoints(fd.get(`pts${i}`));
      const title = ideas[i][0];
      batch.set(doc(col(isTasks ? "tasks" : "rewards")), isTasks
        ? { title, points: pts, recurring: true, days: [], date: null, kidIds: [], active: true, createdAt: serverTimestamp() }
        : { title, cost: pts, status: "active", suggestedBy: null, createdAt: serverTimestamp() });
    }
    await batch.commit();
    toast(`${picked.length} ${isTasks ? "tarefa(s)" : "prémio(s)"} adicionado(s).`);
  }, "Adicionar");
  const all = form.querySelector("#pickAll");
  all.onchange = () => form.querySelectorAll("[name=pick]").forEach((c) => (c.checked = all.checked));
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
    <label>Foto do perfil Pai / Mãe</label>${photoFieldHtml()}
    <label>Mudar PIN do pai/mãe</label>
    <input name="pin" type="password" inputmode="numeric" maxlength="6" placeholder="Novo PIN (deixa vazio para manter)" autocomplete="off">
    <label>Os filhos podem marcar tarefas até quantos dias para trás?</label>
    <input name="backDays" type="number" inputmode="numeric" min="0" max="${MAX_BACK_DAYS}" required value="${backDays()}">
    <p class="small muted">0 = só o próprio dia. Máximo ${MAX_BACK_DAYS}.</p>
    <label>Aparelhos dos filhos</label>
    <p class="small muted" id="devCount">A contar aparelhos ligados…</p>
    <div class="row wrap">
      <button type="button" class="good" id="linkDevice">Ligar aparelho de um filho</button>
      <button type="button" class="bad" id="unlinkAll">Desligar todos</button>
    </div>
    <label>Recomeçar</label>
    <p class="small muted">Põe o saldo de todos os filhos a 0 e apaga o histórico de pontos (tarefas marcadas, validações, bónus, penalizações e pedidos de prémio). Filhos, tarefas e prémios ficam.</p>
    <button type="button" class="bad" id="resetPoints">Apagar todos os pontos</button>
    <p class="small muted" style="margin-top:16px">${isDevice() ? "Aparelho ligado por link" : `Conta: ${esc(S.user.email)}`}</p>
    <button type="button" class="bad" id="logoutAll" style="margin-top:8px">${isDevice() ? "Desligar este aparelho" : "Sair da conta neste aparelho"}</button>`,
  async (fd) => {
    const pin = fd.get("pin");
    const back = Number(fd.get("backDays"));
    if (!Number.isInteger(back) || back < 0 || back > MAX_BACK_DAYS) throw new Error(`Escolhe um número de dias entre 0 e ${MAX_BACK_DAYS}.`);
    const changes = {};
    if (pin) {
      if (!validPin(pin)) throw new Error("O PIN tem de ter 4 a 6 dígitos.");
      changes.parentPinHash = await hashPin(pin);
    }
    if (back !== backDays()) changes.maxBackDays = back;
    if (photo.changed) changes.parentPhoto = photo.dataUrl();
    if (!Object.keys(changes).length) return;
    await updateDoc(famDoc(), changes);
    toast("Definições guardadas.");
  });
  const photo = photoEditor(form, S.fam.parentPhoto && PHOTO_RE.test(S.fam.parentPhoto) ? S.fam.parentPhoto : null);
  form.querySelector("#logoutAll").onclick = () => { closeModal(); leaveDevice(); };
  form.querySelector("#linkDevice").onclick = () => guard(openLinkDevice);
  form.querySelector("#resetPoints").onclick = () => guard(async () => {
    if (!confirm("Apagar TODOS os pontos e o histórico? Isto não se pode desfazer.")) return;
    if (!confirm("Tens a certeza? Os saldos de todos os filhos voltam a 0.")) return;
    const n = await resetPoints();
    closeModal();
    toast(`Pontos apagados (${n} registos). Recomeçar! 🚀`);
  });
  form.querySelector("#unlinkAll").onclick = () => guard(async () => {
    if (!confirm("Desligar todos os aparelhos ligados por link? Vão precisar de um link novo para voltar a entrar.")) return;
    const n = await revokeDevices();
    form.querySelector("#devCount").textContent = `Desligados ${n} aparelho(s). O link antigo deixou de funcionar.`;
  });
  getDocs(col("members")).then((snap) => {
    const el = form.querySelector("#devCount");
    if (el) el.textContent = snap.size ? `${snap.size} aparelho(s) ligado(s) por link.` : "Nenhum aparelho ligado por link.";
  }).catch(() => {});
}

/** Sair (conta da família) ou desligar (aparelho ligado por link). */
async function leaveDevice() {
  if (isDevice()) {
    if (!confirm("Desligar este aparelho? Para voltar a entrar é preciso um link novo do pai/mãe.")) return;
    await deleteDoc(doc(col("members"), S.user.uid)).catch(() => {});
    await unlinkDevice();
    forgetJoinLink();
    await signOut(auth);
  } else {
    if (!confirm("Sair da conta da família neste aparelho?")) return;
    await signOut(auth);
  }
}

async function openLinkDevice() {
  let token = S.fam.inviteToken;
  if (!token) {
    token = newToken();
    await updateDoc(famDoc(), { inviteToken: token });
  }
  const link = joinLink(token);
  modal.innerHTML = `<div class="sheet"><h2 style="margin-top:0">Ligar aparelho de um filho</h2>
    <p>Envia este link para o telemóvel ou tablet do teu filho (WhatsApp, SMS, email…). Ao abri-lo, o aparelho fica ligado à família e o filho só precisa do PIN.</p>
    <input readonly value="${esc(link)}" id="linkBox" style="font-size:.8rem">
    <div class="row wrap" style="margin-top:10px">
      ${navigator.share ? `<button class="primary" id="shareLink">Partilhar</button>` : ""}
      <button id="copyLink">Copiar link</button>
    </div>
    <p class="small muted" style="margin-top:14px"><b>Ícone no ecrã principal:</b> depois de abrir o link no aparelho do filho, usa logo aí "Adicionar ao ecrã principal".</p>
    <p class="small muted">⚠️ Quem tiver este link entra na app da família (mas precisa dos PINs). Se o link chegar a quem não devia, usa "Desligar todos".</p>
    <div class="actions"><button data-close>Fechar</button></div></div>`;
  modal.classList.remove("hidden");
  modal.querySelector("[data-close]").onclick = closeModal;
  modal.querySelector("#copyLink").onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast("Link copiado."); }
    catch { const box = modal.querySelector("#linkBox"); box.select(); toast("Seleciona e copia o link."); }
  };
  const share = modal.querySelector("#shareLink");
  if (share) share.onclick = () => navigator.share({ title: "Pontos da Família", text: "Abre este link para entrar na app:", url: link }).catch(() => {});
}

/** Saldos a 0 e histórico apagado; filhos, tarefas e prémios mantêm-se. Devolve quantos registos apagou. */
async function resetPoints() {
  const snap = await getDocs(col("log"));
  const ops = [...snap.docs.map((d) => (b) => b.delete(d.ref)), ...S.kids.map((k) => (b) => b.update(doc(col("kids"), k.id), { points: 0 }))];
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
  return snap.size;
}

/** Desliga todos os aparelhos ligados por link e invalida o link antigo. */
async function revokeDevices() {
  const snap = await getDocs(col("members"));
  const batch = writeBatch(db);
  batch.update(famDoc(), { inviteToken: newToken() });
  // Um aparelho ligado não se desliga a si próprio aqui, para não perder o acesso a meio.
  let n = 0;
  snap.docs.forEach((d) => { if (d.id !== S.user.uid) { batch.delete(d.ref); n++; } });
  await batch.commit();
  return n;
}
