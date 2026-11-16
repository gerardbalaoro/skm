# @gblab/skm

## 0.1.0

### Minor Changes

- Publish the first skm fork release as `@gblab/skm`, with both `skm` and `skills` executables.

  - Manage installed skills, sources, and discovery through a fullscreen Ink interface.
  - Restore missing global skills from their lockfile, preserving commit pins and renamed skills.
  - Default updates and checks to project scope, with explicit global selection.
  - Prune skills confirmed deleted upstream while retaining local edits and uncertain content.
  - Use `install` / `i` for lockfile restore and promote `sync` to a stable command.

### Patch Changes

- bd4214d: Update repository automations for the current Factory board integration.
- 1d2bf37: `skills find` falls back to partial matches when a multi-term query returns few results, so an extra search term no longer hides a relevant skill.
