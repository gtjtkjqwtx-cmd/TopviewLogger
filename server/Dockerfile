FROM node:20-slim

# Install Chromium and required system dependencies for headless Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libatk1.0-0 \
    libcups2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium and skip downloading its own Chrome binary
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package definition files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application source code
COPY . .

# Expose proxy port
EXPOSE 3001

CMD ["node", "countif-proxy.js"]
