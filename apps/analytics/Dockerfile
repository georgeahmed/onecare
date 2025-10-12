# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* .npmrc* ./
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.base.json tsconfig.json ./

RUN npm ci --ignore-scripts
RUN npm run build --workspaces

WORKDIR /app/apps/analytics
CMD ["node", "dist/runtime.js"]
