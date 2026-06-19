// Persistência simples do CRM de recuperação (JSON em disco).
// Shim de desenvolvimento — mesma interface migra pra Postgres/Prisma no deploy.
// Estados: DETECTADO → ABORDADO → EM_CONVERSA → OBJECAO → RECUPERADO / PERDIDO / ESCALADO
const fs = require("fs");
const path = require("path");

// DATA_DIR aponta pro disco persistente do Railway em produção (ex.: /data)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "store.json");

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return { leads: {} }; }
}
function persist(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}
function nowISO(ms) { return new Date(ms).toISOString(); } // ms passado de fora (server controla o relógio)
function normPhone(p) { return String(p || "").replace(/\D/g, ""); }

// Cria/atualiza lead por telefone. `ts` = timestamp em ms (server passa Date.now()).
function upsertLead(partial, ts) {
  const db = load();
  const phone = normPhone(partial.phone);
  if (!phone) throw new Error("upsertLead sem phone");
  const existing = db.leads[phone];
  if (!existing) {
    db.leads[phone] = {
      phone,
      firstName: partial.firstName || "amiga",
      product: partial.product || "ingresso",      // ingresso | mentoria
      gatilho: partial.gatilho || "ingresso_abandono",
      value: partial.value || 0,
      sck: partial.sck || null,                      // atribuição de recuperação
      state: "DETECTADO",
      optout: false,
      messages: [],
      createdAt: nowISO(ts),
      updatedAt: nowISO(ts),
      firstTouchAt: null,
      respondedAt: null,
      recoveredAt: null,
      recoveredValue: 0,
      escalatedAt: null,
    };
  } else {
    // só preenche campos novos sem apagar histórico
    for (const k of ["firstName", "product", "gatilho", "value", "sck"]) {
      if (partial[k] != null && (existing[k] == null || existing[k] === "" || existing[k] === 0)) existing[k] = partial[k];
    }
    existing.updatedAt = nowISO(ts);
  }
  persist(db);
  return db.leads[phone];
}

function getLead(phone) { return load().leads[normPhone(phone)] || null; }

function appendMessage(phone, role, content, ts) {
  const db = load();
  const lead = db.leads[normPhone(phone)];
  if (!lead) return null;
  lead.messages.push({ role, content, ts: nowISO(ts) });
  if (role === "user" && !lead.respondedAt) lead.respondedAt = nowISO(ts);
  lead.updatedAt = nowISO(ts);
  persist(db);
  return lead;
}

function setState(phone, state, ts, extra = {}) {
  const db = load();
  const lead = db.leads[normPhone(phone)];
  if (!lead) return null;
  lead.state = state;
  if (state === "ESCALADO" && !lead.escalatedAt) lead.escalatedAt = nowISO(ts);
  if (extra.optout) lead.optout = true;
  if (extra.firstTouch && !lead.firstTouchAt) lead.firstTouchAt = nowISO(ts);
  lead.updatedAt = nowISO(ts);
  persist(db);
  return lead;
}

function markRecovered(phone, value, ts) {
  const db = load();
  const lead = db.leads[normPhone(phone)];
  if (!lead) return null;
  lead.state = "RECUPERADO";
  lead.recoveredAt = nowISO(ts);
  lead.recoveredValue = value || lead.value || 0;
  lead.updatedAt = nowISO(ts);
  persist(db);
  return lead;
}

function allLeads() { return Object.values(load().leads); }

function metrics() {
  const leads = allLeads();
  const m = {
    detectados: leads.length,
    abordados: leads.filter(l => l.firstTouchAt).length,
    responderam: leads.filter(l => l.respondedAt).length,
    em_conversa: leads.filter(l => ["EM_CONVERSA", "OBJECAO"].includes(l.state)).length,
    recuperados: leads.filter(l => l.state === "RECUPERADO").length,
    perdidos: leads.filter(l => l.state === "PERDIDO").length,
    escalados: leads.filter(l => l.state === "ESCALADO").length,
    optouts: leads.filter(l => l.optout).length,
    faturamento_recuperado: leads.reduce((s, l) => s + (l.recoveredValue || 0), 0),
  };
  m.taxa_resposta = m.detectados ? +(100 * m.responderam / m.detectados).toFixed(1) : 0;
  m.taxa_recuperacao = m.detectados ? +(100 * m.recuperados / m.detectados).toFixed(1) : 0;
  m.por_produto = {
    ingresso: leads.filter(l => l.product === "ingresso").length,
    mentoria: leads.filter(l => l.product === "mentoria").length,
  };
  return m;
}

module.exports = { upsertLead, getLead, appendMessage, setState, markRecovered, allLeads, metrics, normPhone };
