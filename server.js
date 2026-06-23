// Recuperador de Vendas IA — microserviço (Sonia / IREC 2).
// Cano: ManyChat (transporte) · Cérebro+dados+métricas: AQUI.
// Zero dependências: Node 22 (fetch nativo).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { GATILHOS, systemPrompt } = require("./knowledge");
const store = require("./store");
const hotmart = require("./hotmart");
const manychat = require("./manychat");

// --- env ---
function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return env;
}
// process.env tem precedência (Railway injeta env vars; local usa o .env)
const ENV = { ...loadEnv(), ...process.env };
const API_KEY = ENV.ANTHROPIC_API_KEY;
const MODEL = ENV.MODEL || "claude-sonnet-4-6";
const PORT = ENV.PORT || 3030;
const HOTMART_HOTTOK = ENV.HOTMART_HOTTOK || ENV.HOTTOK || null; // aceita os dois nomes; valida assinatura quando setado
if (!API_KEY) console.warn("[aviso] ANTHROPIC_API_KEY ausente — o servidor sobe, mas as respostas da IA falham até a chave ser configurada.");

// Rede de seguranca: nada derruba o processo. Captura o ultimo erro pra diagnostico remoto.
let lastError = null;
function recordErr(type, e) {
  lastError = { when: new Date(Date.now()).toISOString(), type, msg: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 1000) };
  console.error(`[${type}]`, e);
}
process.on("uncaughtException", e => recordErr("uncaughtException", e));
process.on("unhandledRejection", e => recordErr("unhandledRejection", e));

// produtos IREC 2 (Hotmart) → tipo
const PRODUCT_MAP = { "7860446": "ingresso", "7016784": "mentoria" };
let lastHotmart = null; // último payload cru recebido (pra confirmar o shape real)
let lastReplyHit = null; // grampo: último request cru ao /api/reply (debug da ponte ManyChat)

async function callClaude(system, messages) {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY ausente no ambiente");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, system, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve) => {
    let raw = ""; req.on("data", c => (raw += c));
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
  });
}
function escalated(reply) { return /pessoa da minha equipe te chamar/i.test(reply); }
function isOptout(text) { return /^\s*sair\s*$/i.test(text || ""); }

// garante E.164 do Brasil (prefixo 55) pro WhatsApp
function toE164BR(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("55") && d.length >= 12) return d;
  if (d.length === 10 || d.length === 11) return "55" + d;
  return d;
}

// --- normaliza payload da Hotmart (shape CONFIRMADO no teste real 19/06; Webhook 2.0) ---
function parseHotmart(p) {
  const data = p.data || p;
  const purchase = data.purchase || {};
  const buyer = data.buyer || {};
  const product = data.product || {};
  const productId = String(product.id || purchase.product_id || p.product_id || "");
  const productType = PRODUCT_MAP[productId] || (p.product || "ingresso");
  const status = (p.event || purchase.status || p.status || "").toUpperCase();
  const phone = toE164BR(buyer.checkout_phone || buyer.phone || p.phone || "");
  const firstName = (buyer.first_name || buyer.name || p.firstName || p.name || "amiga").split(" ")[0];
  const value = (purchase.price && purchase.price.value) || p.value || 0;
  const sck = (purchase.tracking && purchase.tracking.source_sck) || purchase.sckPaymentLink || p.sck || null;

  let gatilho = null, kind = null;
  if (/APPROVED|COMPLETE/.test(status)) kind = "venda";
  else if (/OUT_OF_SHOPPING_CART|ABANDON/.test(status)) { kind = "detect"; gatilho = `${productType}_abandono`; }
  else if (/PIX/.test(status) || p.event === "pix") { kind = "detect"; gatilho = productType === "mentoria" ? "mentoria_pix" : "ingresso_pix"; }
  else if (/BILLET|BOLETO/.test(status) || p.event === "boleto") { kind = "detect"; gatilho = productType === "mentoria" ? "mentoria_boleto" : "ingresso_boleto"; }
  else if (/CANCEL|REFUSED|CARTAO/.test(status) || p.event === "cartao") { kind = "detect"; gatilho = "ingresso_cartao"; }
  return { kind, phone, firstName, product: productType, gatilho, value, sck, status };
}

// --- 1º TOQUE via ManyChat (template aprovado) ---
const FLOW_NS_PIX = ENV.FLOW_NS_PIX || "content20260622165339_068522"; // fluxo "Recuperação Pix - IREC 02"
const FIRST_TOUCH = ENV.FIRST_TOUCH_ENABLED === "true"; // trava: só dispara automático quando ligado

