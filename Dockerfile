FROM node:22-alpine
WORKDIR /app
COPY package.json ./
# sharp (opcjonalny): automatyczne przycinanie i skalowanie banerów reklamowych; bez niego serwer tylko waliduje obrazy.
# Brak zależności produkcyjnych jest poprawny – instalacja opcjonalnego sharp nie może zatrzymać budowy obrazu.
RUN npm install --omit=dev --include=optional --no-audit --no-fund || true
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY plugins-bundled ./plugins-bundled
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
# aplikacja działa jako zwykły użytkownik (nie root); katalog danych należy do niego
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
