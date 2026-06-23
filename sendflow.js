// Envio de WhatsApp via SendFlow (outbound) — usado só pro DIGEST interno pro Daniel.
// 1 mensagem/dia do número conectado da Sonia pro número do Daniel. Não é disparo frio.
const fs = require("fs");
const path = require("path");

function getenv(k) {
  if (process.env[k]) return process.env[k];
  try {
    const m = fs.readFileSync(path.join(__dirname, ".env"), "utf8").match(new RegExp("^\\s*" + k + "\\s*=\\s*(.+)\\s*$", "m"));
    return m ? m[1].replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}

const BASE = "https://sendflow.pro/sendapi";
const ACCOUNT = getenv("SENDFLOW_ACCOUNT_ID") || "kFpkeOOvgHzN8MuAWGBo"; // conta conectada da Sonia (remetente)

async function sendText(phone, text) {
  const key = getenv("SENDFLOW_API_KEY");
  if (!key) throw new Error("SENDFLOW_API_KEY ausente");
  const r = await fetch(`${BASE}/send-text-message/${ACCOUNT}`, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ text, phoneNumber: String(phone).replace(/\D/g, "") }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.success === false) throw new Error(`SendFlow ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
  return d;
}

module.exports = { sendText };
