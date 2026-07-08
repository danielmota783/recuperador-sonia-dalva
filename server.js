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
const sendflow = require("./sendflow");

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
let lastUsage = null; // última usage do Claude (pra confirmar que o cache do prompt pegou)
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
const BUILD = "retry-touch-v2"; // marcador de deploy (pra confirmar qual versão está no ar)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function backoff(attempt) { return Math.min(8000, 600 * Math.pow(2, attempt)) + Math.floor(Math.random() * 400); }

// Chama o Claude com RETRY/BACKOFF: 429 (rate limit), 529 (overloaded), 5xx e erro de rede
// são transitórios → espera e tenta de novo (respeita Retry-After). Sem isso, um único engasgo
// do Claude derrubava a resposta da Rosa e o lead ficava órfão (bug do disparo de 30/06).
async function callClaude(system, messages) {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY ausente no ambiente");
  const MAX = 4;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX; attempt++) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        // CACHE DE PROMPT: o system (cérebro ~4.4k tokens) é sempre igual → guarda processado 5min.
        // Chamadas seguintes leem por 1/10 do preço. NÃO muda nada no que a Rosa recebe/responde.
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 600,
          system: typeof system === "string" ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system,
          messages,
        }),
      });
    } catch (e) { // erro de rede/conexão
      lastErr = e;
      if (attempt < MAX) { console.warn(`[claude] rede ${e.message} — retry ${attempt + 1}/${MAX}`); await sleep(backoff(attempt)); continue; }
      throw e;
    }
    if (res.ok) {
      const data = await res.json();
      lastUsage = data.usage || null;
      return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    }
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt < MAX) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = ra > 0 ? ra * 1000 : backoff(attempt);
      console.warn(`[claude] ${res.status} — retry ${attempt + 1}/${MAX} em ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Anthropic ${res.status}: ${body}`);
  }
  throw lastErr || new Error("Anthropic: falha após retries");
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve) => {
    let raw = ""; req.on("data", c => (raw += c));
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
  });
}
function escalated(reply) { return /pessoa da (minha )?equipe te chamar/i.test(reply); }
function isOptout(text) { return /^\s*sair\s*$/i.test(text || ""); }

// rate limit simples por IP pro chat público (widget da página) — anti-abuso/custo
const chatHits = new Map();
function chatRateLimited(ip) {
  const now = Date.now(), win = 5 * 60 * 1000, max = 40;
  const arr = (chatHits.get(ip) || []).filter(t => now - t < win);
  arr.push(now);
  chatHits.set(ip, arr);
  if (chatHits.size > 5000) chatHits.clear(); // backstop de memória
  return arr.length > max;
}

// garante E.164 do Brasil (prefixo 55) pro WhatsApp
function toE164BR(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (!d) return "";
  // já vem certo: 55 + DDD(2) + 8/9 dígitos (12 ou 13 no total)
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  d = d.replace(/^0+/, ""); // tira 0 de operadora/DDD na frente (ex.: 032..., 065..., 098...)
  if (d.length === 10 || d.length === 11) return "55" + d; // nacional: DDD + número → prefixa país
  if (d.startsWith("55") && d.length >= 12) return d;       // já tem país, tamanho atípico → devolve p/ validação externa
  return d;
}
// erro do ManyChat quando o número é MORTO de verdade (não é WhatsApp). "already exists" NÃO conta:
// esse contato é alcançável, só não foi achado pelos lookups — não marcar como inválido.
function isInvalidWhatsapp(msg) { return /not a valid WhatsApp ID/i.test(msg || ""); }

