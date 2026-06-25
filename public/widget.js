/* Widget de chat da ROSA — assistente da Sonia Dalva (pré-venda na página).
 * Embute com: <script src="https://SEU-DOMINIO/widget.js" defer></script>
 * Auto-contido (sem dependência). Conversa fica no navegador; chama /api/chat (gatilho suporte_pagina). */
(function () {
  if (window.__rosaWidget) return; window.__rosaWidget = true;

  var ORIGIN = "https://recuperador-sonia-dalva-production.up.railway.app";
  try { var s = document.currentScript && document.currentScript.src; if (s) ORIGIN = s.replace(/\/widget\.js.*$/, ""); } catch (e) {}
  var API = ORIGIN + "/api/chat";
  var GATILHO = "suporte_pagina";
  var GREETING = "Oi! Aqui é a Rosa, do time da Sonia Dalva 🌹 Posso te ajudar com alguma dúvida sobre a imersão?";

  var history = [], busy = false, opened = false;

  var CSS = ''
    + '.rosa-launch{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:9px;'
    + 'background:#c2683d;color:#fff;border:none;border-radius:999px;padding:13px 18px;font:600 15px/1.1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;'
    + 'box-shadow:0 8px 24px rgba(120,60,30,.35);cursor:pointer;transition:transform .15s,box-shadow .15s}'
    + '.rosa-launch:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(120,60,30,.45)}'
    + '.rosa-launch .rosa-dot{font-size:18px;line-height:1}'
    + '.rosa-panel{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:370px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 32px);'
    + 'background:#fbf7f0;border-radius:18px;box-shadow:0 18px 50px rgba(60,30,15,.34);display:flex;flex-direction:column;overflow:hidden;'
    + 'font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}'
    + '.rosa-head{background:#c2683d;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex:0 0 auto}'
    + '.rosa-head-info{display:flex;align-items:center;gap:11px}'
    + '.rosa-ava{width:40px;height:40px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:20px}'
    + '.rosa-name{font-weight:700;font-size:16px}.rosa-sub{font-size:12px;opacity:.85;margin-top:1px}'
    + '.rosa-x{background:transparent;border:none;color:#fff;font-size:24px;line-height:1;cursor:pointer;opacity:.85;padding:2px 6px}'
    + '.rosa-x:hover{opacity:1}'
    + '.rosa-msgs{flex:1 1 auto;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}'
    + '.rosa-msg{max-width:82%;padding:10px 13px;border-radius:15px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}'
    + '.rosa-assistant{align-self:flex-start;background:#fff;color:#3a2e28;border:1px solid #ece3d6;border-bottom-left-radius:5px}'
    + '.rosa-user{align-self:flex-end;background:#c2683d;color:#fff;border-bottom-right-radius:5px}'
    + '.rosa-typing{display:flex;gap:4px;align-items:center}'
    + '.rosa-typing span{width:7px;height:7px;border-radius:50%;background:#c2a48f;animation:rosablink 1.2s infinite both}'
    + '.rosa-typing span:nth-child(2){animation-delay:.2s}.rosa-typing span:nth-child(3){animation-delay:.4s}'
    + '@keyframes rosablink{0%,80%,100%{opacity:.3}40%{opacity:1}}'
    + '.rosa-form{flex:0 0 auto;display:flex;gap:8px;padding:12px;background:#fbf7f0;border-top:1px solid #ece3d6}'
    + '.rosa-form input{flex:1;border:1px solid #ddd0c0;border-radius:999px;padding:11px 15px;font-size:14.5px;outline:none;background:#fff;color:#3a2e28}'
    + '.rosa-form input:focus{border-color:#c2683d}'
    + '.rosa-form button{flex:0 0 auto;width:44px;height:44px;border-radius:50%;border:none;background:#c2683d;color:#fff;font-size:17px;cursor:pointer}'
    + '.rosa-form button:disabled{opacity:.5;cursor:default}'
    + '.rosa-foot{font-size:10.5px;color:#b6a795;text-align:center;padding:0 0 8px}'
    + '@media(max-width:420px){.rosa-panel{right:0;bottom:0;width:100vw;height:100vh;max-height:100vh;border-radius:0}}';

  var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);

  var launch = document.createElement("button");
  launch.className = "rosa-launch"; launch.type = "button"; launch.setAttribute("aria-label", "Falar com a Rosa");
  launch.innerHTML = '<span class="rosa-dot">🌹</span><span>Dúvidas? Fale comigo</span>';

  var panel = document.createElement("div");
  panel.className = "rosa-panel"; panel.style.display = "none";
  panel.innerHTML =
    '<div class="rosa-head"><div class="rosa-head-info"><div class="rosa-ava">🌹</div>'
    + '<div><div class="rosa-name">Rosa</div><div class="rosa-sub">Atendimento · Sonia Dalva</div></div></div>'
    + '<button class="rosa-x" type="button" aria-label="Fechar">×</button></div>'
    + '<div class="rosa-msgs" role="log"></div>'
    + '<form class="rosa-form"><input type="text" placeholder="Escreva sua dúvida..." autocomplete="off" maxlength="500" aria-label="Sua mensagem"/>'
    + '<button type="submit" aria-label="Enviar">➤</button></form>'
    + '<div class="rosa-foot">Atendimento da Sonia Dalva</div>';

  document.body.appendChild(launch); document.body.appendChild(panel);
  var msgs = panel.querySelector(".rosa-msgs"), form = panel.querySelector("form"),
      input = panel.querySelector("input"), sendBtn = panel.querySelector('button[type="submit"]');

  function esc(t) { var d = document.createElement("div"); d.textContent = t; return d.innerHTML; }
  function add(role, text) {
    var d = document.createElement("div"); d.className = "rosa-msg rosa-" + role; d.textContent = text;
    msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d;
  }
  function typing(on) {
    var ex = msgs.querySelector(".rosa-typing-wrap"); if (ex) ex.remove();
    if (on) { var d = document.createElement("div"); d.className = "rosa-msg rosa-assistant rosa-typing rosa-typing-wrap";
      d.innerHTML = "<span></span><span></span><span></span>"; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; }
  }
  function open() { panel.style.display = "flex"; launch.style.display = "none"; if (!opened) { opened = true; add("assistant", GREETING); } setTimeout(function(){ input.focus(); }, 50); }
  function close() { panel.style.display = "none"; launch.style.display = "flex"; }
  launch.onclick = open; panel.querySelector(".rosa-x").onclick = close;

  form.addEventListener("submit", function (e) {
    e.preventDefault(); if (busy) return;
    var text = (input.value || "").trim(); if (!text) return;
    input.value = ""; add("user", text); history.push({ role: "user", content: text });
    busy = true; sendBtn.disabled = true; typing(true);
    fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gatilho: GATILHO, messages: history }) })
      .then(function (r) { return r.json().catch(function(){ return {}; }); })
      .then(function (d) {
        typing(false);
        var reply = (d && d.reply) || "Tive um probleminha aqui. Pode escrever de novo?";
        add("assistant", reply); history.push({ role: "assistant", content: reply });
      })
      .catch(function () { typing(false); add("assistant", "Tive um probleminha de conexão. Tenta de novo em instantes?"); })
      .then(function () { busy = false; sendBtn.disabled = false; input.focus(); });
  });
})();
