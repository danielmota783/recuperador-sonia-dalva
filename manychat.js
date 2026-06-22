// Cliente da API do ManyChat (conta da Sonia). Token no .env (MANYCHAT_API_TOKEN).
// Doc: https://api.manychat.com  | auth: Authorization: Bearer <token>
const fs = require("fs");
const path = require("path");

function token() {
  if (process.env.MANYCHAT_API_TOKEN) return process.env.MANYCHAT_API_TOKEN; // Railway
  try {
    const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    const m = raw.match(/^\s*MANYCHAT_API_TOKEN\s*=\s*(.+)\s*$/m);
    return m ? m[1].replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}

async function mc(endpoint, method = "GET", body) {
  const t = token();
  if (!t) throw new Error("MANYCHAT_API_TOKEN ausente no .env");
  const res = await fetch("https://api.manychat.com" + endpoint, {
    method,
    headers: { "Authorization": "Bearer " + t, "content-type": "application/json", "accept": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === "error") {
    throw new Error(`ManyChat ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.data;
}

// --- Leitura ---
const getInfo = () => mc("/fb/page/getInfo");
const findByPhone = (phone) => mc("/fb/subscriber/findBySystemField?phone=" + encodeURIComponent(phone));
const findByCustomField = (fieldId, value) => mc(`/fb/subscriber/findByCustomField?field_id=${fieldId}&field_value=${encodeURIComponent(value)}`);
const getFlows = () => mc("/fb/page/getFlows");

// --- Assinante ---
// Cria assinante de WhatsApp. phone em E.164 (ex.: +5599991202143 ou 5599991202143).
const createSubscriber = ({ phone, firstName, lastName }) =>
  mc("/fb/subscriber/createSubscriber", "POST", {
    whatsapp_phone: phone,
    first_name: firstName || "amiga",
    last_name: lastName || "",
    has_opt_in_sms: false,
    has_opt_in_email: false,
    consent_phrase: "recuperacao_irec2",
  });

const setCustomField = (subscriberId, fieldId, value) =>
  mc("/fb/subscriber/setCustomField", "POST", { subscriber_id: subscriberId, field_id: fieldId, field_value: value });

const addTag = (subscriberId, tagId) =>
  mc("/fb/subscriber/addTag", "POST", { subscriber_id: subscriberId, tag_id: tagId });

// --- Envio ---
// 1º toque (fora da janela 24h): dispara um FLUXO do ManyChat que contém o template aprovado.
const sendFlow = (subscriberId, flowNs) =>
  mc("/fb/sending/sendFlow", "POST", { subscriber_id: subscriberId, flow_ns: flowNs });

// Resposta livre (DENTRO da janela 24h, depois da lead responder): manda texto direto.
const sendText = (subscriberId, text) =>
  mc("/fb/sending/sendContent", "POST", {
    subscriber_id: subscriberId,
    data: { version: "v2", content: { type: "whatsapp", messages: [{ type: "text", text }] } },
    message_tag: "ACCOUNT_UPDATE",
  });

// 1º toque: acha/cria o assinante pelo telefone e dispara o fluxo (template aprovado).
const WHATSAPP_ID_FIELD = Number(process.env.MANYCHAT_WAID_FIELD || 13024789); // campo "Whatsapp_ID" do funil da Sonia

function pickId(x) {
  if (!x) return null;
  const arr = Array.isArray(x) ? x : [x];
  const s = arr[0];
  return s && (s.id || s.subscriber_id || (s.subscriber && s.subscriber.id)) || null;
}

async function firstTouch({ phone, firstName, flowNs }) {
  const digits = String(phone).replace(/\D/g, "");
  const plus = "+" + digits;
  let id = null;
  // 1) acha aluna existente pelo campo Whatsapp_ID (formato +55...) — caso mais comum
  try { id = pickId(await findByCustomField(WHATSAPP_ID_FIELD, plus)); } catch (e) { /* segue */ }
  // 2) fallback: por phone (contatos que nós criamos têm phone setado)
  if (!id) { try { id = pickId(await findByPhone(plus)); } catch (e) { /* segue */ } }
  // 3) cria novo e grava o Whatsapp_ID pra ser achável depois
  if (!id) {
    const created = await createSubscriber({ phone: plus, firstName });
    id = pickId(created);
    if (id) { try { await setCustomField(id, WHATSAPP_ID_FIELD, plus); } catch (e) { /* nao bloqueia */ } }
  }
  if (!id) throw new Error("ManyChat: nao obteve subscriber id para " + digits);
  await sendFlow(id, flowNs);
  return id;
}

module.exports = { mc, getInfo, findByPhone, findByCustomField, getFlows, createSubscriber, setCustomField, addTag, sendFlow, sendText, firstTouch };
