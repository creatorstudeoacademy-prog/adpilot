FROM node:20-slim
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
# Apply the schema to the volume DB at container start (volumes don't exist at build time).
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && npx remix-serve ./build/server/index.js"]
