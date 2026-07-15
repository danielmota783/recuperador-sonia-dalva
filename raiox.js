// Feed do bônus Raio-X: registra quais e-mails já foram jogados na planilha da ferramenta
// (para não duplicar). Idempotente por e-mail. Arquivo em DATA_DIR (/data no Railway).
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "raiox.json");

function load() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } }
let db = load();
function save() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error("[raiox] save falhou:", e.message); } }

const key = (email) => String(email || "").trim().toLowerCase();

function jaEnviado(email) { return !!db[key(email)]; }
function marcar(email, nome) { db[key(email)] = { nome: nome || "", at: new Date().toISOString() }; save(); }
function metrics() { return { total: Object.keys(db).length }; }

module.exports = { jaEnviado, marcar, metrics };
