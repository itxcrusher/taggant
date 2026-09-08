# The console, as an image.
#
# Two stages, the same shape as the resolver's: one that has the workspace and a package
# manager, one that has only what runs. This one is bigger than the resolver's on purpose,
# because the console compiles artwork and that means sharp, which is a native module.
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
COPY apps/console/package.json apps/console/
RUN corepack enable && corepack prepare pnpm@11.1.3 --activate
RUN pnpm install --frozen-lockfile --filter @taggant/console...

COPY packages packages
COPY services services
COPY apps apps
# Every package the console imports is built, because a published bundle carries the
# runtime's build rather than pointing at it: without this the console starts, authors,
# compiles, and then fails at the one step that matters.
RUN pnpm --filter @taggant/console... build

# `deploy` resolves the workspace links into a directory that stands on its own, which is
# what makes a second stage possible at all when there are real dependencies to carry.
#
# `--legacy` because the newer mode wants injected workspace packages declared across the
# whole workspace, and changing how every developer installs in order to build one image
# is the wrong way round.
RUN pnpm --filter @taggant/console --prod deploy --legacy /deploy

FROM node:22-alpine AS runtime
WORKDIR /srv

RUN addgroup -S taggant && adduser -S -G taggant taggant
COPY --from=build --chown=taggant:taggant /deploy /srv
USER taggant

ENV NODE_ENV=production
EXPOSE 4000

# The console writes: the workspace it authors into, the folder it publishes to, and the
# resolver's link table. All three are mounted, and none of them is in the image.
VOLUME ["/srv/workspace", "/srv/bundles", "/srv/links"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Binds to every interface inside the container, which is the only way the port mapping
# can reach it. That is safe exactly as far as the mapping is: the compose file publishes
# it on the loopback address only, and this console has no authentication.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["/srv/workspace", "--port", "4000", "--host", "0.0.0.0", "--publish-to", "/srv/bundles", "--links", "/srv/links/links.json"]
