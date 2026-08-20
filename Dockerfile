FROM node:22-alpine
WORKDIR /app
RUN mkdir -p /data/jobs
COPY server.mjs ./server.mjs
COPY src ./src
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
