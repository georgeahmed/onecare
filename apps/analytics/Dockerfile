# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* .npmrc* ./
COPY packages ./packages
COPY apps ./apps
COPY schemas ./schemas
COPY tsconfig.base.json tsconfig.json ./

RUN npm ci --ignore-scripts
RUN npm_config_workspaces=false ./node_modules/.bin/tsc -b apps/analytics

WORKDIR /app/apps/analytics
CMD ["node", "dist/runtime.js"]
