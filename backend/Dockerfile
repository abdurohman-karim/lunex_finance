# Lunex API, production image: docker build -t lunex-api backend/
# On start it applies the migrations and the reference data (both idempotent: the seed never
# overwrites what an administrator changed), then serves on $PORT (3000).
# Configure it with the variables of .env.example; NODE_ENV is production here.

FROM node:24-slim AS build
WORKDIR /app
# prisma.config.ts reads DATABASE_URL even to generate the client; no database is touched here.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# Migrations and the seed run with the Prisma CLI and tsx, so the dev tools stay in the image.
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npm run db:seed && npm run start:prod"]
