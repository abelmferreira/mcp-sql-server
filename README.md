# MCP SQL Server

[![npm version](https://img.shields.io/npm/v/%40abelmferreira%2Fmcp-sql-server?cacheSeconds=300)](https://www.npmjs.com/package/@abelmferreira/mcp-sql-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.12-green.svg)](https://nodejs.org/)

A Model Context Protocol (MCP) server for **Microsoft SQL Server**. Query, monitor and analyze your databases directly from Claude Code (or any MCP client), read-only by default, with an optional built-in SSH tunnel.

It is a fork of [`@fabriciofs/mcp-sql-server`](https://github.com/fabriciofs/mcp-sql-server) (MIT) with a hardened `READONLY` mode, an SSH tunnel, `.env` file support, a Docker image and a publishing pipeline. It follows the same configuration conventions as its siblings `mcp-postgres` and `mcp-mysql`.

## Features

- **Query execution** - `SELECT` / `WITH` queries with named `@param` placeholders, bound by the driver (never concatenated into the SQL).
- **Schema exploration** - tables, views, columns, indexes, stored procedures, full table description.
- **Monitoring** - active queries, blocking chains, wait stats, connections, database size, performance counters.
- **Performance analysis** - missing, unused and duplicate indexes, fragmentation, statistics freshness, execution plans.
- **Read-only by design** - several independent layers of protection (see [Security](#security)).
- **Built-in SSH tunnel** - reach a database behind a bastion host with nothing but environment variables; the host key is always pinned.
- **Write operations** (`INSERT` / `UPDATE` / `DELETE`) only when explicitly enabled with `READONLY=false`.

## Requirements

- Node.js **>= 20.12** (only for the `npx` usage), or Docker.
- SQL Server 2016 or later (also Azure SQL / Azure SQL Managed Instance for most tools). Some monitoring/analysis tools need extra permissions, see [Permissions per tool](#permissions-per-tool).

## Quick start

The recommended way is `npx`, configured in your MCP client. For Claude Code, add it to `.mcp.json` in your project (or use `claude mcp add`). Every setting is an environment variable, passed in the `env` block.

### 1. Direct connection

```json
{
  "mcpServers": {
    "mydb": {
      "command": "npx",
      "args": ["-y", "@abelmferreira/mcp-sql-server"],
      "env": {
        "SQL_CONNECTION_URL": "sqlserver://app_reader:password@db.example.com:1433/MyDatabase?encrypt=true",
        "READONLY": "true"
      }
    }
  }
}
```

Or with individual parameters instead of the URL:

```json
"env": {
  "SQL_SERVER": "db.example.com",
  "SQL_PORT": "1433",
  "SQL_DATABASE": "MyDatabase",
  "SQL_USER": "app_reader",
  "SQL_PASSWORD": "password",
  "READONLY": "true"
}
```

### 2. Through an SSH tunnel (environment variables only)

When `SSH_HOST` is set the server opens the tunnel itself (an in-process `ssh -L` on a random `127.0.0.1` port). No `ssh` binary, helper script or Docker is needed. `SQL_SERVER:SQL_PORT` is the database address **as seen from the SSH host**.

```json
{
  "mcpServers": {
    "mydb": {
      "command": "npx",
      "args": ["-y", "@abelmferreira/mcp-sql-server"],
      "env": {
        "SQL_SERVER": "192.0.2.10",
        "SQL_PORT": "1433",
        "SQL_DATABASE": "MyDatabase",
        "SQL_USER": "app_reader",
        "SQL_PASSWORD": "password",
        "READONLY": "true",
        "SSH_HOST": "bastion.example.com",
        "SSH_USER": "tunnel",
        "SSH_KEY_PATH": "~/.ssh/mcp_tunnel_key",
        "SSH_HOST_FINGERPRINT": "SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

- `SSH_KEY_PATH` is a path on the machine running the MCP server. `~` is expanded; relative paths are resolved against the working directory chosen by the MCP client, so prefer absolute or `~/` paths.
- Encrypted keys need `SSH_KEY_PASSPHRASE`. A dedicated key without passphrase, restricted on the server (see below), is usually simpler.
- `SSH_HOST_FINGERPRINT` is mandatory: the host key is always verified and there is no "trust on first use". Get it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server, or `ssh-keyscan bastion.example.com | ssh-keygen -lf -` (and confirm it through another channel). A comma separated list is accepted (one per host key algorithm).
- The SSH session is opened at startup, so a bad key, host or fingerprint fails fast with a clear message on stderr. It is re-established automatically if it drops.
- **Named instances do not work through the tunnel.** `SQL_INSTANCE` is resolved by the SQL Server Browser service over UDP 1434, which an SSH tunnel cannot forward. Use the instance's fixed TCP port in `SQL_PORT` instead.

**Restrict the tunnel key on the SSH server.** In `~/.ssh/authorized_keys` of the tunnel user:

```
restrict,port-forwarding,permitopen="192.0.2.10:1433",command="/usr/sbin/nologin" ssh-ed25519 AAAA... mcp-tunnel
```

`restrict` disables everything (PTY, agent/X11 forwarding, user rc), `port-forwarding` re-enables only local forwarding, and `permitopen` limits it to the database address. `restrict` alone does **not** stop the key from running commands or opening a shell, so `command="/usr/sbin/nologin"` is needed to make it useless for anything but the tunnel.

### 3. Pointing to a project `.env` file (`ENV_FILE`)

Keep the configuration in a `.env` file of your project (git-ignored) and point the server at it:

```json
{
  "mcpServers": {
    "mydb": {
      "command": "npx",
      "args": ["-y", "@abelmferreira/mcp-sql-server"],
      "env": {
        "ENV_FILE": "/path/to/project/.env"
      }
    }
  }
}
```

- The file uses the usual dotenv syntax (`KEY=value`, `# comments`, quotes) and may contain any variable from the [table below](#environment-variables), including `SSH_*`.
- Variables set in the `env` block **win** over the file (same precedence as `node --env-file`), so you can share one file and override, for example, `READONLY` per client.
- `~` is expanded; relative paths are resolved against the working directory of the server process.
- A missing or unreadable file stops the server with an error on stderr (exit code 1). Values are never logged.

### 4. Docker

A public image is available on Docker Hub as `abelmferreira/mcp-sql-server`. The server speaks MCP over stdio, so run it with `-i` and without `-t`:

```json
{
  "mcpServers": {
    "mydb": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/path/to/project/.env",
        "abelmferreira/mcp-sql-server"
      ]
    }
  }
}
```

With the SSH tunnel, mount the key read-only and point `SSH_KEY_PATH` at the path **inside** the container:

```json
"args": [
  "run", "-i", "--rm",
  "--env-file", "/path/to/project/.env",
  "-e", "SSH_KEY_PATH=/run/secrets/ssh_key",
  "-v", "/home/me/.ssh/mcp_tunnel_key:/run/secrets/ssh_key:ro",
  "abelmferreira/mcp-sql-server"
]
```

Notes for Docker:

- `--env-file` is read by Docker itself, so use it instead of `ENV_FILE` (the container cannot see host paths unless you mount them). Docker's `--env-file` does not strip quotes: write `KEY=value`, not `KEY="value"`.
- The image runs as the unprivileged `node` user (uid 1000). A key file that is `0600` and owned by another uid is not readable by it: add `--user "$(id -u):$(id -g)"`.
- If the database runs on the Docker host, use `host.docker.internal` (add `--add-host=host.docker.internal:host-gateway` on Linux) instead of `localhost`.
- The SSH tunnel listens on `127.0.0.1` inside the container only.
- When the MCP client closes the pipe (stdin), the server closes the pool and the tunnel and exits, so `docker run -i` does not leave orphan containers.

## Environment variables

| Variable | Required | Default | Description |
| -------- | -------- | ------- | ----------- |
| `ENV_FILE` | no | - | Path of a dotenv file to load first. Variables already in the environment win. `~` and relative paths are supported |
| `SQL_CONNECTION_URL` | no\* | - | `sqlserver://user:pass@host:port/database?encrypt=true&TrustServerCertificate=false&instanceName=name` (`mssql://` also accepted; URL-encode special characters in the password) |
| `SQL_SERVER` | no\* | - | Database host (as seen from the SSH host when the tunnel is enabled) |
| `SQL_DATABASE` | no\* | - | Database name |
| `SQL_USER` | no\* | - | SQL Server login |
| `SQL_PASSWORD` | no\* | - | Password |
| `SQL_PORT` | no | `1433` | TCP port |
| `SQL_INSTANCE` | no | - | Named instance (resolved by SQL Server Browser, UDP 1434). Not supported with the SSH tunnel |
| `SQL_ENCRYPT` | no | `true` | Encrypt the connection (TLS) |
| `SQL_TRUST_CERT` | no | `false` | `true` accepts any server certificate without validating it (see [TLS](#tls)) |
| `READONLY` | **yes** | - | `true` (read-only, recommended) or `false` (enables write tools) |
| `QUERY_TIMEOUT` | no | `30000` | Query timeout in ms (max `120000`) |
| `MAX_ROWS` | no | `1000` | Max rows returned per query (max `5000`); caps the `maxRows` argument of the tools |
| `MAX_RESULT_BYTES` | no | `10485760` | Max size of one query result (approximate, in bytes; `1024`..`104857600`). Larger results are cut and flagged `truncated` |
| `POOL_MIN` | no | `2` | Minimum pool size |
| `POOL_MAX` | no | `10` | Maximum simultaneous database connections |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` (logs go to stderr) |
| `SSH_HOST` | no | - | Enables the built-in SSH tunnel |
| `SSH_PORT` | no | `22` | SSH port |
| `SSH_USER` | with `SSH_HOST` | - | SSH user |
| `SSH_KEY_PATH` | with `SSH_HOST` | - | Private key path (`~` supported; inside the container when using Docker) |
| `SSH_KEY_PASSPHRASE` | no | - | Passphrase of an encrypted key |
| `SSH_HOST_FINGERPRINT` | with `SSH_HOST` | - | Pinned host key fingerprint(s), `SHA256:...`, comma separated |

\* Provide either `SQL_CONNECTION_URL` **or** `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER` and `SQL_PASSWORD`. When the URL is set it takes precedence. See [`.env.example`](.env.example) for a commented template.

## Security

The server is meant to be driven by an AI assistant, which can be manipulated by the content it reads (prompt injection). Read-only access is therefore enforced by several independent layers. **The first one is the real boundary**; the others are defence in depth and must not be relied upon alone.

### 1. A login that can only read (the real boundary)

Create a dedicated login and user with `db_datareader` only, on the database it needs:

```sql
-- in master
CREATE LOGIN mcp_readonly WITH PASSWORD = '<a-strong-password>', CHECK_POLICY = ON;

-- in the target database
CREATE USER mcp_readonly FOR LOGIN mcp_readonly;
ALTER ROLE db_datareader ADD MEMBER mcp_readonly;

-- optional, only for the tools that need it (see "Permissions per tool"):
-- GRANT VIEW DATABASE STATE TO mcp_readonly;      -- fragmentation, duplicate-index sizes
-- GRANT VIEW DEFINITION TO mcp_readonly;          -- stored procedure source
-- GRANT SHOWPLAN TO mcp_readonly;                 -- analyze_query execution plans
-- GRANT VIEW SERVER STATE TO mcp_readonly;        -- server-wide monitor tools (broader: see below)
```

- Do **not** add the login to `db_datawriter`, `db_owner`, `sysadmin` or any other role, and do not grant `EXECUTE`, `ALTER`, `CONTROL` or `ADMINISTER BULK OPERATIONS`.
- `VIEW SERVER STATE` (a server-level permission) exposes the text of every running query on the instance, including other applications' literals. Grant it only if you need `monitor_*` and the missing-index tool, and prefer a dedicated login for that purpose.
- `ApplicationIntent=ReadOnly` is a routing hint for availability-group readable secondaries; it does **not** stop writes on a primary and is not a security measure. The login's permissions are.
- Stored functions and CLR assemblies visible to the login run with its permissions; a keyword list cannot know them. Only the permissions can stop them.
- Do not let the login read tables holding secrets you do not want an AI assistant to see (`db_denydatareader` on a schema, or `DENY SELECT`).

### 2. Query validator (`READONLY=true`)

A lexer that mirrors the T-SQL one splits the query into tokens (string literals, `[bracketed]` and `"quoted"` identifiers, nested `/* */` comments, `--` comments, variables, words). The validator then checks **the exact text sent to the server** (the `@param` placeholders stay in the text and are bound by the driver as RPC parameters, so the parameter values can never become SQL). It accepts a single `SELECT` / `WITH` statement and rejects:

- more than one statement or batch: a `;` followed by another statement, `GO`, and the statement keywords that can follow a missing semicolon (T-SQL does not need one);
- `EXEC` / `EXECUTE`, `sp_executesql`, `xp_*` and `sp_*` names, `OPENROWSET`, `OPENQUERY`, `OPENDATASOURCE`, `BULK`;
- `INTO` (`SELECT ... INTO` creates a table), `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `CREATE`, `ALTER`, `DROP`, `GRANT`, `REVOKE`, `DENY`, `BACKUP`, `RESTORE`, `DBCC`, `KILL`, `SHUTDOWN`, `RECONFIGURE`, `USE`, `SET`, `DECLARE`, `WAITFOR` and similar;
- locking hints that hold locks on other sessions (`UPDLOCK`, `XLOCK`, `TABLOCKX`, `HOLDLOCK`, `SERIALIZABLE`), `NEXT VALUE FOR` (sequences are not rolled back), and Service Broker / trigger statements (`RECEIVE`, `SEND ON`, `MOVE CONVERSATION`, `ENABLE TRIGGER`, ...);
- unterminated strings, identifiers or comments, NUL and other control characters, and non-ASCII characters that are not letters or digits outside quoted text.

Words are matched as tokens, never inside string literals, bracketed identifiers or comments, so `SELECT '--'; DELETE FROM t` and `SELECT ... /* ; DELETE */` are classified correctly. A column that happens to be named like a blocked word must be written as `[column]`.

### 3. Every query is rolled back

With `READONLY=true` each query runs inside an explicit transaction that always ends in `ROLLBACK`, whether the query succeeded, failed or timed out. Locks are held for the duration of the query only.

### 4. Bounded results and time

- The row limit is applied by **streaming**: rows are read one by one and reading stops (the request is cancelled on the server) after `maxRows` (capped by `MAX_ROWS`) or `MAX_RESULT_BYTES`. The result is flagged `"truncated": true`, so a huge result never fills the memory of the process.
- `QUERY_TIMEOUT` cancels the query on the server and rolls the transaction back.

### 5. Query log

Every query is logged to stderr with its duration, number of rows, `truncated` flag, number of parameters and the first 200 characters of the SQL text. **Parameter values are never logged.** Passwords are redacted from all logs; nothing but MCP protocol messages is written to stdout.

### TLS

`SQL_ENCRYPT=true` (default) encrypts the connection. With `SQL_TRUST_CERT=false` (default) the server certificate is validated (chain and name) against the system CA store.

- **Direct connection:** the certificate must be valid for `SQL_SERVER`.
- **Through the SSH tunnel:** the driver connects to `127.0.0.1`, but the certificate is issued for the database's real name. The server therefore sets the TLS server name (`options.serverName`) to `SQL_SERVER`, so with `SQL_TRUST_CERT=false` the certificate is still validated against the original name. `SQL_SERVER` must then be a name the certificate covers (an IP address only works if the certificate lists it).
- `SQL_TRUST_CERT=true` accepts **any** certificate without validating it, with or without the tunnel (a warning is logged). It is meant for development and for servers with a self-signed certificate; the tunnel's pinned host key protects the path to the SSH host, but not the last hop from there to the database.

### Other measures

The SSH host key is always verified against `SSH_HOST_FINGERPRINT` (format checked at startup; on mismatch the received fingerprint is logged to stderr so it can be compared), and the tunnel listens on `127.0.0.1` only.

### Known limitations

- The validator is a lexical filter, not a T-SQL parser: it cannot know what a function or view defined in the database does. It is not a substitute for the login's permissions.
- With `READONLY=false` none of the checks above applies to `sql_execute` and the write tools run with the login's permissions.
- `MAX_RESULT_BYTES` is approximate.

## Permissions per tool

Needs on top of `db_datareader` (catalog views such as `sys.tables` or `sys.columns` list only the objects the login can see; `db_datareader` makes all tables and views visible). On SQL Server 2022 and Azure SQL the narrower `VIEW SERVER PERFORMANCE STATE` / `VIEW DATABASE PERFORMANCE STATE` can replace `VIEW SERVER STATE` / `VIEW DATABASE STATE`. Without a permission a tool answers with an error (or a warning for the optional parts of `analyze_query`).

These requirements were checked against SQL Server 2022 with real logins (`db_datareader` only, `db_datareader` + `VIEW DATABASE STATE`, and `db_datareader` + `VIEW SERVER STATE` + `VIEW DATABASE STATE` + `VIEW DEFINITION` + `SHOWPLAN`) by `tests/integration/tools/real-tools-mssql.test.ts`: the last combination runs all 17 read tools; `db_datareader` alone runs `sql_execute`, `schema_list_tables`, `schema_describe_table`, `schema_list_columns`, `schema_list_procedures`, `monitor_database_size` and `analyze_statistics`. `VIEW DEFINITION` is documented for the procedure source, but the test database has no stored procedures, so that row is not verified.

| Tool | Catalog views / DMVs used | Permission beyond `db_datareader` |
| ---- | ------------------------- | --------------------------------- |
| `sql_execute` | the queried objects | none |
| `schema_list_tables` | `sys.tables`, `sys.views`, `sys.schemas`, `sys.partitions`, `sys.allocation_units` | none |
| `schema_describe_table` | `sys.tables`, `sys.columns`, `sys.types`, `sys.indexes`, `sys.index_columns`, `sys.foreign_keys`, `sys.foreign_key_columns`, `sys.extended_properties`, `sys.partitions`, `sys.allocation_units` | none |
| `schema_list_columns` | `sys.columns`, `sys.tables`, `sys.types`, `sys.schemas`, `sys.extended_properties` | none |
| `schema_list_procedures` | `sys.procedures`, `sys.parameters`, `sys.schemas`, `OBJECT_DEFINITION()` | `VIEW DEFINITION` (procedures are invisible, and their source is `NULL`, without it) |
| `schema_list_indexes` | `sys.indexes`, `sys.index_columns`, `sys.dm_db_index_usage_stats`, `sys.dm_db_partition_stats` | `VIEW SERVER STATE` (index usage DMV) |
| `monitor_active_queries` | `sys.dm_exec_requests`, `sys.dm_exec_sessions`, `sys.dm_exec_sql_text` | `VIEW SERVER STATE` (without it only your own session is visible) |
| `monitor_blocking` | `sys.dm_exec_requests`, `sys.dm_exec_sessions`, `sys.dm_exec_sql_text` | `VIEW SERVER STATE` |
| `monitor_connections` | `sys.dm_exec_connections`, `sys.dm_exec_sessions` | `VIEW SERVER STATE` |
| `monitor_wait_stats` | `sys.dm_os_wait_stats` | `VIEW SERVER STATE` |
| `monitor_performance_counters` | `sys.dm_os_performance_counters` | `VIEW SERVER STATE` |
| `monitor_database_size` | `sys.database_files`, `sys.tables`, `sys.indexes`, `sys.partitions`, `sys.allocation_units` | none |
| `analyze_query` | `SHOWPLAN_XML` (estimated plan, the statement is not executed), `sys.dm_exec_query_stats`, `sys.dm_exec_sql_text` | `SHOWPLAN` (plan) and `VIEW SERVER STATE` (cached runtime statistics); each part degrades to a warning when missing |
| `analyze_suggest_indexes` | `sys.dm_db_missing_index_details`, `sys.dm_db_missing_index_groups`, `sys.dm_db_missing_index_group_stats` | `VIEW SERVER STATE` |
| `analyze_unused_indexes` | `sys.indexes`, `sys.dm_db_index_usage_stats`, `sys.dm_db_partition_stats` | `VIEW SERVER STATE` (index usage DMV) |
| `analyze_duplicate_indexes` | `sys.indexes`, `sys.index_columns`, `sys.columns`, `sys.dm_db_partition_stats` | `VIEW DATABASE STATE` |
| `analyze_fragmentation` | `sys.dm_db_index_physical_stats`, `sys.indexes` | `VIEW DATABASE STATE` |
| `analyze_statistics` | `sys.stats`, `sys.stats_columns`, `sys.dm_db_stats_properties` | none (`SELECT` on the table) |
| `sql_insert`, `sql_update`, `sql_delete` | the target table (`READONLY=false` only) | `db_datawriter` or `INSERT` / `UPDATE` / `DELETE` on it |

## Available tools

| Category | Tools |
| -------- | ----- |
| Query | `sql_execute` |
| Schema | `schema_list_tables`, `schema_list_columns`, `schema_describe_table`, `schema_list_indexes`, `schema_list_procedures` |
| Monitor | `monitor_active_queries`, `monitor_connections`, `monitor_blocking`, `monitor_wait_stats`, `monitor_database_size`, `monitor_performance_counters` |
| Analyze | `analyze_query`, `analyze_suggest_indexes`, `analyze_unused_indexes`, `analyze_duplicate_indexes`, `analyze_fragmentation`, `analyze_statistics` |
| Write\* | `sql_insert`, `sql_update`, `sql_delete` |

\* Only registered when `READONLY=false`.

`sql_execute` returns `rows`, `rowCount` (rows returned), `fields`, `duration` and `truncated`; when `truncated` is `true` there were more rows (or more data) than returned. The `schema` argument of the schema tools defaults to `dbo` where a default applies.

Once configured, you can ask your assistant things like:

```
"List all tables in the database"
"Describe the Orders table"
"Show me active queries running for more than 5 seconds"
"Find unused indexes in the Orders table"
"What are the top wait statistics?"
```

## Development

Clone the repository, then use Docker so nothing has to be installed on the host:

```bash
git clone https://github.com/abelmferreira/mcp-sql-server.git
cd mcp-sql-server

# Typecheck + unit tests (no database needed)
docker build --target test .

# Or interactively
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app node:22-alpine \
  sh -c 'npm ci && npm run typecheck && npm test && npm run build'

# Local image
docker build -t mcp-sql-server:local .
```

The tests that need a real SQL Server are skipped unless `TEST_MSSQL_SERVER` (plus `TEST_MSSQL_PORT` and `TEST_MSSQL_PASSWORD` of the `sa` login) point to one. `scripts/test-mssql.sh` does it all in throwaway containers: it starts `mcr.microsoft.com/mssql/server:2022-latest` on an internal network with a password generated on the spot, runs the whole suite (unit tests plus the real-server tests: read-only barrier, row/byte limits, timeout, every tool with several logins) and removes everything. `scripts/e2e-ssh-tunnel.sh` does the same for the SSH tunnel (disposable SQL Server and `sshd`, TLS validation through the tunnel, shutdown on closed stdin). Never point these tests at a real database.

With Node.js >= 20.12 on the host the usual scripts work too: `npm ci`, `npm run build`, `npm test`, `npm start` (reads `./.env`), `npm run inspector` (MCP Inspector). Releases are described in [docs/RELEASING.md](docs/RELEASING.md).

## Acknowledgements

This project is a fork of [**mcp-sql-server**](https://github.com/fabriciofs/mcp-sql-server) ([`@fabriciofs/mcp-sql-server`](https://www.npmjs.com/package/@fabriciofs/mcp-sql-server)) by **fabriciofs**, released under the MIT License. The tool set and the overall structure come from it; the `READONLY` hardening, the SSH tunnel, `ENV_FILE`, the Docker image and the publishing pipeline were added in this fork.

## License

[MIT](LICENSE). Copyright (c) 2024 fabriciofs (original work) and (c) 2026 Abel Ferreira (fork).
