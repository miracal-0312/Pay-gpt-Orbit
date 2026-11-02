FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 TASK_LOG_DIR=/var/log/pay-gpt-orbit
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
RUN mkdir -p /var/log/pay-gpt-orbit
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
