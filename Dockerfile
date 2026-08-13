# ============================
# Stage 1: Client Builder
# ============================
FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

# Cache dependencies first (speeds up rebuilds)
COPY frontend/package.json ./frontend/
RUN cd frontend && bun install

# Copy source and build
COPY frontend ./frontend
RUN cd frontend && bun run build

# ============================
# Stage 2: Production
# ============================
FROM oven/bun:1.3.14-alpine
WORKDIR /app

# Install system deps
RUN apk add --no-cache tzdata curl
ENV TZ=Asia/Kuala_Lumpur

# Install PM2 globally using Bun
RUN bun add -g pm2

# Copy backend and install deps
COPY backend/package.json ./backend/
RUN cd backend && bun install --production

# Copy backend source code
COPY backend ./backend

# Copy main package.json, pm2 config and .env (if present)
COPY package.json ./
COPY ecosystem.config.js ./

# Copy built client bundle — the static server reads frontend/dist (backend/config.js CLIENT_DIR)
COPY --from=builder /app/frontend/dist ./frontend/dist

# Set proper permissions so the user can write to them
# RUN chown -R 1000:1000 /app/downloads

EXPOSE 5000

# If you use PM2 ecosystem
CMD ["bun", "start"]
