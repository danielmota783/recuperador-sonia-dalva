// Resolve o LINK de checkout e o PREÇO por lote do ingresso IREC 2.
// O link muda por lote (via ?off=). O vigia da Hotmart já captura o valor (e, quando
// disponível, o offer code) da transação — então a lead volta pro lote/preço que ela
// quase pagou. Mentoria ainda não tem link configurado (entra na fase 3).

const PRODUTO_INGRESSO = "V106097949E";

// lote → { value (R$), off }. value casa com o valor detectado na Hotmart.
// [CONFIRMAR com Daniel] o value exato de cada off — inferido da escada do briefing.
const LOTES = [
  { lote: 0, value: 9.90,  off: "ayu3i3k8" },
  { lote: 1, value: 14.90, off: "tlaby17y" },
  { lote: 2, value: 19.90, off: "ptkdak4l" },
  { lote: 3, value: 24.90, off: "z8863av6" },
  { lote: 4, value: 29.90, off: "d3eqxfo4" },
];

const GRUPO_ALUNAS = "https://sndflw.com/i/2TWe3MH8E23R3NkYK3Ik"; // só pós-pagamento

function linkByOff(off) { return `https://pay.hotmart.com/${PRODUTO_INGRESSO}?off=${off}`; }

// Link de pagamento do lead. Prioridade: offer code exato da Hotmart → casa por valor →
// link base (oferta padrão vigente). Mentoria: sem link ainda → null.
function checkoutLink(lead) {
  if (!lead) return `https://pay.hotmart.com/${PRODUTO_INGRESSO}`;
  if (lead.product === "mentoria") return null;
  if (lead.offer) return linkByOff(lead.offer);                 // exato, vindo da Hotmart
  if (lead.value > 0) {
    const exato = LOTES.find(l => Math.abs(l.value - lead.value) < 0.01);
    if (exato) return linkByOff(exato.off);
  }
  return `https://pay.hotmart.com/${PRODUTO_INGRESSO}`;         // fallback: oferta vigente
}

// Preço do INGRESSO ("R$ 14,90") a partir do valor detectado. {{VALOR}} só aparece em
// linhas de ingresso, então pra lead de mentoria devolve o preço de entrada genérico (não os R$497).
function priceLabel(lead) {
  const isIngresso = !lead || lead.product !== "mentoria";
  const v = isIngresso && lead && lead.value > 0 ? lead.value : 14.90;
  return "R$ " + v.toFixed(2).replace(".", ",");
}

module.exports = { checkoutLink, priceLabel, GRUPO_ALUNAS, PRODUTO_INGRESSO, LOTES };
