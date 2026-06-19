# Recuperador de Vendas IA — Sonia / IREC 2

Microserviço do agente recuperador de vendas por WhatsApp. **Fase atual: simulador do motor de conversa** (testa o cérebro antes da pele do WhatsApp).

Convenção: código vive aqui em `~/recuperador-sonia-dalva/` (fora do workspace IA Daniel). Estratégia e memória ficam em
`IA Daniel/Infinitum Digital/03 - Clientes/Ativos/Sonia Dalva Arts/Recuperador de Vendas IA/`.

## Rodar o simulador
```
cd ~/recuperador-sonia-dalva
npm start
```
Abre em http://localhost:3030 — escolha o gatilho (abandono, pix, boleto, cartão) e converse como se fosse a lead.

## Arquivos
- `knowledge.js` — base de conhecimento + system prompt confinado (voz da Sonia, fatos da oferta, reframes de objeção, FAQ, regras anti-erro, escalonamento). Fonte: `REDE_QA_OBJECOES.md`.
- `server.js` — servidor zero-dependência (Node 22, fetch nativo). Fala com a API da Anthropic.
- `public/index.html` — UI de WhatsApp simulado.
- `.env` — `ANTHROPIC_API_KEY` (copiada do analisador), `MODEL=claude-sonnet-4-6`, `PORT=3030`.

## Próximos passos (pós-validação do cérebro)
1. Plugar trigger real: webhook Hotmart (abandono/pix/boleto/cartão) → cria Lead.
2. Plugar canal: ManyChat/Cloud API (template de 1º toque → inbound → este motor → resposta).
3. Banco (Lead/Conversa/Mensagem/Estado) + máquina de estados + métricas.
4. Deploy (Railway).
