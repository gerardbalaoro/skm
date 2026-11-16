# Releases

The npm package is `@gblab/skm`. It provides both `skm` and `skills` executables.
Releases come from `dev`; `main` remains an upstream mirror.

## Routine Releases

1. Run `pnpm changeset` for a user-facing change and commit the generated Markdown file.
2. Merge the change into `dev`.
3. Review the generated version PR, including `package.json` and `CHANGELOG.md`.
4. Merge the version PR into `dev`.

The release workflow runs formatting, type checks, unit tests, and installed-package checks.
It then publishes new versions and creates GitHub releases through Changesets.
The old maintainer GPG secret and npm publishing tokens are not required by the workflow.

## One-Time Setup

The first publish creates the npm package. It requires an npm account authorized to publish under `@gblab`.

1. Set an initial version through `pnpm changeset` and `pnpm release:version`.
2. Run `pnpm release:check` and commit the release changes.
3. Build and pack the release with `pnpm build` and `pnpm pack --pack-destination /tmp/skm-release`.
4. Test the packed artifact and publish it with `npm publish /tmp/skm-release/gblab-skm-0.1.0.tgz --access public`.
5. Run `pnpm changeset git-tag` and push `dev` and the release tag.
6. Create the matching GitHub release using the package changelog and attach the published tarball.

Configure npm trusted publishing for `@gblab/skm` with these exact values:

| Setting | Value |
| --- | --- |
| GitHub owner | `gerardbalaoro` |
| Repository | `skm` |
| Workflow filename | `publish.yml` |
| Environment | `npm-publish` |
| Allowed action | Direct publishing with `npm publish` |

Use GitHub-hosted runners and keep `id-token: write` on the release job.
Configure trust shortly before the first automated release; npm expires unused configurations after two days.
Enable **Allow GitHub Actions to create and approve pull requests** in the repository's Actions settings.
This lets Changesets create release PRs; the workflow does not approve them automatically.

## Validate an Artifact

Build and pack into an empty directory, then run the installed-package suite against that archive:

```bash
mkdir -p /tmp/skm-release
pnpm build
pnpm pack --pack-destination /tmp/skm-release
SKILLS_E2E_PACKAGE=/tmp/skm-release/gblab-skm-0.1.0.tgz pnpm exec vitest run --config e2e/vitest.config.ts e2e/package.e2e.ts e2e/api.e2e.ts
```

Use the tarball filename printed by `pnpm pack` for later versions.
The installed-package checks cover the CLI, runtime dependencies, public API, and shipped TypeScript declarations.
