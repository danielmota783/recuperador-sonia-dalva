# Deploy — Railway (passo a passo)

Serviço: `recuperador-sonia-dalva` · Node 22 · zero dependências · dados em disco persistente.

## 1. Subir o código pro GitHub (repo privado)
O código local já está com commit pronto. Falta criar o repo e dar push. Duas opções:

**Opção A — pelo site (sem instalar nada):**
1. github.com → New repository → nome `recuperador-sonia-dalva` → **Private** → Create (sem README).
2. No terminal, dentro de `~/recuperador-sonia-dalva`:
   ```
   git remote add origin https://github.com/<seu-usuario>/recuperador-sonia-dalva.git
   git branch -M main
   git push -u origin main
   ```
   (vai pedir login/token do GitHub)

**Opção B — instalar o GitHub CLI e deixar o Alfred dirigir:**
   ```
   brew install gh && gh auth login
   ```
   Depois é só avisar que eu crio o repo e dou push.

## 2. Criar o serviço no Railway
1. railway.app → New Project → **Deploy from GitHub repo** → escolher `recuperador-sonia-dalva`.
   - Railway detecta Node sozinho (Nixpacks) e roda `npm start`. Sem config extra.
2. Como é **serviço separado**, não juntar com o `infinitum-launch`.

## 3. Adicionar o disco persistente (os dados não somem no deploy)
1. No serviço → aba **Volumes** → **Add Volume**.
2. Mount path: `/data`
3. Isso guarda o `store.json` (leads, conversas, métricas) entre deploys.

## 4. Variáveis de ambiente (Settings → Variables)
| Variável | Valor | Obs |
|---|---|---|
| `ANTHROPIC_API_KEY` | (chave dedicada do projeto) | a recarregada |
| `MODEL` | `claude-sonnet-4-6` | |
| `DATA_DIR` | `/data` | aponta pro disco persistente |
| `MANYCHAT_API_TOKEN` | `779285:...` | já temos |
| `HOTMART_HOTTOK` | (do painel da Hotmart) | valida o webhook; setar quando configurar |

`PORT` o Railway injeta sozinho — não precisa setar.

## 5. Pegar a URL pública
Settings → **Networking** → Generate Domain → algo como `recuperador-sonia-dalva-production.up.railway.app`.
Essa URL é o endereço que vai no:
- **Webhook da Hotmart:** `https://<url>/webhook/hotmart`
- **External Request do ManyChat:** `https://<url>/api/reply`
- **Painel do CRM:** `https://<url>/crm`

## 6. Conferir
Abrir `https://<url>/crm` e `https://<url>/api/metrics`. Se responder, está no ar.
