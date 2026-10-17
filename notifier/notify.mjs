// Notificador da app Pontos da Família. Corre a cada ~10 minutos no GitHub Actions
// (.github/workflows/notify.yml) e envia notificações push pelo Firebase Cloud Messaging:
//  - pai/mãe: tarefas marcadas, prémios pedidos e prémios sugeridos à espera de validação;
//  - filhos: pontos validados/rejeitados, bónus, penalizações e missões;
//  - filhos, por volta das 19:45 (Lisboa): lembrete se ainda há tarefas do dia por marcar.
// Uso: FIREBASE_SERVICE_ACCOUNT='<json>' node notify.mjs [--log-only]
//   --log-only: escreve as mensagens no ecrã em vez de as enviar (para testes).
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const LOG_ONLY = process.argv.includes("--log-only");
// Só para testes: finge que agora é esta hora (ISO 8601).
const NOW = process.env.NOTIFY_NOW ? new Date(process.env.NOTIFY_NOW) : new Date();
if (Number.isNaN(NOW.getTime())) throw new Error(`NOTIFY_NOW inválido: ${process.env.NOTIFY_NOW}`);
const TZ = "Europe/Lisbon";
const REMINDER_START = "19:45"; // a partir desta hora (Lisboa)…
const REMINDER_END = "21:30";   // …até esta, para tolerar atrasos do agendamento do GitHub
const APP_URL = process.env.APP_URL || "https://jorgegoncalves87-ux.github.io/pontos-familia/";

if (process.env.FIRESTORE_EMULATOR_HOST) {
  initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-pontos" });
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
} else {
  console.log("Sem FIREBASE_SERVICE_ACCOUNT configurado: nada a fazer.");
  process.exit(0);
}
const db = getFirestore();

/** Data (AAAA-MM-DD) e hora (HH:MM) atuais em Lisboa. */
function lisbonNow(now = NOW) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const signed = (n) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
}

/** Envia para uma lista de tokens e apaga os que já não são válidos. */
async function send(fam, tokenDocs, { title, body, tag }) {
  const tokens = [...new Set(tokenDocs.map((t) => t.token).filter(Boolean))];
  if (!tokens.length) return;
  console.log(`[${fam.id}] → ${tokens.length} aparelho(s): ${title} — ${body.replace(/\n/g, " / ")}`);
  if (LOG_ONLY) return;
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data: { title, body, tag: tag || "", link: APP_URL },
    webpush: { headers: { Urgency: "high", TTL: "86400" } },
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error?.code || "";
    console.log(`  falhou (${code})`);
    if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token") || code.includes("invalid-argument")) dead.push(tokens[i]);
  });
  for (const t of tokenDocs.filter((d) => dead.includes(d.token))) await t.ref.delete();
}

