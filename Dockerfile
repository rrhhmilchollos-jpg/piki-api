FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run check && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# ClamAV se ejecuta en modo fail-closed: si no está disponible, la API rechaza la subida.
RUN apk add --no-cache clamav \
  && freshclam --stdout --verbose || true
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/assets ./dist/assets
EXPOSE 3000
CMD ["npm", "start"]
