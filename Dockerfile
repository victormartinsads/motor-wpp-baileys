FROM node:20-alpine

# Instalação de ffmpeg e dependências do sistema necessárias para áudio/mídia
RUN apk add --no-cache ffmpeg python3 make g++ git

WORKDIR /app

# Copia manifestos de dependências
COPY package*.json ./

# Instalação limpa das dependências
RUN npm ci --only=production

# Copia o código da aplicação
COPY . .

# Cria os diretórios necessários para armazenamento persistente
RUN mkdir -p uploads baileys_auth_info

EXPOSE 4000

ENV PORT=4000 \
    NODE_ENV=production

CMD ["npm", "start"]
