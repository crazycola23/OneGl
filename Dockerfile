ARG ONEGL_NODE_BASE_IMAGE=m.daocloud.io/docker.io/library/node:22-bookworm-slim
FROM ${ONEGL_NODE_BASE_IMAGE}

ARG APT_MIRROR=http://mirrors.aliyun.com/debian
ARG APT_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright
ARG CAMOUFOX_PYTHON_VERSION=0.6.0
ARG CAMOUFOX_VENDOR_VERSION=152.0.4-beta.30
ARG CAMOUFOX_VENDOR_SHA256=5720d45b894ce1770543de024c6f10d514b38be560fa2dc3226b3d8586caf672
ARG UBLOCK_VERSION=1.75.0
ARG UBLOCK_VENDOR_SHA256=5b74415860456370644bd80f16125e865b0e6c356bb5dfcfb84069967eaa5287

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ONEGL_DATA_DIR=/var/lib/onegl \
    ONEGL_BROWSER=camoufox \
    ONEGL_CAMOUFOX_MODE=virtual \
    ONEGL_CAMOUFOX_PYTHON=/opt/camoufox/bin/python \
    ONEGL_CAMOUFOX_UBLOCK_PATH=/opt/onegl-addons/ublock \
    ONEGL_CAMOUFOX_UBLOCK_VERSION=${UBLOCK_VERSION} \
    ONEGL_HEADLESS=true \
    HOME=/home/onegl

WORKDIR /app

COPY package.json package-lock.json ./
# Keep Chromium installed as an explicit troubleshooting fallback. Camoufox uses
# its own Firefox-derived binary but still needs the Linux Firefox runtime libs.
RUN set -eux; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    printf 'deb %s bookworm main\ndeb %s bookworm-updates main\ndeb %s bookworm-security main\n' \
      "$APT_MIRROR" "$APT_MIRROR" "$APT_SECURITY_MIRROR" > /etc/apt/sources.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates python3 python3-venv xvfb; \
    npm ci --omit=dev --registry="$NPM_REGISTRY"; \
    PLAYWRIGHT_DOWNLOAD_HOST="$PLAYWRIGHT_DOWNLOAD_HOST" npx playwright-core install --with-deps chromium; \
    npx playwright-core install-deps firefox; \
    python3 -m venv /opt/camoufox; \
    /opt/camoufox/bin/pip install --no-cache-dir --index-url="$PIP_INDEX_URL" "cloverlabs-camoufox[geoip]==${CAMOUFOX_PYTHON_VERSION}"; \
    useradd --create-home --uid 10001 onegl; \
    mkdir -p /var/lib/onegl /ms-playwright /opt/onegl-addons; \
    chown -R onegl:onegl /app /var/lib/onegl /ms-playwright /home/onegl; \
    rm -rf /var/lib/apt/lists/*

COPY tools/prepare-camoufox-url.py /tmp/prepare-camoufox-url.py
COPY tools/download-camoufox-range.mjs /tmp/download-camoufox-range.mjs
COPY tools/install-ublock.py /tmp/install-ublock.py

RUN chown -R onegl:onegl /opt/onegl-addons

USER onegl

# Install the active Camoufox browser into the runtime user's cache so API remote-auth
# sessions and workers resolve the same browser build without root-owned cache files.
RUN --mount=type=bind,source=vendor/camoufox-lin.x86_64.zip,target=/tmp/camoufox-lin.x86_64.zip,ro \
    test "$(sha256sum /tmp/camoufox-lin.x86_64.zip | cut -d' ' -f1)" = "$CAMOUFOX_VENDOR_SHA256" \
    && /opt/camoufox/bin/python -m camoufox sync \
    && /opt/camoufox/bin/python -m camoufox set "official/stable/${CAMOUFOX_VENDOR_VERSION}" \
    && CAMOUFOX_PINNED_VERSION="$CAMOUFOX_VENDOR_VERSION" /opt/camoufox/bin/python /tmp/prepare-camoufox-url.py --install --archive /tmp/camoufox-lin.x86_64.zip \
    && /opt/camoufox/bin/python -c "from camoufox.pkgman import installed_verstr; print('Camoufox installed:', installed_verstr())"

RUN --mount=type=bind,source=vendor/ublock-origin.firefox.xpi,target=/tmp/ublock-origin.firefox.xpi,ro \
    /opt/camoufox/bin/python /tmp/install-ublock.py \
      --archive /tmp/ublock-origin.firefox.xpi \
      --output "$ONEGL_CAMOUFOX_UBLOCK_PATH" \
      --expected-version "$UBLOCK_VERSION" \
      --expected-sha256 "$UBLOCK_VENDOR_SHA256"

COPY --chown=onegl:onegl . .

EXPOSE 3200

CMD ["npm", "run", "api:serve"]
