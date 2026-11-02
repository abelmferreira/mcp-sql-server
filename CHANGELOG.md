# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - Unreleased

First release as `@abelmferreira/mcp-sql-server` (npm) and
`abelmferreira/mcp-sql-server` (Docker Hub), a fork of
[`@fabriciofs/mcp-sql-server`](https://github.com/fabriciofs/mcp-sql-server) (MIT)
aligned with `mcp-postgres` and `mcp-mysql`.

### Added

- `ENV_FILE`: load a dotenv file before validating the configuration
  (variables already in the environment win).
- Built-in SSH tunnel (`ssh2`), configured only through `SSH_*` variables; the
  host key is always pinned (`SSH_HOST_FINGERPRINT`, format checked at startup).
  Through the tunnel the TLS server name is kept as `SQL_SERVER`, so certificates
  are still validated against the original name.
- Hardened `READONLY` mode:
  - lexical T-SQL validator on the exact SQL sent to the server (strings,
    `[brackets]`, `"quotes"`, nested comments): single statement, no `GO`,
    `EXEC`/`sp_executesql`, `OPENROWSET`/`OPENQUERY`/`OPENDATASOURCE`, `xp_*`,
    `INTO`, `BULK` and other write/DDL/admin statements;
  - every query runs in a transaction that always ends in `ROLLBACK`;
  - the row limit is applied by streaming (`MAX_ROWS`, `MAX_RESULT_BYTES`) and
    the result carries a `truncated` flag;
  - per-query log (duration, rows, truncated, number of parameters, first 200
    characters), never the parameter values.
- Graceful shutdown when the client closes stdin, and on `SIGINT` / `SIGTERM` /
  `SIGHUP`, so `docker run -i` leaves no orphan process or tunnel.
- The MCP handshake version is read from `package.json`.
- Docker image (multi-stage, non-root) and GitHub Actions for CI and publishing
  (npm Trusted Publishing with provenance, multi-arch image on Docker Hub).
- Tests against a real SQL Server in a throwaway container, including proof that
  the database refuses writes for a `db_datareader` login even without the
  validator, and an end-to-end SSH tunnel test.
- Documentation: recommended `db_datareader` login, permissions per tool, TLS
  behaviour with the tunnel, `docs/RELEASING.md`.

### Changed

- Package renamed to `@abelmferreira/mcp-sql-server`; Node.js `>=20.12.0`.
- `.env.example` documents every variable.

### Known limitations

- `SQL_INSTANCE` (named instances, resolved by SQL Server Browser over UDP 1434)
  cannot be used with the SSH tunnel; use `SQL_PORT`.

[1.0.0]: https://github.com/abelmferreira/mcp-sql-server/releases/tag/v1.0.0
