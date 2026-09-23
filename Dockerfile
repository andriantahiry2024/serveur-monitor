# Tableau de bord de supervision — image minimale, sans dépendance npm.
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST_PROC=/host/proc \
    HOST_SYS=/host/sys \
    HOST_ROOT=/host/root

# Aucune dépendance externe : seuls les fichiers de l'application sont copiés.
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

# Ces trois montages (lecture seule) donnent les métriques RÉELLES de l'hôte :
#   -v /proc:/host/proc:ro   -v /sys:/host/sys:ro   -v /:/host/root:ro
# Sans eux, l'application retombe sur la vue du conteneur (CPU/RAM de l'hôte
# quand même, disques du conteneur).

RUN apk add --no-cache curl \
 && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