// Sanitiza o 1º nome p/ mensagem (muitos vêm como email, @handle colado ou com emoji).
// Tudo que não for nome de gente confiável vira "amiga" — melhor que "Oi, fulano@gmail.com!".
function cleanName(raw) {
  let s = String(raw || "").trim();
  if (!s || /@/.test(s)) return "amiga";                       // vazio ou email
  s = s.replace(/[^\p{L}\p{M}\s'-]/gu, " ").trim();            // remove emoji/dígitos/símbolos
  s = (s.split(/\s+/)[0] || "");                               // só o primeiro nome
  if (s.length < 2 || s.length > 14) return "amiga";           // curto demais OU handle colado
  if (s.length > 11 && s === s.toLowerCase()) return "amiga";  // blob minúsculo colado
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); // Title-case
}

// identifica leads de teste (pra não sujar métrica de recuperação)
function isTestLead(l) {
  const p = String(l.phone || "");
  return /^5500000000/.test(p) || p === "5599991202143" || p === "5599999999900" || /teste|probe|yascara/i.test(l.firstName || "");
}
// Métricas SÓ de recuperação de vendas (abandono pix/boleto/cartão). Exclui lote_zero e testes.
// Atribui: recuperado COM toque da Rosa (mérito real) vs orgânico (pagou sozinho).
function recoveryMetrics() {
  const isRec = g => /^(ingresso|mentoria)_(pix|boleto|cartao)$/.test(g || "");
  // recuperação genuína: pix/boleto SÓ da vigia (sck="recuperacao"); cartão do webhook.
  // exclui leads pix/boleto que o webhook criou por engano (geração de pagamento ≠ abandono).
  const leads = store.allLeads().filter(l => isRec(l.gatilho) && !isTestLead(l) && (l.sck === "recuperacao" || l.gatilho === "ingresso_cartao"));
  const lastRole = l => { const m = l.messages || []; return m.length ? m[m.length - 1].role : null; };
  const ch = g => leads.filter(l => l.gatilho === g).length;
  const rec = leads.filter(l => l.state === "RECUPERADO");
  const comToque = rec.filter(l => l.firstTouchAt);
  const organico = rec.filter(l => !l.firstTouchAt);
  const sum = arr => arr.reduce((s, l) => s + (l.recoveredValue || 0), 0);
  return {
    updatedAt: new Date(Date.now()).toISOString(),
    detectados: leads.length,
    porCanal: { pix: ch("ingresso_pix"), boleto: ch("ingresso_boleto"), cartao: ch("ingresso_cartao"), mentoria: leads.filter(l => String(l.gatilho).startsWith("mentoria")).length },
    abordados: leads.filter(l => l.firstTouchAt).length,
    responderam: leads.filter(l => l.respondedAt).length,
    emConversa: leads.filter(l => ["EM_CONVERSA", "OBJECAO"].includes(l.state)).length,
    escalados: leads.filter(l => l.state === "ESCALADO").length,
    perdidos: leads.filter(l => l.state === "PERDIDO").length,
    optouts: leads.filter(l => l.optout).length,
    invalidos: leads.filter(l => l.state === "INVALIDO").length, // número inválido no checkout (WhatsApp não alcança)
    ghost: leads.filter(l => lastRole(l) === "user" && !l.optout).length,
    recuperados: {
      total: rec.length, comToque: comToque.length, organico: organico.length,
      valorTotal: sum(rec), valorComToque: sum(comToque), valorOrganico: sum(organico),
    },
    taxaResposta: leads.filter(l => l.firstTouchAt).length ? +(100 * leads.filter(l => l.respondedAt).length / leads.filter(l => l.firstTouchAt).length).toFixed(1) : 0,
  };
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
  // tipo de pagamento (pra distinguir cartão recusado de cancelamento de pix/boleto)
  const payType = String((purchase.payment && purchase.payment.type) || (data.payment && data.payment.type) || p.payment_type || "").toUpperCase();
  const isCard = /CARD|CREDIT|CARTAO/.test(payType);

  let gatilho = null, kind = null;
  if (/APPROVED|COMPLETE/.test(status)) kind = "venda";
  else if (/OUT_OF_SHOPPING_CART|ABANDON/.test(status)) { kind = "detect"; gatilho = `${productType}_abandono`; }
  else if (/PIX/.test(status) || p.event === "pix") { kind = "detect"; gatilho = productType === "mentoria" ? "mentoria_pix" : "ingresso_pix"; }
  else if (/BILLET|BOLETO/.test(status) || p.event === "boleto") { kind = "detect"; gatilho = productType === "mentoria" ? "mentoria_boleto" : "ingresso_boleto"; }
  else if (/CANCEL|REFUSED|CARTAO/.test(status) || p.event === "cartao") {
    // só vira "cartão recusado" se o pagamento foi por CARTÃO; cancelamento de pix/boleto NÃO recebe a msg de cartão
    if (isCard || p.event === "cartao") { kind = "detect"; gatilho = "ingresso_cartao"; }
  }
  return { kind, phone, firstName, product: productType, gatilho, value, sck, status, payType };
}

// --- 1º TOQUE via ManyChat (template aprovado) ---
const FLOW_NS_PIX = ENV.FLOW_NS_PIX || "content20260622165339_068522"; // fluxo "Recuperação Pix - IREC 02"
const FLOW_NS_BOLETO = ENV.FLOW_NS_BOLETO || "content20260701002836_228108"; // fluxo "Recuperação Boleto - IREC 02"
const FLOW_NS_CARTAO = ENV.FLOW_NS_CARTAO || "content20260701003009_307573"; // fluxo "Recuperação Cartão Recusado - IREC 02"
const FIRST_TOUCH = ENV.FIRST_TOUCH_ENABLED === "true"; // trava: só dispara automático quando ligado
// mapa gatilho → flow do 1º toque. Só dispara se o flow existir; cartão/boleto ficam null até o flow ser montado no ManyChat.
const FLOW_NS_BY_GATILHO = { ingresso_pix: FLOW_NS_PIX, ingresso_boleto: FLOW_NS_BOLETO, ingresso_cartao: FLOW_NS_CARTAO };

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
        // 1º toque automático: dispara o flow do gatilho (pix já tem; boleto/cartão quando o flow existir). Gated pela trava.
        const flowNs = FLOW_NS_BY_GATILHO[gatilho];
        if (FIRST_TOUCH && flowNs) {
          try {
            await manychat.firstTouch({ phone, firstName: rec.firstName, flowNs });
            store.setState(phone, "ABORDADO", now, { firstTouch: true });
          } catch (e) { erros.push(`firstTouch ${phone}: ${e.message}`); }
        }
      } catch (e) { console.warn("[poll] registro falhou:", e.message); }
    }
  }
  if (novos.length) console.log("[poll] novos pendentes:", JSON.stringify(novos));
  // auto-cura: retenta o 1º toque de quem ficou preso em DETECTADO (falha transitória ou número a normalizar)
  let retried = [];
  try { retried = await retryStuckTouches(now, 12); } catch (e) { console.warn("[retry-touch]", e.message); }
  return { novos, erros, retried };
}

