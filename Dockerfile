FROM node:22-bookworm-slim

ARG CAMOUFOX_PYTHON_VERSION=0.6.0

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ONEGL_DATA_DIR=/var/lib/onegl \
    ONEGL_BROWSER=camoufox \
    ONEGL_CAMOUFOX_MODE=virtual \
    ONEGL_CAMOUFOX_PYTHON=/opt/camoufox/bin/python \
    ONEGL_HEADLESS=true \
    HOME=/home/onegl

WORKDIR /app

COPY package.json package-lock.json ./
# Keep Chromium installed as an explicit troubleshooting fallback. Camoufox uses
# its own Firefox-derived binary but still needs the Linux Firefox runtime libs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv xvfb \
    && npm ci --omit=dev \
    && npx playwright-core install --with-deps chromium \
    && npx playwright-core install-deps firefox \
    && python3 -m venv /opt/camoufox \
    && /opt/camoufox/bin/pip install --no-cache-dir "cloverlabs-camoufox[geoip]==${CAMOUFOX_PYTHON_VERSION}" \
    && useradd --create-home --uid 10001 onegl \
    && mkdir -p /var/lib/onegl /ms-playwright \
    && chown -R onegl:onegl /app /var/lib/onegl /ms-playwright /home/onegl \
    && rm -rf /var/lib/apt/lists/*

COPY tools/prepare-camoufox-url.py /tmp/prepare-camoufox-url.py
COPY tools/download-camoufox-range.mjs /tmp/download-camoufox-range.mjs

USER onegl

# Install the active Camoufox browser into the runtime user's cache so API remote-auth
# sessions and workers resolve the same browser build without root-owned cache files.
RUN /opt/camoufox/bin/python -m camoufox sync \
    && /opt/camoufox/bin/python -m camoufox set official/stable \
    && /opt/camoufox/bin/python /tmp/prepare-camoufox-url.py --install \
    && /opt/camoufox/bin/python /tmp/prepare-camoufox-url.py --restore \
    && /opt/camoufox/bin/python -c "from camoufox.pkgman import installed_verstr; print('Camoufox installed:', installed_verstr())"

COPY --chown=onegl:onegl . .

EXPOSE 3200

CMD ["npm", "run", "api:serve"]
