FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ONEGL_DATA_DIR=/var/lib/onegl \
    ONEGL_BROWSER=chromium \
    ONEGL_HEADLESS=true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright-core install --with-deps chromium \
    && useradd --create-home --uid 10001 onegl \
    && mkdir -p /var/lib/onegl /ms-playwright \
    && chown -R onegl:onegl /app /var/lib/onegl /ms-playwright

COPY --chown=onegl:onegl . .

USER onegl
EXPOSE 3200

CMD ["npm", "run", "api:serve"]
