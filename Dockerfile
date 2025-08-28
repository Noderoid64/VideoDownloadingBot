FROM node:20-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg \
  && ln -sf /usr/bin/python3 /usr/bin/python

RUN apk add --no-cache yt-dlp

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8080
CMD ["node", "index.js"]
