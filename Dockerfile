# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.15.0-bookworm-slim

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.source="https://github.com/HURDOO/plantapi"
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN chmod -R a+rX /app
USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
