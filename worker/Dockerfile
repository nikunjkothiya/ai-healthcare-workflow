FROM node:18-alpine

WORKDIR /app

# Copy worker files
COPY worker/package*.json ./

RUN npm install --omit=dev

COPY worker/worker.js ./

# Copy required backend modules
COPY backend/orchestrator ./backend/orchestrator
COPY backend/services ./backend/services

CMD ["node", "worker.js"]
