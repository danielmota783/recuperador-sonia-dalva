// Resolve o LINK de checkout e o PREÇO por lote do ingresso IREC 2.
// O link muda por lote (via ?off=). O vigia da Hotmart já captura o valor (e, quando
// disponível, o offer code) da transação — então a lead volta pro lote/preço que ela
// quase pagou. Mentoria ainda não tem link configurado (entra na fase 3).

const PRODUTO_INGRESSO = "V106097949E";

// CRONOGRAMA OFICIAL DOS LOTES (fonte: Planejamento/Infinitum Launch, calendário da campanha).
// Cada lote vale num intervalo de datas (BRT). A Rosa calcula o lote VIGENTE pela data do dia —
// sem manutenção manual, sem deploy a cada virada. Se as datas mudarem no Planejamento, atualizar aqui.
// value casa com o valor detectado na Hotmart; off é o offer code do checkout daquele lote.
const CRONOGRAMA = [
  { lote: 1, value: 9.90,  off: "ayu3i3k8", inicio: "2026-07-01", fim: "2026-07-03", vagas: 500 },
  { lote: 2, value: 14.90, off: "tlaby17y", inicio: "2026-07-04", fim: "2026-07-08", vagas: 500 },
  { lote: 3, value: 19.90, off: "ptkdak4l", inicio: "2026-07-09", fim: "2026-07-15", vagas: 500 },
  { lote: 4, value: 24.90, off: "z8863av6", inicio: "2026-07-16", fim: "2026-07-22", vagas: 300 },
  { lote: 5, value: 29.90, off: "d3eqxfo4", inicio: "2026-07-23", fim: "2026-07-31", vagas: 200 },
];
// alias legado: alguns módulos importam LOTES (casamento por valor). Mantido derivado do cronograma.
const LOTES = CRONOGRAMA;

// Data de hoje em BRT no formato YYYY-MM-DD (comparável por string com inicio/fim do cronograma).
function hojeBRT() {
  try { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
// Lote VIGENTE pela data. Antes do 1º → 1º lote; depois do último → mantém o último (carrinho fecha 31/07).
function vigenteLote(hoje) {
  const d = hoje || hojeBRT();
  if (d < CRONOGRAMA[0].inicio) return CRONOGRAMA[0];
  for (const l of CRONOGRAMA) if (d >= l.inicio && d <= l.fim) return l;
  return CRONOGRAMA[CRONOGRAMA.length - 1];
}

const GRUPO_ALUNAS = "https://sndflw.com/i/2TWe3MH8E23R3NkYK3Ik"; // só pós-pagamento
const GRUPO_LOTE_ZERO = "https://chat.whatsapp.com/J3ZP4N7CyvCAhbTVgJVUv3"; // grupo VIP do lote zero (Rosa manda este)
const LOTE_ZERO_VALOR = "R$ 9,90"; // menor preço de todos (lote zero VIP); link de compra cai dentro do grupo
const SCK = "recuperador";      // venda vinda do recuperador (WhatsApp)
const SCK_PAGINA = "rosa_pagina"; // venda vinda do chat da Rosa na página de vendas

function linkByOff(off) { return `https://pay.hotmart.com/${PRODUTO_INGRESSO}?off=${off}`; }
function withSck(url, sck) { return url + (url.includes("?") ? "&" : "?") + "sck=" + (sck || SCK); }

// Link do checkout pro chat da PÁGINA (visitante sem lote definido → lote VIGENTE, atribuição da página).
function pageLink() { return withSck(linkByOff(vigenteLote().off), SCK_PAGINA); }

// Link de pagamento do lead, com SCK de atribuição. Prioridade: offer code exato da Hotmart →
// casa por valor → lote VIGENTE (oferta do dia). Mentoria: sem link ainda → null.
function checkoutLink(lead) {
  if (!lead) return withSck(linkByOff(vigenteLote().off));
  if (lead.product === "mentoria") return null;
  if (lead.offer) return withSck(linkByOff(lead.offer));        // exato, vindo da Hotmart
  if (lead.value > 0) {
    const exato = LOTES.find(l => Math.abs(l.value - lead.value) < 0.01);
    if (exato) return withSck(linkByOff(exato.off));
  }
  return withSck(linkByOff(vigenteLote().off)); // fallback: lote vigente do dia
}

// Preço do INGRESSO a partir do valor detectado (WhatsApp) OU do lote VIGENTE (página/genérico).
// {{VALOR}} só aparece em linhas de ingresso, então pra lead de mentoria devolve o preço de entrada.
function priceLabel(lead) {
  const isIngresso = !lead || lead.product !== "mentoria";
  const v = isIngresso && lead && lead.value > 0 ? lead.value : vigenteLote().value;
  return "R$ " + v.toFixed(2).replace(".", ",");
}

module.exports = { checkoutLink, pageLink, priceLabel, vigenteLote, hojeBRT, GRUPO_ALUNAS, GRUPO_LOTE_ZERO, LOTE_ZERO_VALOR, PRODUTO_INGRESSO, LOTES, CRONOGRAMA };
