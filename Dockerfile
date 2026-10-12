FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "src/main.ts"]
