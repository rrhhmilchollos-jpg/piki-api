FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run check && npm run build
RUN npx esbuild scripts/seed-alibaba-staging.ts --platform=node --packages=external --bundle --format=esm --outfile=dist/seed-alibaba-staging.mjs

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# ClamAV se ejecuta en modo fail-closed: si no está disponible, la API rechaza la subida.
RUN apk add --no-cache clamav poppler-utils tesseract-ocr tesseract-ocr-data-spa \
  && freshclam --stdout --verbose || true
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/assets ./dist/assets
COPY --from=build /app/scripts/fixtures/alibaba-staging-menu.json ./dist/fixtures/alibaba-staging-menu.json
EXPOSE 3000
CMD ["sh", "-c", "if [ \"$NODE_ENV\" = \"staging\" ] && [ \"$RUN_ALIBABA_STAGING_SEED\" = \"true\" ]; then node dist/seed-alibaba-staging.mjs; fi; npm start"]
