FROM node:24-slim

# bash-tool + just-bash are pure-JS — no native build tools needed.
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .

# Long-polling Telegram worker — no inbound port needed
CMD ["pnpm", "run", "start:prod"]
