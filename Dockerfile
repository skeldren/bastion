FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

FROM node:24-alpine
ARG SKELDREN_BASTION_VERSION=dev
WORKDIR /app
RUN apk upgrade --no-cache libcrypto3 libssl3 \
  && addgroup -S -g 10001 skeldren && adduser -S -D -H -u 10001 -G skeldren skeldren \
  && mkdir -p /var/lib/skeldren-bastion \
  && chown -R skeldren:skeldren /var/lib/skeldren-bastion \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build --chown=skeldren:skeldren /app/dist ./dist
USER 10001:10001
ENV NODE_ENV=production
ENV SKELDREN_BASTION_VERSION=${SKELDREN_BASTION_VERSION}
CMD ["node", "dist/index.js"]
