# Releasing `@abelmferreira/mcp-sql-server`

Two artifacts come from the same git tag `vX.Y.Z`:

| Artifact | Where | Workflow |
|---|---|---|
| npm package | `@abelmferreira/mcp-sql-server` | `.github/workflows/publish-npm.yml` (Trusted Publishing / OIDC, no token) |
| Docker image | `abelmferreira/mcp-sql-server` on Docker Hub (amd64 + arm64) | `.github/workflows/publish-docker.yml` (variable `DOCKERHUB_USERNAME`, secret `DOCKERHUB_TOKEN`) |

Cut a release from a green `main`: bump the version in `package.json`, `package-lock.json` and
`CHANGELOG.md`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. Both workflows check that
the tag matches `package.json`. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next`
and never move the Docker `latest` tag.

## Before the first push of the repository

The history of a public repository cannot be cleaned afterwards. Check it first:

```bash
git log --all --oneline -- .mcp.json memory .env     # must print nothing
docker run --rm -v "$PWD":/repo:ro zricethezav/gitleaks:latest detect --source /repo --no-banner --redact
```

- `.mcp.json`, `memory/`, `.claude/` and `.env*` (except `.env.example`) must never be in any commit
  (they are in `.gitignore`). Memories and notes about working with an AI assistant live outside the repository.
- Review gitleaks findings one by one: a column named `key_columns` in a SQL string is a false
  positive, a password is not. If a real secret is in the history, rotate it **and** start from a clean
  root commit; do not just delete it in a later commit.
- The commit author must be the identity you want public. (A global git hook may restrict the allowed
  e-mail domains; do not bypass it, change `user.email` for the repository instead.)

## GitHub and Docker Hub settings

Repository *Settings -> Secrets and variables -> Actions*:

| Name | Kind | Value |
|---|---|---|
| `DOCKERHUB_USERNAME` | **Variable** (Variables tab) | Docker Hub user or organization |
| `DOCKERHUB_TOKEN` | **Secret** | Docker Hub access token with read/write on the repository |

The workflow reads `${{ vars.DOCKERHUB_USERNAME }}` and `${{ secrets.DOCKERHUB_TOKEN }}`. If the
username is stored as a *secret* instead, `docker/login-action` receives an empty value and fails with
`Username required`. There is no `NPM_TOKEN`: npm uses OIDC.

Create the Docker Hub repository `abelmferreira/mcp-sql-server` (public) beforehand. Its description
field is limited to **100 characters**. The workflow does not sync it; edit it on hub.docker.com.

## First publish (manual) — what actually worked

npm Trusted Publishing can only be configured **after** the package exists, so the first version
has to be published by hand. This was harder than expected; the notes below are the result.

1. **`publishConfig.provenance: true` breaks local publishes.** Provenance only works inside
   GitHub Actions. A local `npm publish` fails with
   `Automatic provenance generation not supported for provider: null`.
   Publish locally with `--provenance=false`.
2. **`npm login` (browser flow) did not work.** After logging in, the publish was rejected with
   `403 Forbidden - Two-factor authentication or granular access token with bypass 2fa enabled is
   required to publish packages.` Retrying with the same login did not help.
3. **What worked: a granular access token with "Bypass two-factor authentication" checked.**
   - npmjs.com -> Access Tokens -> Generate New Token -> *Granular Access Token*.
   - Permissions: read and write on packages; scope `@abelmferreira` (or all packages — the package
     does not exist yet, so it cannot be selected by name).
   - Tick **Bypass two-factor authentication**. Tokens last at most 90 days.
   - The token goes in `~/.npmrc` (mode 600) as `//registry.npmjs.org/:_authToken=...`. Never paste
     it into the repository, a workflow, an issue or a chat.
4. **Revoke the token right after the first publish** (npmjs.com -> Access Tokens).

The helper script `npm.sh` in the parent directory of this repository does all of this in a
container (`node:22-alpine`, no npm on the host). It asks for the token if `~/.npmrc` has none and
stores it with mode 600:

```bash
cd ..                                   # the directory that contains mcp-sql-server/
./npm.sh dry-run mcp-sql-server         # builds the package and lists its contents, publishes nothing
./npm.sh publish mcp-sql-server         # asks for confirmation, publishes with --provenance=false
./npm.sh logout                         # removes the token from ~/.npmrc afterwards
```

Run it only from a committed and pushed state; a published version can be unpublished only within 72 hours.

## Configure the trusted publisher (once, after the first publish)

npmjs.com -> package -> Settings -> Trusted Publisher -> GitHub Actions:

- Owner: `abelmferreira`
- Repository: `mcp-sql-server`
- Workflow filename: `publish-npm.yml`
- Environment: leave empty

Then, under **Allowed actions**, tick **Allow npm publish**. Without it the pipeline is refused with
`OIDC permission denied for this action`. Leave **Allow npm dist-tag** unticked. Finally tick
"Require two-factor authentication and disallow tokens" and **revoke the access token** used for the
manual publish. From then on a `v*` tag publishes to npm with provenance and no stored token.

## Version planning

A version that is already on npm cannot be published again. If `1.0.0` was published by hand, the
npm job of the `v1.0.0` tag would fail with `You cannot publish over the previously published versions`.
Plan it like this:

1. Publish `1.0.0` manually (above) and configure the trusted publisher.
2. Let the pipeline publish from `1.0.1` on: bump, commit, tag `v1.0.1`, push the tag.

The Docker job is independent: pushing the `v1.0.0` tag is fine if you only want the image for it.

## When a workflow run fails

Re-running a job (or "Re-run failed jobs") uses the workflow file **from the commit the tag points
to**, not from `main`. Fixing a workflow therefore needs a new commit **and a new tag**
(`v1.0.2`, not a re-run of `v1.0.1`). Do not move or reuse a tag that already published something.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Automatic provenance generation not supported for provider: null` | Local publish with `provenance: true`. Add `--provenance=false` (`npm.sh` does). |
| `403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required` | Account without 2FA, or a login/token without bypass. Use a granular token with bypass (above). |
| `OIDC permission denied for this action` | "Allow npm publish" is not ticked under Allowed actions of the trusted publisher. |
| `404` on `PUT` from the pipeline | Trusted publisher not configured, or owner/repo/workflow name differ from the npm settings. |
| `403 ... cannot publish over the previously published versions` | The version exists; npm versions are immutable. Bump and tag again. |
| Docker `Username required` | `DOCKERHUB_USERNAME` was created as a secret; it must be a repository **variable**. |
| Docker `unauthorized` / `denied` | Wrong or expired `DOCKERHUB_TOKEN`, or the Docker Hub repository does not exist. |
| Workflow fix does not take effect on re-run | The re-run uses the workflow of the tagged commit. Push a new tag. |
