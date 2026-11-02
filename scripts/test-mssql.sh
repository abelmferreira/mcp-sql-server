#!/bin/sh
# Runs the test suite (unit + tests against a REAL SQL Server) entirely in
# throwaway containers:
#   - mcr.microsoft.com/mssql/server on an internal docker network, with an SA
#     password generated on the spot (never written to a file);
#   - node:22-alpine running vitest as the calling user.
# Nothing is installed on the host and no existing database is touched.
#
#   scripts/test-mssql.sh                       whole suite
#   scripts/test-mssql.sh tests/integration     arguments go to `vitest run`
#
# Needs `npm ci` done (node_modules present) and docker.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ID="$$"
NET="mcp-mssql-test-$ID"
DB="mcp-mssql-test-db-$ID"
IMAGE="${MSSQL_IMAGE:-mcr.microsoft.com/mssql/server:2022-latest}"
SA_PASSWORD="Aa1!$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"

cleanup() {
  docker rm -f "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" \
  -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$SA_PASSWORD" "$IMAGE" >/dev/null

echo "Waiting for SQL Server..."
ready=0
for _ in $(seq 1 90); do
  if docker exec -e SQLCMDPASSWORD="$SA_PASSWORD" "$DB" /opt/mssql-tools18/bin/sqlcmd \
       -C -S 127.0.0.1 -U sa -Q "SELECT 1" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || { echo "SQL Server did not start" >&2; docker logs "$DB" | tail -20 >&2; exit 1; }

docker run --rm --network "$NET" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e TEST_MSSQL_SERVER="$DB" -e TEST_MSSQL_PORT=1433 -e TEST_MSSQL_PASSWORD="$SA_PASSWORD" \
  -v "$REPO":/app -w /app node:22-alpine npx vitest run "$@"
