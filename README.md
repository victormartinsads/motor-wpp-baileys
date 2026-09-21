# 🚀 Motor WhatsApp Baileys (REST Microservice)

Microserviço standalone de alta performance para envio e recebimento de mensagens no WhatsApp via **REST API**, construído com **Node.js (ESM)**, **Express** e **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)**.

Desenvolvido para ser plugado facilmente em qualquer sistema externo (CRMs, automações n8n/Typebot, chatbots, ERPs e plataformas SaaS).

---

## ⚡ Recursos Principais

- 📱 **QR Code Dinâmico**: Geração e reconexão automática de sessão com status em tempo real.
- 💾 **Persistência de Sessão**: Armazenamento local de credenciais (`baileys_auth_info`) — não perde a conexão ao reiniciar o servidor.
- 💬 **Envio & Recebimento de Mensagens**: Mensagens de texto simples para contatos e grupos com formatação automática de JID.
- 🎙️ **Notas de Voz / Áudio (PTT)**: Envio de áudios em formato de mensagem de voz nativa (waveform verde do WhatsApp).
- 📁 **Envio de Mídias Diversas**: Upload multipart de imagens, vídeos e documentos (PDFs, planilhas).
- 📥 **Download Automático de Mídias Recebidas**: Armazena mídias localmente e expõe via URL pública estática `/api/whatsapp/media/...`.
- 👥 **Gestão de Grupos**: Listagem de grupos participantes e seleção de grupos ativos.
- 🗃️ **Histórico Local de Chats & Mensagens**: Armazenamento em `store.json` com contagem de não lidos e ordenação cronológica.
- 🐳 **Pronto para Docker**: Dockerfile otimizado e `docker-compose.yml` com persistência em volumes.

---

## 🛠️ Stack Tecnológica

- **Runtime**: Node.js 20+
- **Framework HTTP**: Express 4
- **Biblioteca WhatsApp**: `@whiskeysockets/baileys` v6.7.5
- **Manipulação de Mídia / Upload**: Multer, FFmpeg
- **Logger**: Pino

---

## 🚀 Como Executar

### Opção 1: Executando com Docker (Recomendado)

```bash
# 1. Clone o repositório
git clone https://github.com/victormartinsads/motor-wpp-baileys.git
cd motor-wpp-baileys

# 2. Inicie o container em segundo plano
docker compose up -d

# 3. Verifique os logs
docker compose logs -f
```

O servidor estará disponível em: `http://localhost:4000`

---

### Opção 2: Executando com Node.js Localmente

```bash
# 1. Clone o repositório
git clone https://github.com/victormartinsads/motor-wpp-baileys.git
cd motor-wpp-baileys

# 2. Instale as dependências
npm install

# 3. Inicie em modo de produção
npm start

# Ou em modo desenvolvimento com auto-reload
npm run dev
```

---

## 📖 Documentação da API REST

### 1. Status da Sessão
Retorna o estado atual da conexão (`DISCONNECTED`, `CONNECTING`, `SCAN_QR`, `CONNECTED`), QR Code em Base64 (se aguardando leitura) e informações do número conectado.

```http
GET /api/whatsapp/session
```

**Exemplo de Resposta (Aguardando Scan):**
```json
{
  "status": "SCAN_QR",
  "qrCode": "data:image/png;base64,iVBORw0KGgo...",
  "user": null,
  "phone": null,
  "battery": 100,
  "groupConfig": {
    "activeGroupJid": "",
    "groupName": "",
    "updatedAt": null
  }
}
```

**Exemplo de Resposta (Conectado):**
```json
{
  "status": "CONNECTED",
  "qrCode": null,
  "user": {
    "name": "Nome do Usuário",
    "phone": "5511999999999",
    "jid": "5511999999999:12@s.whatsapp.net"
  },
  "phone": "5511999999999"
}
```

---

### 2. Solicitar / Forçar Geração de QR Code
Inicia o socket de conexão e retorna o QR Code em Base64 para escaneamento.

```http
POST /api/whatsapp/connect-qr
```

**Exemplo cURL:**
```bash
curl -X POST http://localhost:4000/api/whatsapp/connect-qr
```

---

### 3. Desconectar / Encerrar Sessão
Faz logout da conta no WhatsApp e remove os arquivos de credenciais salvas em disco.

```http
POST /api/whatsapp/disconnect
```

---

