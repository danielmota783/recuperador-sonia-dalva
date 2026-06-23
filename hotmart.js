// Cliente da API de vendas da Hotmart — detecta pagamentos PENDENTES (pix/boleto)
// pra recuperação ATIVA (não depende de webhook, que não dispara em pix gerado).
const fs = require("fs");
const path = require("path");

function getenv(k) {
  if (process.env[k]) return process.env[k];
  try {
    const m = fs.readFileSync(path.join(__dirname, ".env"), "utf8").match(new RegExp("^\\s*" + k + "\\s*=\\s*(.+)\\s*$", "m"));
    return m ? m[1].replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}

async function token() {
  const id = getenv("HOTMART_CLIENT_ID"), sec = getenv("HOTMART_CLIENT_SECRET");
  if (!id || !sec) throw new Error("HOTMART_CLIENT_ID/SECRET ausentes");
  const basic = Buffer.from(id + ":" + sec).toString("base64");
  const r = await fetch(`https://api-sec-vlc.hotmart.com/security/oauth/token?grant_type=client_credentials&client_id=${id}&client_secret=${sec}`,
    { method: "POST", headers: { Authorization: "Basic " + basic } });
  const d = await r.json();
  if (!d.access_token) throw new Error("Hotmart token falhou: " + JSON.stringify(d).slice(0, 120));
  return d.access_token;
}

async function apiGet(tok, ep, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`https://developers.hotmart.com/payments/api/v1/${ep}?${qs}`, { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) throw new Error(`Hotmart ${ep} ${r.status}`);
  return r.json();
}

// Pagamentos pendentes (pix/boleto gerado e não pago): junta sales/history (tipo+valor)
// com sales/users (telefone). Retorna [{transaction, firstName, phone, email, paymentType, value, productId}].
async function pendingPayments(productId, sinceMs = 24 * 3600 * 1000) {
  const tok = await token();
  const base = { transaction_status: "WAITING_PAYMENT", start_date: Date.now() - sinceMs, end_date: Date.now(), max_results: 50 };
  if (productId) base.product_id = productId;

  const [hist, users] = await Promise.all([apiGet(tok, "sales/history", base), apiGet(tok, "sales/users", base)]);

  const byTx = {};
  for (const it of (hist.items || [])) {
    const tx = (it.purchase && it.purchase.transaction) || it.transaction;
    const offer = (it.purchase && it.purchase.offer) || {};
    byTx[tx] = {
      type: (it.purchase && it.purchase.payment || {}).type,
      value: (it.purchase && it.purchase.price || {}).value || 0,
      productId: it.product && it.product.id,
      offer: offer.code || offer.key || null, // código do lote (?off=) pra mandar a lead pro lote certo
    };
  }

  const out = [];
  for (const it of (users.items || [])) {
    if (productId && it.product && it.product.id != productId) continue;
    const b = (it.users || []).find(u => u.role === "BUYER");
    if (!b) continue;
    const u = b.user || {};
    const phone = (u.cellphone || u.phone || "").replace(/\D/g, "");
    if (!phone) continue;
    const meta = byTx[it.transaction] || {};
    out.push({
      transaction: it.transaction,
      firstName: (u.name || "amiga").split(" ")[0],
      phone,
      email: u.email || null,
      paymentType: meta.type || null,        // PIX | BILLET | ...
      value: meta.value || 0,
      offer: meta.offer || null,             // código do lote (?off=)
      productId: (it.product && it.product.id) || meta.productId || null,
    });
  }
  return out;
}

module.exports = { token, pendingPayments };