// Retenta o 1º toque de leads presos em DETECTADO sem firstTouch. Renormaliza o número
// (migrando a chave se corrigir) e marca INVALIDO quando o ManyChat rejeita o WhatsApp.
async function retryStuckTouches(now, cap = 12) {
  if (!FIRST_TOUCH) return [];
  const stuck = store.allLeads().filter(l =>
    l.state === "DETECTADO" && !l.firstTouchAt && !l.optout &&
    (l.sck === "recuperacao" || l.gatilho === "ingresso_cartao") && !isTestLead(l));
  const done = [];
  let n = 0;
  for (const l of stuck) {
    if (n >= cap) break;
    const flowNs = FLOW_NS_BY_GATILHO[l.gatilho];
    if (!flowNs) continue;
    let phone = toE164BR(l.phone);
    if (phone && phone !== l.phone && store.remapPhone(l.phone, phone)) { /* migrado */ }
    else { phone = l.phone; }
    n++;
    try {
      await manychat.firstTouch({ phone, firstName: l.firstName, flowNs });
      store.setState(phone, "ABORDADO", now, { firstTouch: true });
      done.push({ phone, nome: l.firstName, ok: true });
    } catch (e) {
      if (isInvalidWhatsapp(e.message)) { store.setState(phone, "INVALIDO", now); done.push({ phone, nome: l.firstName, invalido: true }); }
      else { done.push({ phone, nome: l.firstName, erro: e.message }); recordErr("retryTouch", e); }
    }
    await sleep(300);
  }
  if (done.length) console.log("[retry-touch]", JSON.stringify(done));
  return done;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];

    if (req.method === "OPTIONS") return send(res, 204, ""); // CORS preflight (widget cross-origin)

    if (req.method === "GET" && (url === "/" || url === "/index.html"))
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url === "/crm")
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "crm.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url === "/widget.js")
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "widget.js"), "utf8"), "application/javascript; charset=utf-8");
    if (req.method === "GET" && url === "/suporte")
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "suporte.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url === "/api/gatilhos")
      return send(res, 200, Object.entries(GATILHOS).map(([k, v]) => ({ key: k, rotulo: v.rotulo, abertura: v.abertura })));
    if (req.method === "GET" && url === "/api/metrics") {
      const key = new URLSearchParams(req.url.split("?")[1] || "").get("key");
      if (key !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      return send(res, 200, store.metrics());
    }
    if (req.method === "GET" && url === "/api/leads") { // PII (telefone + conversa) → exige chave
      const key = new URLSearchParams(req.url.split("?")[1] || "").get("key");
      if (key !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      return send(res, 200, store.allLeads());
    }
    if (req.method === "GET" && url === "/api/recovery") { // métricas de recuperação p/ o painel no Infinitum Launch
      const key = new URLSearchParams(req.url.split("?")[1] || "").get("key");
      if (key !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      return send(res, 200, recoveryMetrics());
    }
    if (req.method === "GET" && url === "/api/_purge_bad_recovery") { // apaga leads pix/boleto criados por engano pelo webhook (sck != recuperacao). dry-run por padrão; confirm=true executa.
      const q = new URLSearchParams(req.url.split("?")[1] || "");
      if (q.get("key") !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      const bad = store.allLeads().filter(l => /_(pix|boleto)$/.test(l.gatilho || "") && l.sck !== "recuperacao" && !isTestLead(l));
      if (q.get("confirm") !== "true") return send(res, 200, { dryRun: true, wouldDelete: bad.length, amostra: bad.slice(0, 5).map(l => ({ nome: l.firstName, phone: l.phone, gatilho: l.gatilho, state: l.state })) });
      let n = 0; for (const l of bad) { if (store.deleteLead(l.phone)) n++; }
      return send(res, 200, { ok: true, deleted: n });
    }
    if (req.method === "GET" && url === "/api/_rescue") { // ressuscita leads ghostados na janela 24h: quem já comprou → fecha; quem não → Rosa reativa
      const q = new URLSearchParams(req.url.split("?")[1] || "");
      if (q.get("key") !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      const now = Date.now(), DIA = 24 * 3600 * 1000, CAP = 80;
      const confirm = q.get("confirm") === "true";
      const lastRole = l => { const m = l.messages || []; return m.length ? m[m.length - 1].role : null; };
      const lastUserTs = l => { const m = l.messages || []; for (let i = m.length - 1; i >= 0; i--) if (m[i].role === "user") return Date.parse(m[i].ts); return 0; };
      // alvo: última msg é do lead (Rosa deve resposta), dentro da janela 24h, não teste, não optout
      const alvo = store.allLeads().filter(l => lastRole(l) === "user" && !l.optout && !isTestLead(l) && (now - lastUserTs(l) <= DIA));
      // quem já comprou o ingresso (Hotmart aprovado, últimas 72h) — casa pelos últimos 8 dígitos do telefone
      const bought = new Set();
      let hotmartOk = false;
      try {
        const tok = await hotmart.token();
        const params = new URLSearchParams({ transaction_status: "APPROVED", product_id: "7860446", start_date: String(now - 72 * 3600 * 1000), end_date: String(now), max_results: "500" }).toString();
        const r = await fetch("https://developers.hotmart.com/payments/api/v1/sales/users?" + params, { headers: { Authorization: "Bearer " + tok } });
        const d = await r.json();
        for (const it of (d.items || [])) {
          const b = (it.users || []).find(u => u.role === "BUYER");
          const ph = String((b && b.user && (b.user.cellphone || b.user.phone)) || "").replace(/\D/g, "");
          if (ph.length >= 8) bought.add(ph.slice(-8));
        }
        hotmartOk = true;
      } catch (e) { console.warn("[rescue] hotmart falhou:", e.message); }
      const jaCompraram = alvo.filter(l => bought.has(String(l.phone).replace(/\D/g, "").slice(-8)));
      const reativar = alvo.filter(l => !bought.has(String(l.phone).replace(/\D/g, "").slice(-8)));
      if (!confirm) return send(res, 200, { dryRun: true, hotmartOk, total: alvo.length, jaCompraram: jaCompraram.length, reativar: reativar.length, amostra: reativar.slice(0, 6).map(l => ({ nome: l.firstName, gatilho: l.gatilho })) });
      let fechados = 0, enviados = 0; const erros = [];
      for (const l of jaCompraram) { store.markRecovered(l.phone, l.value || 9.9, now); fechados++; }
      let c = 0;
      for (const l of reativar) {
        if (c++ >= CAP) break;
        try {
          const lead = store.getLead(l.phone);
          const history = (lead.messages || []).map(m => ({ role: m.role, content: m.content }));
          const reply = await callClaude(systemPrompt(lead.gatilho, lead), history);
          await manychat.sendTextToPhone(lead.phone, reply, lead.firstName);
          store.appendMessage(lead.phone, "assistant", reply, Date.now());
          store.setState(lead.phone, escalated(reply) ? "ESCALADO" : "EM_CONVERSA", Date.now());
          enviados++;
          await sleep(300);
        } catch (e) { erros.push(l.phone + ": " + e.message); }
      }
      return send(res, 200, { ok: true, fechados, enviados, erros });
    }
    if (req.method === "GET" && url === "/api/_retry_touches") { // resgata leads presos em DETECTADO sem 1º toque. dry-run por padrão; confirm=true executa. reset=true reabre os INVALIDO.
      const q = new URLSearchParams(req.url.split("?")[1] || "");
      if (q.get("key") !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      if (q.get("reset") === "true") { // reabre leads marcados INVALIDO por engano (voltam pra fila de toque)
        for (const l of store.allLeads().filter(l => l.state === "INVALIDO" && (l.sck === "recuperacao" || l.gatilho === "ingresso_cartao"))) store.setState(l.phone, "DETECTADO", Date.now());
      }
      const stuck = store.allLeads().filter(l => l.state === "DETECTADO" && !l.firstTouchAt && !l.optout && (l.sck === "recuperacao" || l.gatilho === "ingresso_cartao") && !isTestLead(l));
      if (q.get("confirm") !== "true") return send(res, 200, { dryRun: true, travados: stuck.length, amostra: stuck.slice(0, 20).map(l => ({ nome: l.firstName, phone: l.phone, normalizado: toE164BR(l.phone), gatilho: l.gatilho })) });
      const done = await retryStuckTouches(Date.now(), Number(q.get("cap")) || 30);
      return send(res, 200, { ok: true, tentados: done.length, tocados: done.filter(d => d.ok).length, invalidos: done.filter(d => d.invalido).length, erros: done.filter(d => d.erro), detalhe: done });
    }
    if (req.method === "GET" && url === "/api/_lasthook") {
      const key = new URLSearchParams(req.url.split("?")[1] || "").get("key");
      if (key !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      return send(res, 200, lastHotmart || { vazio: true });
    }
    if (req.method === "GET" && url === "/api/_version") {
      return send(res, 200, { build: BUILD });
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
        firstTouchEnabled: ENV.FIRST_TOUCH_ENABLED === "true",   // 1º toque automático
        flowNsPixSet: !!FLOW_NS_PIX,
        flowNsBoletoSet: !!FLOW_NS_BOLETO,
        flowNsCartaoSet: !!FLOW_NS_CARTAO,
        webhookHotmartRecebido: !!lastHotmart, // Hotmart já postou no /webhook/hotmart? (detecção de cartão depende disso)
        cacheUsage: lastUsage ? { input: lastUsage.input_tokens, cacheWrite: lastUsage.cache_creation_input_tokens, cacheRead: lastUsage.cache_read_input_tokens, output: lastUsage.output_tokens } : null,
        followupEnabled: ENV.FOLLOWUP_ENABLED === "true",
        digestEnabled: ENV.DIGEST_ENABLED === "true",
        sendflowKeySet: !!(process.env.SENDFLOW_API_KEY || ENV.SENDFLOW_API_KEY),
        loteZeroCadenceEnabled: ENV.LOTE_ZERO_CADENCE_ENABLED === "true", // régua lote zero (follow-up 30/06 + vendas 01/07)
        cadenceFollowupAt: (ENV.LZ_FOLLOWUP_AT || "2026-06-30 10:00") + " BRT",
        cadenceSalesAt: (ENV.LZ_SALES_AT || "2026-07-01 08:00") + " BRT",
        leads: store.allLeads().length,
        leadsLoteZero: store.allLeads().filter(l => l.gatilho === "lote_zero").length,
        lastError,
      });
    }
    if (req.method === "GET" && url === "/api/_poll") {
      const key = new URLSearchParams(req.url.split("?")[1] || "").get("key");
      if (key !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      const r = await runRecoveryPoll();
      return send(res, 200, { ok: true, ...r });
    }
    if (req.method === "GET" && url === "/api/_followups") {
      const key = new URLSearchParams(req.url.split("?")[1] || "").get("key");
      if (key !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      const r = await runFollowups();
      return send(res, 200, { ok: true, ...r });
    }
    if (req.method === "GET" && url === "/api/_cadence") { // teste: força um passo da régua lote zero p/ 1 telefone
      const q = new URLSearchParams(req.url.split("?")[1] || "");
      if (q.get("key") !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      const step = q.get("step"), phone = q.get("phone");
      if (!step || !phone) return send(res, 400, { error: "step e phone obrigatórios" });
      const r = await runLoteZeroCadence(step, phone);
      return send(res, 200, { ok: true, ...r });
    }
    if (req.method === "GET" && url === "/api/_digest") {
      const q = new URLSearchParams(req.url.split("?")[1] || "");
      if (q.get("key") !== ENV.MANYCHAT_API_TOKEN) return send(res, 403, { error: "forbidden" });
      const text = buildDigest(Date.now());
      if (q.get("send") === "true") {
        try { await sendflow.sendText(q.get("to") || DIGEST_TO, text); return send(res, 200, { text, sent: true }); }
        catch (e) { return send(res, 200, { text, sent: false, error: e.message }); }
      }
      return send(res, 200, { text, sent: false });
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
      const reset = q.get("reset") === "true";  // zera o lead (conversa limpa) antes de recriar
      if (!phone) return send(res, 400, { error: "phone obrigatório" });
      if (reset) store.deleteLead(phone); // apaga histórico → lead nasce do zero com o gatilho pedido
      store.upsertLead({ phone, firstName: name, product, gatilho, value: Number(q.get("value") || 0), offer: q.get("offer") || null, sck: "teste" }, now);
      let ft = null;
      if (fire) {
        try { const id = await manychat.firstTouch({ phone, firstName: name, flowNs: FLOW_NS_PIX }); store.setState(phone, "ABORDADO", now, { firstTouch: true }); ft = { ok: true, subscriberId: id }; }
        catch (e) { ft = { ok: false, error: e.message }; }
      } else if (reset) {
        store.setState(phone, "ABORDADO", now, { firstTouch: true }); // marca como já abordado, pronto pra conversar
      }
      return send(res, 200, { ok: true, phone, gatilho, reset, firstTouch: ft });
    }

    // --- CHAT STATELESS — simulador interno + widget público da Rosa na página ---
    if (req.method === "POST" && url === "/api/chat") {
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "?";
      if (chatRateLimited(ip)) return send(res, 429, { error: "Muitas mensagens em pouco tempo. Tenta de novo daqui a pouquinho." });
      const { gatilho, messages } = await readJson(req);
      if (!GATILHOS[gatilho]) return send(res, 400, { error: "gatilho inválido" });
      if (!Array.isArray(messages) || messages.length > 40) return send(res, 400, { error: "conversa muito longa" });
      if (messages.some(m => typeof (m && m.content) === "string" && m.content.length > 1500)) return send(res, 400, { error: "mensagem muito longa" });
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
        // Recuperação de pix/boleto é detectada SÓ pela vigia (poll WAITING_PAYMENT): ela espera e só
        // pega o que CONTINUA pendente (abandono real, não pix que paga na hora) e classifica pelo tipo
        // REAL do pagamento. O webhook dispara na GERAÇÃO do pagamento e não sabe o tipo de forma
        // confiável (classificava pix como boleto) → NÃO cria lead pix/boleto aqui. Só cartão e abandono.
        if (/_(pix|boleto)$/.test(e.gatilho)) {
          return send(res, 200, { ok: true, action: "ignorado_pix_boleto_webhook", gatilho: e.gatilho });
        }
        store.upsertLead({ phone: e.phone, firstName: e.firstName, product: e.product, gatilho: e.gatilho, value: e.value, sck: e.sck }, now);
        // 1º toque via ManyChat: dispara o flow do gatilho (cartão), se o flow existir e a trava estiver ligada.
        const flowNs = FLOW_NS_BY_GATILHO[e.gatilho];
        let ft = null;
        if (FIRST_TOUCH && flowNs) {
          try { await manychat.firstTouch({ phone: e.phone, firstName: e.firstName, flowNs }); store.setState(e.phone, "ABORDADO", now, { firstTouch: true }); ft = "enviado"; }
          catch (err) { ft = "erro: " + err.message; }
        }
        return send(res, 200, { ok: true, action: "detectado", gatilho: e.gatilho, firstTouch: ft });
      }
      return send(res, 200, { ok: true, action: "ignorado", status: e.status });
    }

    // --- CONVERSA STATEFUL: contrato do External Request do ManyChat ---
    // body: { phone, firstName?, text, gatilho? }  → { reply, status }
    // gatilho (opcional): define o modo p/ LEAD NOVO (ex.: "lote_zero" na captação). Lead já existente mantém o dele.
    if (req.method === "POST" && url === "/api/reply") {
      const now = Date.now();
      const body = await readJson(req);
      const { phone, firstName, text, gatilho } = body || {};
      lastReplyHit = { recebidoEm: new Date(now).toISOString(), ua: req.headers["user-agent"] || null, contentType: req.headers["content-type"] || null, body, parsed: { phone: phone || null, firstName: firstName || null, text: text || null, gatilho: gatilho || null } };
      if (!phone || !text) return send(res, 400, { error: "phone e text obrigatórios", recebido: body });
      const gNovo = (gatilho && GATILHOS[gatilho]) ? gatilho : "ingresso_abandono";
      const prodNovo = gNovo.startsWith("mentoria") ? "mentoria" : "ingresso";
      let lead = store.getLead(phone) || store.upsertLead({ phone, firstName, gatilho: gNovo, product: prodNovo }, now);
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

// --- RÉGUA DE FOLLOW-UP (2º e 3º toque pra quem recebeu o 1º toque e não respondeu) ---
// Decisão 23/06: 1º toque → 2º (preço vigente) → 3º (link Lote 01 R$14,90) → para.
const FOLLOWUP_ENABLED = ENV.FOLLOWUP_ENABLED === "true";          // trava: só roda quando ligado
const FLOW_NS_FOLLOWUP_2 = ENV.FLOW_NS_FOLLOWUP_2 || null;         // fluxo ManyChat do template irec_ingresso_pendente_2
const FLOW_NS_FOLLOWUP_3 = ENV.FLOW_NS_FOLLOWUP_3 || null;         // fluxo ManyChat do template irec_ingresso_pendente_3
const FU2_DELAY_H = Number(ENV.FU2_DELAY_H || 3);                  // horas após o 1º toque
const FU3_DELAY_H = Number(ENV.FU3_DELAY_H || 20);                 // horas após o 2º toque
const FU_INTERVAL_MIN = Number(ENV.FU_INTERVAL_MIN || 15);         // de quanto em quanto varre
const FU_HOUR_START = Number(ENV.FU_HOUR_START || 8);              // só dispara entre 8h...
const FU_HOUR_END = Number(ENV.FU_HOUR_END || 21);                 // ...e 21h BRT
function horaBRT(ms) { return (new Date(ms).getUTCHours() + 24 - 3) % 24; }

async function runFollowups() {
  if (!FOLLOWUP_ENABLED) return { skip: "desligado" };
  const now = Date.now();
  const h = horaBRT(now);
  if (h < FU_HOUR_START || h >= FU_HOUR_END) return { skip: `fora do horario (${h}h BRT)` };
  const enviados = [];
  for (const lead of store.allLeads()) {
    if (lead.optout || lead.respondedAt) continue;     // respondeu ou saiu → fora da régua (cai na conversa)
    if (lead.state !== "ABORDADO") continue;           // só quem recebeu 1º toque e segue mudo
    const count = lead.followupCount || 0;
    const baseISO = count === 0 ? lead.firstTouchAt : lead.lastFollowupAt;
    if (!baseISO) continue;
    const horas = (now - Date.parse(baseISO)) / 3600000;
    try {
      if (count === 0 && horas >= FU2_DELAY_H && FLOW_NS_FOLLOWUP_2) {
        await manychat.firstTouch({ phone: lead.phone, firstName: lead.firstName, flowNs: FLOW_NS_FOLLOWUP_2 });
        store.recordFollowup(lead.phone, 1, now);
        enviados.push({ phone: lead.phone, toque: 2 });
      } else if (count === 1 && horas >= FU3_DELAY_H && FLOW_NS_FOLLOWUP_3) {
        await manychat.firstTouch({ phone: lead.phone, firstName: lead.firstName, flowNs: FLOW_NS_FOLLOWUP_3 });
        store.recordFollowup(lead.phone, 2, now);
        enviados.push({ phone: lead.phone, toque: 3 });
      } else if (count >= 2 && horas >= FU3_DELAY_H) {
        store.setState(lead.phone, "PERDIDO", now);     // esgotou a régua sem resposta
        enviados.push({ phone: lead.phone, toque: "perdido" });
      }
    } catch (e) { console.warn("[followup]", lead.phone, e.message); }
  }
  if (enviados.length) console.log("[followup]", JSON.stringify(enviados));
  return { enviados };
}

if (FOLLOWUP_ENABLED) {
  setInterval(() => runFollowups().catch(e => console.warn("[followup]", e.message)), FU_INTERVAL_MIN * 60 * 1000);
  console.log(`[followup] régua ATIVA (varre ${FU_INTERVAL_MIN}/${FU_INTERVAL_MIN}min; 2º toque +${FU2_DELAY_H}h, 3º toque +${FU3_DELAY_H}h, ${FU_HOUR_START}-${FU_HOUR_END}h BRT)`);
} else {
  console.warn("[followup] régua DESLIGADA (FOLLOWUP_ENABLED!=true)");
}

// --- DIGEST DIÁRIO (resumo de métricas no WhatsApp do Daniel, via SendFlow) ---
const DIGEST_ENABLED = ENV.DIGEST_ENABLED === "true";
const DIGEST_TO = ENV.DIGEST_TO || "5599991202143";       // Daniel
const DIGEST_HOUR = Number(ENV.DIGEST_HOUR || 23);        // 23h...
const DIGEST_MIN = Number(ENV.DIGEST_MIN || 59);          // ...:59 BRT (fecha o dia todo)
let lastDigestYMD = null;
function brtYMD(ms) { return new Date(ms - 3 * 3600000).toISOString().slice(0, 10); }
function brl(v) { return "R$ " + Number(v || 0).toFixed(2).replace(".", ","); }

function buildDigest(now) {
  const leads = store.allLeads();
  const m = store.metrics();
  const today = brtYMD(now);
  const novosHoje = leads.filter(l => l.createdAt && brtYMD(Date.parse(l.createdAt)) === today).length;
  const recHoje = leads.filter(l => l.recoveredAt && brtYMD(Date.parse(l.recoveredAt)) === today);
  const fatHoje = recHoje.reduce((s, l) => s + (l.recoveredValue || 0), 0);
  const [Y, Mo, D] = today.split("-");
  // SEM linhas em branco (\n\n) — o SendFlow quebra em mensagens separadas a cada parágrafo.
  return [
    `📊 Recuperador IREC 2 — ${D}/${Mo}`,
    `*Hoje:* ${novosHoje} detectados · ${recHoje.length} recuperados (${brl(fatHoje)})`,
    `———`,
    `*Acumulado:*`,
    `• Detectados: ${m.detectados}`,
    `• Abordados: ${m.abordados}`,
    `• Responderam: ${m.responderam} (${m.taxa_resposta}%)`,
    `• Em conversa: ${m.em_conversa}`,
    `• Recuperados: ${m.recuperados} (${m.taxa_recuperacao}%)`,
    `• Perdidos: ${m.perdidos} · Escalados: ${m.escalados} · Saíram: ${m.optouts}`,
    `• Faturamento recuperado: ${brl(m.faturamento_recuperado)}`,
  ].join("\n");
}

async function maybeSendDigest() {
  if (!DIGEST_ENABLED) return;
  const now = Date.now();
  if (horaBRT(now) !== DIGEST_HOUR || new Date(now).getUTCMinutes() < DIGEST_MIN) return; // só no :59
  const ymd = brtYMD(now);
  if (lastDigestYMD === ymd) return;       // já enviou hoje
  lastDigestYMD = ymd;
  try { await sendflow.sendText(DIGEST_TO, buildDigest(now)); console.log("[digest] enviado pro", DIGEST_TO); }
  catch (e) { lastDigestYMD = null; console.warn("[digest]", e.message); } // libera retry no próximo tick
}

if (DIGEST_ENABLED) {
  setInterval(() => maybeSendDigest().catch(e => console.warn("[digest]", e.message)), 60 * 1000); // 1 min, pra acertar o :59
  console.log(`[digest] digest diário ATIVO (${DIGEST_HOUR}:${String(DIGEST_MIN).padStart(2, "0")} BRT → ${DIGEST_TO})`);
} else {
  console.warn("[digest] digest DESLIGADO (DIGEST_ENABLED!=true)");
}

// --- RÉGUA DE LOTE ZERO (mensagens livres agendadas, DENTRO da janela 24h, sem template) ---
// Decisão Daniel (29/06): 30/06 10h follow-up (gera nova interação) → 01/07 09h disparo do link de vendas.
const LOTE_ZERO_CADENCE = ENV.LOTE_ZERO_CADENCE_ENABLED === "true"; // trava: só roda quando ligado
const SALES_LINK_LZ = ENV.SALES_LINK_LZ || "https://pay.hotmart.com/V106097949E?off=ayu3i3k8&sck=lote_zero";
function brtToMs(s) { // "AAAA-MM-DD HH:MM" em BRT → ms UTC (BRT = UTC-3)
  const [d, t] = s.split(" "); const [Y, M, D] = d.split("-").map(Number); const [h, mi] = t.split(":").map(Number);
  return Date.UTC(Y, M - 1, D, h + 3, mi, 0);
}
const CADENCE_EVENTS = [
  { id: "lz_followup", at: brtToMs(ENV.LZ_FOLLOWUP_AT || "2026-06-30 10:00"),
    msg: (n) => `Oi, ${n}! Passando para te lembrar de uma coisa importante.\n\nAs inscrições da Imersão Renda Extra com Crochê abrem amanhã, quarta, dia 01/07, às 8h.\n\nQuem está no grupo do lote zero garante o menor preço de todos.\n\nMe responde aqui com um "EU QUERO" que amanhã, 8h em ponto, eu te mando o link em primeira mão. 💛` },
  { id: "lz_sales", at: brtToMs(ENV.LZ_SALES_AT || "2026-07-01 08:00"),
    msg: (n) => `Chegou a hora, ${n}!\n\nAs inscrições da Imersão Renda Extra com Crochê estão abertas.\n\nO lote zero, o menor preço de todos por R$ 9,90, já está no ar — por pouquíssimo tempo.\n\nGarante o seu agora:\n${SALES_LINK_LZ}` },
];
function lastUserTs(lead) {
  const m = lead.messages || [];
  for (let i = m.length - 1; i >= 0; i--) if (m[i].role === "user") return Date.parse(m[i].ts);
  return lead.respondedAt ? Date.parse(lead.respondedAt) : 0;
}
// Envia um passo da régua aos leads de lote zero DENTRO da janela 24h. forceId+onlyPhone = teste (ignora gate/janela).
async function runLoteZeroCadence(forceId, onlyPhone) {
  const now = Date.now(), JANELA = 24 * 3600 * 1000, GRACE = 3 * 3600 * 1000, CAP = 30;
  const enviados = [];
  for (const ev of CADENCE_EVENTS) {
    if (forceId) { if (ev.id !== forceId) continue; }
    else if (now < ev.at || now > ev.at + GRACE) continue; // só dentro da janela do evento
    let sent = 0;
    for (const lead of store.allLeads()) {
      if (lead.gatilho !== "lote_zero" || lead.optout) continue;
      if (onlyPhone && !String(lead.phone).endsWith(String(onlyPhone).replace(/\D/g, "").slice(-8))) continue;
      if (!forceId && lead.cadence && lead.cadence[ev.id]) continue;      // já enviado
      if (!onlyPhone && (now - lastUserTs(lead) > JANELA)) continue;       // fora da janela 24h
      try {
        await manychat.sendTextToPhone(lead.phone, ev.msg(cleanName(lead.firstName)), lead.firstName);
        store.recordCadence(lead.phone, ev.id, now);
        enviados.push({ id: ev.id, phone: lead.phone });
      } catch (e) { console.warn("[cadence]", ev.id, lead.phone, e.message); }
      if (++sent >= CAP) break; // throttle por tick
    }
  }
  if (enviados.length) console.log("[cadence]", JSON.stringify(enviados));
  return { enviados };
}
if (LOTE_ZERO_CADENCE) {
  setInterval(() => runLoteZeroCadence().catch(e => console.warn("[cadence]", e.message)), 60 * 1000);
  console.log(`[cadence] régua lote zero ATIVA (followup ${ENV.LZ_FOLLOWUP_AT || "2026-06-30 10:00"} BRT · vendas ${ENV.LZ_SALES_AT || "2026-07-01 08:00"} BRT)`);
} else {
  console.warn("[cadence] régua lote zero DESLIGADA (LOTE_ZERO_CADENCE_ENABLED!=true)");
}
