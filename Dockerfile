# iExplore runner image. Playwright's image already has Chromium and its system libraries.
# Keep the tag in step with the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
ENV NODE_ENV=production IEXPLORE_PROVIDER=bedrock AWS_REGION=ap-southeast-2
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
COPY personas ./personas
COPY charters ./charters
COPY seed ./seed
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/iexplore-job
# 1001 = pwuser in the Playwright image; numeric so Kubernetes runAsNonRoot can verify it
RUN mkdir -p runs knowledge triage && chown -R 1001:1001 /app
USER 1001
ENTRYPOINT ["iexplore-job"]
CMD ["run"]
