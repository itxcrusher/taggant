# The resolver, as an image.
#
# Two stages: one that has the whole workspace and a package manager, and one that has the
# built service and a Node runtime. Nothing from the first stage reaches the second except
# the output, so the image carries no source, no package manager and no build tooling.
FROM node:22-alpine AS build
WORKDIR /repo

# The manifests first, so a change to source does not invalidate the installed layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/manifest/package.json packages/manifest/
COPY packages/vision/package.json packages/vision/
COPY packages/compiler/package.json packages/compiler/
COPY packages/runtime/package.json packages/runtime/
COPY packages/bundler/package.json packages/bundler/
COPY services/resolver/package.json services/resolver/
RUN corepack enable && corepack prepare pnpm@11.1.3 --activate
# The resolver has no dependencies of its own; the rest of the workspace is not installed,
# which is why this is quick and why sharp never has to build here.
RUN pnpm install --frozen-lockfile --filter @taggant/resolver...

COPY services/resolver services/resolver
RUN pnpm --filter @taggant/resolver build

FROM node:22-alpine AS runtime
WORKDIR /srv

# Runs as a user that is not root and owns nothing it does not need to.
RUN addgroup -S taggant && adduser -S -G taggant taggant
COPY --from=build --chown=taggant:taggant /repo/services/resolver/dist ./dist
COPY --from=build --chown=taggant:taggant /repo/services/resolver/package.json ./package.json
USER taggant

ENV NODE_ENV=production
EXPOSE 8080

# Liveness from inside the container, so an orchestrator that only knows how to run a
# command still gets a real answer.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The link table is mounted rather than baked in. It is the one thing that changes without
# the code changing, and baking it would mean rebuilding an image to add a product.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["/srv/links/links.json", "--port", "8080"]