async function processFamily(fam) {
  const famRef = fam.ref;
  const famData = fam.data();
  const notify = famData.notify || {};
  const [kidsSnap, tokensSnap, tasksSnap] = await Promise.all([
    famRef.collection("kids").get(), famRef.collection("pushTokens").get(), famRef.collection("tasks").get(),
  ]);
  const kids = new Map(kidsSnap.docs.map((d) => [d.id, d.data()]));
  const tokens = tokensSnap.docs.map((d) => ({ ref: d.ref, ...d.data() }));
  const parentTokens = tokens.filter((t) => t.parent === true);
  const kidTokens = (kidId) => tokens.filter((t) => Array.isArray(t.kids) && t.kids.includes(kidId));
  const kidName = (id) => kids.get(id)?.name || "Um filho";

  // Na primeira execução, marca o que já existe como avisado, para não inundar ninguém.
  const firstRun = !notify.initialized;

  // 1) Pai/mãe: novos pedidos à espera de validação.
  const pendingSnap = await famRef.collection("log").where("status", "==", "pending").get();
  const newPending = pendingSnap.docs.filter((d) => !d.get("notifiedParent"));
  const suggSnap = await famRef.collection("rewards").where("status", "==", "suggested").get();
  const newSugg = suggSnap.docs.filter((d) => !d.get("notifiedParent"));
  if (!firstRun && (newPending.length || newSugg.length)) {
    const lines = [];
    const byKid = new Map();
    for (const d of newPending) {
      const e = d.data();
      const k = byKid.get(e.kidId) || { tasks: 0, rewards: [], extras: [], specials: [] };
      if (e.type === "reward") k.rewards.push(e.title);
      else if (e.type === "extra") k.extras.push(e.title);
      else if (e.type === "special") k.specials.push(e.title);
      else k.tasks++;
      byKid.set(e.kidId, k);
    }
    for (const [kidId, k] of byKid) {
      const parts = [];
      if (k.tasks) parts.push(`marcou ${plural(k.tasks, "tarefa", "tarefas")}`);
      if (k.rewards.length) parts.push(`pediu ${k.rewards.length === 1 ? `o prémio "${k.rewards[0]}"` : `${k.rewards.length} prémios`}`);
      if (k.specials.length) parts.push(`diz que já cumpriu a missão ${k.specials.map((t) => `"${t}"`).join(", ")}`);
      if (k.extras.length) parts.push(`pede pontos por ${k.extras.length === 1 ? `"${k.extras[0]}"` : `${k.extras.length} coisas fora da lista`}`);
      lines.push(`${kidName(kidId)} ${parts.join(" e ")}`);
    }
    for (const d of newSugg) lines.push(`${kidName(d.get("suggestedBy"))} sugeriu o prémio "${d.get("title")}"`);
    const hasReward = [...byKid.values()].some((k) => k.rewards.length);
    await send(fam, parentTokens, {
      title: hasReward ? "🎁 Pedido de prémio para validar" : "✔️ Há coisas para validar",
      body: lines.join("\n"),
      tag: "validar",
    });
  }
  await commitInChunks([
    ...newPending.map((d) => (b) => b.update(d.ref, { notifiedParent: true })),
    ...newSugg.map((d) => (b) => b.update(d.ref, { notifiedParent: true })),
  ]);

  // 1b) Pai/mãe: missões cujo prazo acabou e ainda não foram decididas.
  const { date: todayLis } = lisbonNow();
  const specials = tasksSnap.docs.map((d) => ({ ref: d.ref, id: d.id, ...d.data() })).filter((t) => t.active !== false && t.special && t.deadline);
  const ended = specials.filter((t) => t.deadline < todayLis && !t.notifiedEnded);
  if (ended.length) {
    const specialLog = await famRef.collection("log").where("type", "==", "special").get();
    const decided = new Set(specialLog.docs.filter((d) => d.get("status") !== "pending").map((d) => `${d.get("kidId")}|${d.get("taskId")}`));
    const lines = [];
    for (const t of ended) {
      const who = [...kids.keys()].filter((id) => (!t.kidIds?.length || t.kidIds.includes(id)) && !decided.has(`${id}|${t.id}`));
      if (who.length) lines.push(`"${t.title}" (${who.map(kidName).join(", ")})`);
    }
    if (!firstRun && lines.length) {
      await send(fam, parentTokens, { title: "🚀 Missão terminou", body: `Decide se ganharam os pontos:\n${lines.join("\n")}`, tag: "especial" });
    }
    await commitInChunks(ended.map((t) => (b) => b.update(t.ref, { notifiedEnded: true })));
  }

  // 2) Filhos: pontos validados (ou rejeitados), bónus e penalizações dos últimos 3 dias.
  const since = Timestamp.fromMillis(NOW.getTime() - 3 * 24 * 3600 * 1000);
  const decidedSnap = await famRef.collection("log").where("decidedAt", ">=", since).get();
  const newDecided = decidedSnap.docs.filter((d) => !d.get("notifiedKid") && ["approved", "rejected"].includes(d.get("status")));
  if (!firstRun) {
    const byKid = new Map();
    for (const d of newDecided) {
      const e = d.data();
      if (!byKid.has(e.kidId)) byKid.set(e.kidId, []);
      byKid.get(e.kidId).push(e);
    }
    for (let [kidId, entries] of byKid) {
      if (!kids.has(kidId)) continue;
      const lines = [];
      for (const e of entries.filter((e) => e.corrected)) lines.push(`✏️ Corrigido: ${e.title} → ${signed(e.applied ?? e.points)} pontos`);
      entries = entries.filter((e) => !e.corrected);
      const okTasks = entries.filter((e) => e.type === "task" && e.status === "approved");
      if (okTasks.length) lines.push(`✅ ${plural(okTasks.length, "tarefa validada", "tarefas validadas")}: ${signed(okTasks.reduce((s, e) => s + (e.applied ?? e.points), 0))} pontos`);
      const noTasks = entries.filter((e) => e.type === "task" && e.status === "rejected");
      if (noTasks.length) lines.push(`✕ ${plural(noTasks.length, "tarefa não foi aceite", "tarefas não foram aceites")}`);
      for (const e of entries.filter((e) => e.type === "special")) lines.push(e.status === "approved" ? `🚀 Missão cumprida "${e.title}": ${signed(e.applied ?? e.points)} pontos!` : `🚀 Missão "${e.title}": desta vez não.`);
      for (const e of entries.filter((e) => e.type === "extra")) lines.push(e.status === "approved" ? `💡 ${e.title}: ${signed(e.applied ?? e.points)} pontos` : `💡 Sem pontos para: ${e.title}`);
      for (const e of entries.filter((e) => e.type === "bonus")) lines.push(`🌟 Bónus ${signed(e.applied ?? e.points)}: ${e.title}`);
      for (const e of entries.filter((e) => e.type === "penalty")) lines.push(`⚠️ ${signed(e.applied ?? e.points)}: ${e.title}`);
      for (const e of entries.filter((e) => e.type === "reward")) lines.push(e.status === "approved" ? `🎁 Prémio aprovado: ${e.title}!` : `🎁 Prémio não aprovado: ${e.title}`);
      if (!lines.length) continue;
      lines.push(`Tens agora ${kids.get(kidId).points || 0} pontos ⭐`);
      await send(fam, kidTokens(kidId), { title: `${kids.get(kidId).name}, os teus pontos mudaram!`, body: lines.join("\n"), tag: `pontos-${kidId}` });
    }
  }
  await commitInChunks(newDecided.map((d) => (b) => b.update(d.ref, { notifiedKid: true })));

  // 3) Filhos: lembrete das 19:45 se ainda há tarefas recorrentes de hoje por marcar.
  const { date, time } = lisbonNow();
  if (time >= REMINDER_START && time <= REMINDER_END && notify.lastReminderDate !== date) {
    const todaySnap = await famRef.collection("log").where("date", "==", date).get();
    const marked = new Set(todaySnap.docs.filter((d) => d.get("type") === "task").map((d) => `${d.get("kidId")}|${d.get("taskId")}`));
    const tasks = tasksSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.active !== false && t.recurring && !t.special);
    const claimed = new Set((await famRef.collection("log").where("type", "==", "special").get()).docs.map((d) => `${d.get("kidId")}|${d.get("taskId")}`));
    for (const [kidId, kid] of kids) {
      const mine = tasks.filter((t) => !t.kidIds?.length || t.kidIds.includes(kidId));
      const left = mine.filter((t) => !marked.has(`${kidId}|${t.id}`)).length;
      const tomorrow = new Date(`${date}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tom = tomorrow.toISOString().slice(0, 10);
      const soon = specials.filter((t) => (t.deadline === date || t.deadline === tom) && (!t.kidIds?.length || t.kidIds.includes(kidId)) && !claimed.has(`${kidId}|${t.id}`));
      if (!left && !soon.length) continue;
      const lines = [];
      if (left) lines.push(left === 1
        ? "Falta 1 tarefa de hoje. Já a fizeste? Marca-a na app antes de dormir."
        : `Faltam ${left} tarefas de hoje. Já as fizeste? Marca-as na app antes de dormir.`);
      for (const t of soon) lines.push(`🚀 A missão "${t.title}" acaba ${t.deadline === date ? "hoje" : "amanhã"}!`);
      await send(fam, kidTokens(kidId), { title: `⏰ ${kid.name}, ainda tens tarefas!`, body: lines.join("\n"), tag: `lembrete-${kidId}` });
    }
    await famRef.update({ "notify.lastReminderDate": date });
  }

  if (firstRun) await famRef.update({ "notify.initialized": true });
}

const families = await db.collection("families").get();
let failed = 0;
for (const fam of families.docs) {
  try { await processFamily(fam); } catch (e) { failed++; console.error(`[${fam.id}] erro:`, e); }
}
console.log(`Feito: ${families.size} família(s)${failed ? `, ${failed} com erro` : ""}.`);
if (failed) process.exitCode = 1;
