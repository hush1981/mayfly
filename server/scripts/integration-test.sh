#!/bin/sh
# Runs the API integration tests against a throwaway PostgreSQL in Docker.
# Usage: server/scripts/integration-test.sh   (needs docker; removes everything afterwards)
set -eu
cd "$(dirname "$0")/.."
NET=mayfly-it-$$
DB=mayfly-it-db-$$
cleanup() { docker rm -f "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_USER=it -e POSTGRES_PASSWORD=it -e POSTGRES_DB=it postgres:16-alpine >/dev/null
until docker exec "$DB" pg_isready -U it >/dev/null 2>&1; do sleep 1; done
sleep 2
docker run --rm --network "$NET" -v "$PWD":/build -w /build \
  -e DATABASE_URL="postgres://it:it@$DB:5432/it" \
  -e JWT_SECRET="integration-test-secret-integration-test" \
  -e STORAGE_PATH=/tmp/it \
  -v gomodcache:/go/pkg/mod golang:1.27-alpine sh -c 'go vet ./... && go test ./... && go test -tags integration -count=1 -v ./cmd/server/' 
