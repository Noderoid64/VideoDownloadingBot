FROM node:20-alpine AS base

WORKDIR /app
ENV NODE_ENV=production

# Ускоряем установку зависимостей и кэширование
COPY package*.json ./
RUN npm ci --omit=dev

# Копируем исходники
COPY index.js ./

# Не нужен публичный порт для long polling, но healthcheck слушает 8080
EXPOSE 8080

CMD ["node", "index.js"]