### 4. Enviar Mensagem de Texto
Envia uma mensagem de texto para um número (com DDI e DDD) ou ID de grupo.

```http
POST /api/whatsapp/send-message
Content-Type: application/json

{
  "phone": "5511999999999",
  "text": "Olá! Esta é uma mensagem automática disparada via motor Baileys 🚀",
  "isGroup": false
}
```

**Exemplo cURL:**
```bash
curl -X POST http://localhost:4000/api/whatsapp/send-message \
  -H "Content-Type: application/json" \
  -d '{"phone": "5511999999999", "text": "Olá mundo!"}'
```

---

### 5. Enviar Áudio Gravado / Mensagem de Voz (PTT)
Envia um áudio no formato nativo de gravação de voz (waveform).

```http
POST /api/whatsapp/send-audio
Content-Type: application/json

{
  "phone": "5511999999999",
  "audioBase64": "data:audio/mp4;base64,AAAAHGZ0eXBpc29tAAAA...",
  "isGroup": false
}
```

---

### 6. Enviar Mídia (Imagem, Vídeo ou Documento)
Upload de arquivo via `multipart/form-data`.

```http
POST /api/whatsapp/send-media
Content-Type: multipart/form-data
```

**Campos do Formulário:**
- `phone`: Número com DDI e DDD (ex: `5511999999999`)
- `file`: Arquivo binário a ser enviado
- `caption` *(opcional)*: Legenda da mídia
- `type` *(opcional)*: `image` | `video` | `document`
- `isGroup` *(opcional)*: `"true"` ou `"false"`

**Exemplo cURL:**
```bash
curl -X POST http://localhost:4000/api/whatsapp/send-media \
  -F "phone=5511999999999" \
  -F "caption=Segue a proposta em PDF" \
  -F "file=@/caminho/do/documento.pdf"
```

---

### 7. Listar Conversas (Chats)
Lista todas as conversas registradas, ordenadas pela data da última mensagem recebida/enviada.

```http
GET /api/whatsapp/chats
```

---

### 8. Obter Histórico de Mensagens de um Chat
Retorna as mensagens salvas de um determinado contato ou grupo.

```http
GET /api/whatsapp/messages?chatId=5511999999999
```

---

### 9. Listar Grupos Participantes
Retorna todos os grupos do WhatsApp dos quais a conta conectada faz parte.

```http
GET /api/whatsapp/groups
```

---

### 10. Download de Mídia Recebida
Arquivos recebidos ou enviados ficam disponíveis via requisição GET estática:

```http
GET /api/whatsapp/media/{nome_do_arquivo}
```

---

## 💻 Exemplos de Integração em Outros Sistemas

### Em JavaScript / Node.js / React:
```javascript
async function sendWhatsApp(phone, text) {
  const response = await fetch("http://SEU_SERVIDOR:4000/api/whatsapp/send-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, text })
  });
  return await response.json();
}
```

### Em Python:
```python
import requests

def send_whatsapp(phone: str, text: str):
    url = "http://SEU_SERVIDOR:4000/api/whatsapp/send-message"
    payload = {"phone": phone, "text": text}
    response = requests.post(url, json=payload)
    return response.json()
```

---

## 📂 Estrutura do Repositório

```
motor-wpp-baileys/
├── server.js              # Servidor Express com lógica Baileys e endpoints REST
├── package.json           # Dependências e scripts do projeto
├── package-lock.json      # Trava de versões das dependências
├── Dockerfile             # Imagem Docker com Node 20 e FFmpeg
├── docker-compose.yml     # Orquestração do container com volumes persistentes
├── .env.example           # Modelo de variáveis de ambiente
├── .gitignore             # Arquivos ignorados (sessão, uploads, node_modules)
└── README.md              # Documentação completa
```

---

## 🔒 Boas Práticas e Recomendações

1. **Persistência de Dados**: Ao hospedar em VPS/Docker (Coolify, Easypanel, etc.), garanta que as pastas `/app/baileys_auth_info` e `/app/uploads` estejam mapeadas em volumes persistentes para nunca perder a sessão conectada.
2. **Proxy Reverso**: Recomendado rodar atrás de Nginx / Caddy / Cloudflare com SSL habilitado (`https://`).
3. **Prevenção de Bloqueios**: Não utilize o motor para envio em massa sem consentimento (spam) para evitar restrições da Meta no número.
