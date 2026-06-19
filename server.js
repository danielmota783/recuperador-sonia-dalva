// Recuperador de Vendas IA — microserviço (Sonia / IREC 2).
// Cano: ManyChat (transporte) · Cérebro+dados+métricas: AQUI.
// Zero dependências: Node 22 (fetch nativo).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { GATILHOS, systemPrompt } = require("./knowledge");
const store = require("./store");

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
const HOTMART_HOTTOK = ENV.HOTMART_HOTTOK || null; // valida assinatura do webhook quando setado
if (!API_KEY) console.warn("[aviso] ANTHROPIC_API_KEY ausente — o servidor sobe, mas as respostas da IA falham até a chave ser configurada.");

// produtos IREC 2 (Hotmart) → tipo
const PRODUCT_MAP = { "7860446": "ingresso", "7016784": "mentoria" };

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

// --- normaliza payload da Hotmart (shape a confirmar no sandbox; parser tolerante) ---
function parseHotmart(p) {
  const data = p.data || p;
  const purchase = data.purchase || {};
  const buyer = data.buyer || {};
  const product = data.product || {};
  const productId = String(product.id || purchase.product_id || p.product_id || "");
  const productType = PRODUCT_MAP[productId] || (p.product || "ingresso");
  const status = (p.event || purchase.status || p.status || "").toUpperCase();
  const phone = buyer.checkout_phone || buyer.phone || p.phone || "";
  const firstName = (buyer.name || p.firstName || p.name || "amiga").split(" ")[0];
  const value = (purchase.price && purchase.price.value) || p.value || 0;
  const sck = (purchase.tracking && purchase.tracking.source_sck) || p.sck || null;

  let gatilho = null, kind = null;
  if (/APPROVED|COMPLETE/.test(status)) kind = "venda";
  else if (/OUT_OF_SHOPPING_CART|ABANDON/.test(status)) { kind = "detect"; gatilho = `${productType}_abandono`; }
  else if (/PIX/.test(status) || p.event === "pix") { kind = "detect"; gatilho = productType === "mentoria" ? "mentoria_pix" : "ingresso_pix"; }
  else if (/BILLET|BOLETO/.test(status) || p.event === "boleto") { kind = "detect"; gatilho = productType === "mentoria" ? "mentoria_boleto" : "ingresso_boleto"; }
  else if (/CANCEL|REFUSED|CARTAO/.test(status) || p.event === "cartao") { kind = "detect"; gatilho = "ingresso_cartao"; }
  return { kind, phone, firstName, product: productType, gatilho, value, sck, status };
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
      if (HOTMART_HOTTOK && req.headers["x-hotmart-hottok"] !== HOTMART_HOTTOK)
        return send(res, 401, { error: "hottok inválido" });
      const payload = await readJson(req);
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
      const { phone, firstName, text } = await readJson(req);
      if (!phone || !text) return send(res, 400, { error: "phone e text obrigatórios" });
      let lead = store.getLead(phone) || store.upsertLead({ phone, firstName, gatilho: "ingresso_abandono", product: "ingresso" }, now);
      if (lead.optout) return send(res, 200, { reply: "", status: "optout" });

      store.appendMessage(phone, "user", text, now);
      if (isOptout(text)) {
        store.setState(phone, "PERDIDO", now, { optout: true });
        const bye = "Tudo bem, amiga. Não te chamo mais por aqui. Qualquer dia que quiser, é só me responder. Um beijo.";
        store.appendMessage(phone, "assistant", bye, now);
        return send(res, 200, { reply: bye, status: "optout" });
      }

      // monta histórico pro Claude (abertura do gatilho + mensagens trocadas)
      const g = GATILHOS[lead.gatilho] || GATILHOS.ingresso_abandono;
      const history = [{ role: "assistant", content: g.abertura }, ...lead.messages.map(m => ({ role: m.role, content: m.content }))];
      const reply = await callClaude(systemPrompt(lead.gatilho), history);
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
