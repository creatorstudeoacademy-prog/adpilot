FROM node:20-slim
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY . .
RUN npx prisma generate
RUN npx prisma db push --accept-data-loss
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "remix-serve", "./build/server/index.js"]
