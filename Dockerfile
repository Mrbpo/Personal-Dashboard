FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-chi-sim && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production CLOUD_MODE=true NEXT_TELEMETRY_DISABLED=1
ARG APP_VERSION=unreleased
ENV APP_VERSION=$APP_VERSION
LABEL org.opencontainers.image.revision=$APP_VERSION
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/data /app/public/assets/vic3-theme && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["npm","start"]