// --- VIGIA DE PIX/BOLETO PENDENTE (recuperação ativa via API Hotmart) ---
const POLL_PRODUCTS = [7860446]; // ingresso IREC (mentoria 7016784 entra na Fase 3)
async function runRecoveryPoll() {
  const now = Date.now();
  const novos = [];
  const erros = [];
  for (const pid of POLL_PRODUCTS) {
    let pend = [];
    try { pend = await hotmart.pendingPayments(pid); }
    catch (e) { erros.push(`produto ${pid}: ${e.message}`); console.warn("[poll] hotmart falhou:", e.message); continue; }
    for (const rec of pend) {
      try {
        const phone = toE164BR(rec.phone);
        if (!phone || store.getLead(phone)) continue; // já detectado
        const ptype = PRODUCT_MAP[String(rec.productId)] || "ingresso";
        const method = String(rec.paymentType || "PIX").toUpperCase().includes("BILLET") ? "boleto" : "pix";
        const gatilho = `${ptype}_${method}`;
        store.upsertLead({ phone, firstName: rec.firstName, product: ptype, gatilho, value: rec.value, offer: rec.offer, sck: "recuperacao" }, now);
        novos.push({ phone, nome: rec.firstName, gatilho, transacao: rec.transaction });
        // 1º toque automático (só pix por enquanto, e só se a trava estiver ligada)
        if (FIRST_TOUCH && gatilho === "ingresso_pix") {
          try {
            await manychat.firstTouch({ phone, firstName: rec.firstName, flowNs: FLOW_NS_PIX });
            store.setState(phone, "ABORDADO", now, { firstTouch: true });
          } catch (e) { erros.push(`firstTouch ${phone}: ${e.message}`); }
        }
      } catch (e) { console.warn("[poll] registro falhou:", e.message); }
    }
  }
  if (novos.length) console.log("[poll] novos pendentes:", JSON.stringify(novos));
  return { novos, erros };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];

    if (req.method === "GET" && (url === "/" || url === "/index.html"))
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url === "/crm")
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "crm.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url === "/api/gatilhos")
      return send(res, 200, Object.entries(GATILHOS).map(([k, v]) => ({ key: k, rotulo: v.rotulo, abertura: v.abertura })));
    if (req.method === "GET" && url === "/api/metrics")
      return send(res, 200, store.metrics());
    if (req.method === "GET" && url === "/api/leads")
      return send(res, 200, store.allLeads());
    if (req.method === "GET" && url === "/api/_lasthook") {
      const key = new URLSearchParams(req.url.split("?")[1] || "").get("key");
      if (key !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      return send(res, 200, lastHotmart || { vazio: true });
    }
    if (req.method === "GET" && url === "/api/_lastreply") {
      const key = new URLSearchParams(req.url.split("?")[1] || "").get("key");
      if (key !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      return send(res, 200, lastReplyHit || { vazio: true, nota: "nenhum POST chegou no /api/reply ainda" });
    }
    if (req.method === "GET" && url === "/api/_env") {
      const key = new URLSearchParams(req.url.split("?")[1] || "").get("key");
      if (key !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      return send(res, 200, {
        DATA_DIR: process.env.DATA_DIR || "(NAO setado -> usa ./data EFEMERO)",
        MODEL: ENV.MODEL || "(default)",
        hottokSet: !!HOTMART_HOTTOK,
        anthropicSet: !!API_KEY,
        manychatSet: !!ENV.MANYCHAT_API_TOKEN,
        hotmartSet: !!(ENV.HOTMART_CLIENT_ID && ENV.HOTMART_CLIENT_SECRET),
        leads: store.allLeads().length,
        lastError,
      });
    }
    if (req.method === "GET" && url === "/api/_poll") {
      const key = new URLSearchParams(req.url.split("?")[1] || "").get("key");
      if (key !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      const r = await runRecoveryPoll();
      return send(res, 200, { ok: true, ...r });
    }
    if (req.method === "GET" && url === "/api/_firsttouch") {
      const q = new URLSearchParams(req.url.split("?")[1] || "");
      if (q.get("key") !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      const phone = toE164BR(q.get("phone") || "");
      const name = q.get("name") || "amiga";
      if (!phone) return send(res, 400, { error: "phone obrigatório" });
      try { const id = await manychat.firstTouch({ phone, firstName: name, flowNs: FLOW_NS_PIX }); return send(res, 200, { ok: true, subscriberId: id, phone }); }
      catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    // --- SEED de teste: cria lead com gatilho escolhido + dispara 1º toque (bancada ponta-a-ponta) ---
    if (req.method === "GET" && url === "/api/_seed") {
      const q = new URLSearchParams(req.url.split("?")[1] || "");
      if (q.get("key") !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      const now = Date.now();
      const phone = toE164BR(q.get("phone") || "");
      const name = q.get("name") || "amiga";
      const gatilho = GATILHOS[q.get("gatilho")] ? q.get("gatilho") : "ingresso_pix";
      const product = gatilho.startsWith("mentoria") ? "mentoria" : "ingresso";
      const fire = q.get("fire") !== "false"; // por padrão dispara o template
      if (!phone) return send(res, 400, { error: "phone obrigatório" });
      store.upsertLead({ phone, firstName: name, product, gatilho, value: Number(q.get("value") || 0), sck: "teste" }, now);
      let ft = null;
      if (fire) {
        try { const id = await manychat.firstTouch({ phone, firstName: name, flowNs: FLOW_NS_PIX }); store.setState(phone, "ABORDADO", now, { firstTouch: true }); ft = { ok: true, subscriberId: id }; }
        catch (e) { ft = { ok: false, error: e.message }; }
      }
      return send(res, 200, { ok: true, phone, gatilho, firstTouch: ft });
    }

    // --- SIMULADOR (stateless) — mantém a bancada de teste do cérebro ---
    if (req.method === "POST" && url === "/api/chat") {
      const { gatilho, messages } = await readJson(req);
      if (!GATILHOS[gatilho]) return send(res, 400, { error: "gatilho inválido" });
      const lastUser = [...(messages || [])].reverse().find(m => m.role === "user");
      if (lastUser && isOptout(lastUser.content))
        return send(res, 200, { reply: "Tudo bem, amiga. Não te chamo mais por aqui. Qualquer dia que quiser, é só me responder. Um beijo.", status: "optout" });
      const reply = await callClaude(systemPrompt(gatilho), messages);
      return send(res, 200, { reply, status: escalated(reply) ? "escalado" : "em_conversa" });
    }

    // --- WEBHOOK HOTMART: detecta abandono OU marca venda recuperada ---
    if (req.method === "POST" && url === "/webhook/hotmart") {
      const now = Date.now();
      const payload = await readJson(req);
      const hottokOk = !HOTMART_HOTTOK || req.headers["x-hotmart-hottok"] === HOTMART_HOTTOK;
      lastHotmart = { recebidoEm: new Date(Date.now()).toISOString(), hottokOk, headers: req.headers, payload };
      if (!hottokOk) return send(res, 401, { error: "hottok inválido" });
      const e = parseHotmart(payload);
      if (e.kind === "venda") {
        const lead = store.getLead(e.phone);
        if (lead) { store.markRecovered(e.phone, e.value, now); return send(res, 200, { ok: true, action: "recuperado", phone: store.normPhone(e.phone) }); }
        return send(res, 200, { ok: true, action: "venda_sem_lead" });
      }
      if (e.kind === "detect" && e.phone) {
        store.upsertLead({ phone: e.phone, firstName: e.firstName, product: e.product, gatilho: e.gatilho, value: e.value, sck: e.sck }, now);
        // TODO: aqui dispara o 1º toque via ManyChat (sendFlow do template) quando o fluxo estiver montado.
        return send(res, 200, { ok: true, action: "detectado", gatilho: e.gatilho });
      }
      return send(res, 200, { ok: true, action: "ignorado", status: e.status });
    }

    // --- CONVERSA STATEFUL: contrato do External Request do ManyChat ---
    // body: { phone, firstName?, text }  → { reply, status }
    if (req.method === "POST" && url === "/api/reply") {
      const now = Date.now();
      const body = await readJson(req);
      const { phone, firstName, text } = body || {};
      lastReplyHit = { recebidoEm: new Date(now).toISOString(), ua: req.headers["user-agent"] || null, contentType: req.headers["content-type"] || null, body, parsed: { phone: phone || null, firstName: firstName || null, text: text || null } };
      if (!phone || !text) return send(res, 400, { error: "phone e text obrigatórios", recebido: body });
      let lead = store.getLead(phone) || store.upsertLead({ phone, firstName, gatilho: "ingresso_abandono", product: "ingresso" }, now);
      if (lead.optout) return send(res, 200, { reply: "", status: "optout" });

      store.appendMessage(phone, "user", text, now);
      if (isOptout(text)) {
        store.setState(phone, "PERDIDO", now, { optout: true });
        const bye = "Tudo bem, amiga. Não te chamo mais por aqui. Qualquer dia que quiser, é só me responder. Um beijo.";
        store.appendMessage(phone, "assistant", bye, now);
        return send(res, 200, { reply: bye, status: "optout" });
      }

      // re-busca o lead pra incluir a msg recem-adicionada; historico SEMPRE termina em user
      lead = store.getLead(phone);
      const history = lead.messages.map(m => ({ role: m.role, content: m.content }));
      const reply = await callClaude(systemPrompt(lead.gatilho, lead), history);
      store.appendMessage(phone, "assistant", reply, now);
      const st = escalated(reply) ? "escalado" : "em_conversa";
      store.setState(phone, st === "escalado" ? "ESCALADO" : "EM_CONVERSA", now);
      return send(res, 200, { reply, status: st });
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`Recuperador no ar em http://localhost:${PORT}  (sim: /  ·  crm: /crm)  |  modelo ${MODEL}`));

// vigia automático de pix/boleto pendente
const POLL_MIN = Number(ENV.POLL_MIN || 5);
if (ENV.HOTMART_CLIENT_ID && ENV.HOTMART_CLIENT_SECRET) {
  setInterval(() => runRecoveryPoll().catch(e => console.warn("[poll]", e.message)), POLL_MIN * 60 * 1000);
  console.log(`[poll] vigia de pix/boleto pendente ATIVO a cada ${POLL_MIN} min`);
} else {
  console.warn("[poll] HOTMART_CLIENT_ID/SECRET ausentes — vigia desligado");
}
