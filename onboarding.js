// Onboarding de compradoras da imersão (compra aprovada → boas-vindas + link do grupo no WhatsApp).
// Porta o cenário 9452875 do Make pra dentro da Rosa (o Make pausou por teto de operações em 08/07
// e deixou compradoras sem disparo). Cadeia: resolveId (acha/cria subscriber + custom field)
// → tag comprou_irec2 → sendFlow do template de confirmação. Idempotente por telefone
// (onboarding.json no DATA_DIR) — o webhook da Hotmart reenvia eventos e o backfill pode repetir.
const fs = require("fs");
const path = require("path");
const manychat = require("./manychat");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "onboarding.json");

// Flow "Confirmação de Compra IREC 2" no ManyChat (o mesmo que o Make disparava).
const FLOW_NS_ONBOARDING = process.env.FLOW_NS_ONBOARDING || "content20260628194307_289533";
const TAG_COMPROU = process.env.ONBOARDING_TAG || "comprou_irec2";
// Ligado por padrão: substitui um fluxo que JÁ rodava em produção (não é feature nova).
const ENABLED = process.env.ONBOARDING_ENABLED !== "false";

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
}
let db = load();
function save() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error("[onboarding] save falhou:", e.message); }
}

const key = (phone) => String(phone || "").replace(/\D/g, "").slice(-8);

// Normaliza pro E.164 BR (mesma regra do toE164BR do server): a Hotmart manda o telefone
// SEM o 55 (ex.: "18996084180") — sem isso o ManyChat criaria número dos EUA (+1...).
function toE164BR(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  d = d.replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) return "55" + d;
  if (d.startsWith("55") && d.length >= 12) return d;
  return d;
}

// Envia o onboarding pra UMA compradora. Idempotente: se já enviado, retorna {skip:"ja_enviado"}.
// Registra falha (com motivo) sem retentar sozinho — reprocesso via /api/_onboard_backfill.
async function onboardBuyer({ phone, firstName, transaction, source }) {
  const e164 = toE164BR(phone);
  const k = key(e164);
  if (!k || k.length < 8 || e164.length < 12) return { ok: false, skip: "sem_telefone", phone: String(phone) };
  if (db[k] && db[k].sentAt) return { ok: true, skip: "ja_enviado", sentAt: db[k].sentAt };
  if (!ENABLED) return { ok: false, skip: "desligado" };
  const entry = { phone: e164, firstName: firstName || "amiga", transaction: transaction || null, source: source || "webhook", attempts: ((db[k] && db[k].attempts) || 0) + 1 };
  try {
    const id = await manychat.resolveId(e164, entry.firstName);
    try { await manychat.addTagByName(id, TAG_COMPROU); } catch (e) { /* tag é acessório, não bloqueia o flow */ }
    await manychat.sendFlow(id, FLOW_NS_ONBOARDING);
    db[k] = { ...entry, subscriberId: id, sentAt: new Date().toISOString(), error: null };
    save();
    return { ok: true, subscriberId: id };
  } catch (e) {
    db[k] = { ...entry, sentAt: null, error: e.message, errorAt: new Date().toISOString() };
    save();
    return { ok: false, error: e.message };
  }
}

function metrics() {
  const all = Object.values(db);
  return {
    enabled: ENABLED,
    flowNs: FLOW_NS_ONBOARDING,
    total: all.length,
    enviados: all.filter(x => x.sentAt).length,
    falhas: all.filter(x => !x.sentAt && x.error).length,
    ultimoEnvio: all.filter(x => x.sentAt).map(x => x.sentAt).sort().pop() || null,
    falhasDetalhe: all.filter(x => !x.sentAt && x.error).map(x => ({ phone: x.phone, nome: x.firstName, erro: String(x.error).slice(0, 90) })),
  };
}

const alreadySent = (phone) => Boolean(db[key(phone)] && db[key(phone)].sentAt);

module.exports = { onboardBuyer, metrics, alreadySent };
