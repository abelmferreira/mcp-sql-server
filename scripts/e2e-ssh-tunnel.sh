#!/bin/sh
# End-to-end test of the built-in SSH tunnel, 100% in throwaway containers:
#   - two internal docker networks (no route outside): the database network
#     (SQL Server + sshd) and the client network (sshd + test runner), so the
#     test runner can reach SQL Server ONLY through the SSH tunnel;
#   - mcr.microsoft.com/mssql/server:2022-latest with a random SA password and a
#     TLS certificate generated per run (CN/SAN = the container name), so the
#     certificate validation through the tunnel is tested too;
#   - an sshd (alpine + openssh) with host keys generated at start, an
#     unprivileged user and AllowTcpForwarding yes;
#   - a client ed25519 key with a random passphrase, generated per run;
#   - node:22-alpine running tests/integration/db/ssh-tunnel-mssql.test.ts twice:
#       1) the certificate is NOT trusted: SQL_TRUST_CERT=true works,
#          SQL_TRUST_CERT=false is refused;
#       2) the certificate IS trusted (NODE_EXTRA_CA_CERTS): SQL_TRUST_CERT=false
#          works because the certificate is checked against the ORIGINAL server
#          name (not 127.0.0.1), and a second name that the certificate does not
#          cover is refused.
# Nothing touches the host's ~/.ssh or any real server. Needs `npm ci` done
# (node_modules present) and docker. SQL Server needs ~2 GB of RAM and a
# linux/amd64 host (or emulation).
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ID="$$"
NET="mcp-mssql-e2e-$ID"
CLIENT_NET="mcp-mssql-e2e-client-$ID"
MS="mcp-mssql-e2e-db-$ID"
ALIAS="mcp-mssql-e2e-alias-$ID"
SSHD="mcp-mssql-e2e-sshd-$ID"
IMG="mcp-mssql-e2e-sshd:local"
MSSQL_IMG="${MSSQL_IMAGE:-mcr.microsoft.com/mssql/server:2022-latest}"
WORK="$(mktemp -d)"

rand() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# lower + upper + digits + symbol: satisfies the SQL Server password policy
MS_PASS="$(rand)Aa1!"
KEY_PASS="$(rand)"

cleanup() {
  docker rm -f "$MS" "$SSHD" >/dev/null 2>&1 || true
  docker network rm "$NET" "$CLIENT_NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

docker build -q -t "$IMG" - >/dev/null <<'EOF'
FROM alpine:3.22
RUN apk add --no-cache openssh-server openssh-keygen openssl \
 && adduser -D -s /sbin/nologin tunnel \
 && sed -i 's/^tunnel:!/tunnel:*/' /etc/shadow
CMD ["/bin/sh", "-c", "ssh-keygen -A >/dev/null && install -d -o tunnel -g tunnel -m 700 /home/tunnel/.ssh && printf '%s\\n' \"$PUBKEY\" > /home/tunnel/.ssh/authorized_keys && chown tunnel:tunnel /home/tunnel/.ssh/authorized_keys && chmod 600 /home/tunnel/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=no -o AllowTcpForwarding=yes -o AllowUsers=tunnel"]
EOF

# The directory is read by the mssql user (uid 10001) of the SQL Server container
chmod 755 "$WORK"

# Client key (encrypted with a random passphrase), owned by the calling user
docker run --rm --user "$(id -u):$(id -g)" -v "$WORK":/k "$IMG" \
  ssh-keygen -q -t ed25519 -N "$KEY_PASS" -C mcp-e2e -f /k/id_ed25519

# Self-signed TLS certificate for SQL Server: CN and SAN = the container name
# (the ALIAS name below is deliberately NOT in it)
docker run --rm --user "$(id -u):$(id -g)" -v "$WORK":/k "$IMG" \
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$MS" \
  -addext "subjectAltName=DNS:$MS" \
  -keyout /k/server.key -out /k/server.crt 2>/dev/null
chmod 644 "$WORK/server.key" "$WORK/server.crt"

cat > "$WORK/mssql.conf" <<EOF
[network]
tlscert = /certs/server.crt
tlskey = /certs/server.key
tlsprotocols = 1.2
forceencryption = 1
EOF
chmod 644 "$WORK/mssql.conf"

docker network create --internal "$NET" >/dev/null
docker network create --internal "$CLIENT_NET" >/dev/null
docker run -d --name "$MS" --network "$NET" --network-alias "$ALIAS" \
  -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$MS_PASS" \
  -v "$WORK":/certs:ro \
  -v "$WORK/mssql.conf":/var/opt/mssql/mssql.conf:ro \
  "$MSSQL_IMG" >/dev/null
docker run -d --name "$SSHD" --network "$NET" -e PUBKEY="$(cat "$WORK/id_ed25519.pub")" "$IMG" >/dev/null
docker network connect "$CLIENT_NET" "$SSHD"

echo "waiting for SQL Server..."
ready=0
for _ in $(seq 1 90); do
  if docker exec "$MS" /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MS_PASS" -Q "SELECT 1" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo "SQL Server did not become ready; last log lines:" >&2
  docker logs --tail 20 "$MS" >&2 || true
  exit 1
fi
for _ in $(seq 1 30); do
  docker exec "$SSHD" nc -z 127.0.0.1 22 2>/dev/null && break
  sleep 1
done

# All host key fingerprints, comma separated (exercises the list form)
FPS="$(docker exec "$SSHD" sh -c 'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f" | cut -d" " -f2; done' | paste -sd, -)"

run_tests() { # run_tests <extra docker args> -- <vitest args>
  docker run --rm --network "$CLIENT_NET" --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e TEST_SSH_HOST="$SSHD" \
    -e TEST_SSH_PORT=22 \
    -e TEST_SSH_USER=tunnel \
    -e TEST_SSH_KEY_PATH=/e2e/id_ed25519 \
    -e TEST_SSH_KEY_PASSPHRASE="$KEY_PASS" \
    -e TEST_SSH_HOST_FINGERPRINT="$FPS" \
    -e TEST_MSSQL_HOST="$MS" \
    -e TEST_MSSQL_ALIAS="$ALIAS" \
    -e TEST_MSSQL_PORT=1433 \
    -e TEST_MSSQL_USER=sa \
    -e TEST_MSSQL_PASSWORD="$MS_PASS" \
    -e TEST_MSSQL_DATABASE=master \
    -v "$REPO":/app -v "$WORK":/e2e:ro -w /app "$@"
}

echo "=== run 1: certificate NOT trusted ==="
run_tests node:22-alpine npx vitest run tests/integration/db/ssh-tunnel-mssql.test.ts

echo "=== run 2: certificate trusted (NODE_EXTRA_CA_CERTS) ==="
run_tests -e TEST_MSSQL_CA=true -e NODE_EXTRA_CA_CERTS=/e2e/server.crt node:22-alpine \
  npx vitest run tests/integration/db/ssh-tunnel-mssql.test.ts -t "TLS verification"
