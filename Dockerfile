FROM mcr.microsoft.com/playwright:v1.42.0

# Install OpenVPN
RUN apt-get update && \
    apt-get install -y --no-install-recommends openvpn && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install --production

# Copy Prisma
COPY prisma ./prisma/
RUN npx prisma generate

# Copy app
COPY src ./src/
COPY public ./public/

# Copy VPN config
COPY vpn/ ./vpn/

EXPOSE 3000

ENV PUPPETEER_EXECUTABLE_PATH=/ms-playwright/chromium-1105/chrome-linux/chrome
ENV CHROME_BIN=/ms-playwright/chromium-1105/chrome-linux/chrome

CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
