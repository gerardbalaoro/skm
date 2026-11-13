import { existsSync } from 'fs';
import { join, relative, sep } from 'path';
import {
  buildInstallTargets,
  defaultInstallMode,
  fetchSources,
  installFetched,
  nonInteractiveTargetAgents,
  releaseSource,
  recordGlobalWellKnownLock,
  renameSkill,
} from './add.ts';
import { getCanonicalPath, listInstalledSkills, sanitizeName } from './installer.ts';
import { addSkillToLock, readSkillLock } from './skill-lock.ts';
import {
  buildUpdateInstallSource,
  shouldUseFullDepthForUpdate,
  formatSourceInput,
} from './update-source.ts';
import { parseSource } from './source-parser.ts';
import { withGlobalSkillsDir } from './update.ts';
import { diagnostics, formatError } from './diagnostics.ts';
import { sanitizeMetadata } from './sanitize.ts';

/** Restore the upstream v3 global inventory, keeping already installed skills intact. */
export async function runGlobalRestore(args: string[]): Promise<void> {
  if (args.includes('--frozen-lockfile')) {
    console.error(
      formatError(
        diagnostics.SKILLS_MANAGEMENT_FAILED({
          reason:
            'Global restore does not support --frozen-lockfile: global restore does not enforce frozen content hashes.',
        })
      )
    );
    process.exitCode = 1;
    return;
  }
  const lock = await readSkillLock();
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const installed = new Set(
    (await listInstalledSkills({ global: true })).map((skill) => sanitizeName(skill.name))
  );
  const pending = Object.entries(lock.skills).filter(
    ([name]) =>
      force ||
      (!installed.has(sanitizeName(name)) &&
        !existsSync(join(getCanonicalPath(name, { global: true }), 'SKILL.md')))
  );
  if (pending.length === 0) {
    console.log('No global skills to restore.');
    return;
  }
  // Keep separate requests where placement or hash semantics differ.
  const requests = pending.flatMap(([name, entry]) => {
    const pinnedEntry = ['github', 'gitlab', 'git'].includes(entry.sourceType)
      ? { ...entry, ref: entry.commit ?? entry.ref }
      : entry;
    const source =
      entry.sourceType === 'well-known'
        ? (entry.sourceBaseUrl ?? entry.sourceUrl.split('/.well-known/')[0]!)
        : entry.sourceType === 'git'
          ? formatSourceInput(entry.sourceUrl || entry.source, pinnedEntry.ref)
          : buildUpdateInstallSource(pinnedEntry);
    if (!source) {
      console.error(formatError(diagnostics.SKILLS_LOCK_MISSING_SOURCE_URL({ skill: name })));
      process.exitCode = 1;
      return [];
    }
    console.log(
      `${dryRun ? 'Would restore' : 'Restoring'} ${sanitizeMetadata(name)} from ${sanitizeMetadata(source)}`
    );
    return [
      {
        name,
        entry,
        source,
        parsed: parseSource(
          source,
          entry.sourceType === 'github' ? { githubHost: 'github.com' } : {}
        ),
        skills: [entry.skillName ?? name],
        fullDepth: entry.sourceType === 'git' || shouldUseFullDepthForUpdate(entry),
        includeDuplicateNames: true,
      },
    ];
  });
  if (dryRun) return;
  const targets = buildInstallTargets(withGlobalSkillsDir(await nonInteractiveTargetAgents()), [
    undefined,
  ]);
  const fetched = await fetchSources(requests);
  for (const [index, request] of requests.entries()) {
    const source = fetched[index]!;
    try {
      const outcome = await installFetched(source, {
        skills: request.skills,
        select: async (skills) => {
          const asInstalled = (selected: typeof skills) =>
            selected.map((skill) =>
              request.entry.skillName ? renameSkill(skill, request.name) : skill
            );
          if (skills.length <= 1) return asInstalled(skills);
          const exact = skills.filter((skill) => {
            const path =
              'repoPath' in skill
                ? skill.repoPath
                : source.resolved?.tempDir
                  ? join(relative(source.resolved.tempDir, skill.path), 'SKILL.md')
                      .split(sep)
                      .join('/')
                  : undefined;
            return path === request.entry.skillPath;
          });
          if (exact.length === 1) return asInstalled(exact);
          throw diagnostics.SKILLS_MANAGEMENT_FAILED({
            reason: `Ambiguous source for ${request.name}; restore requires a unique skill path.`,
          });
        },
        placement: {
          global: true,
          targets,
          mode: request.entry.installMode ?? defaultInstallMode(targets),
        },
      });
      if (outcome.error || outcome.failed.length > 0 || outcome.installed.length === 0) {
        console.error(
          formatError(
            diagnostics.SKILLS_MANAGEMENT_FAILED({
              reason: `${request.name}: ${outcome.error ?? (outcome.failed.join(', ') || 'No skill installed')}`,
            })
          )
        );
        process.exitCode = 1;
      }
      if (outcome.installed.length > 0) {
        if (request.entry.sourceType === 'well-known') {
          await recordGlobalWellKnownLock(request.source, outcome.installed);
        } else {
          // A content SHA is supported by the existing global update clone fallback.
          await addSkillToLock(request.name, {
            ...request.entry,
            ...(source.resolved?.commit && { commit: source.resolved.commit }),
            skillFolderHash: outcome.installed[0]!.hash,
          });
        }
      }
    } catch (error) {
      console.error(
        formatError(
          diagnostics.SKILLS_MANAGEMENT_FAILED({ reason: `${request.name}: ${formatError(error)}` })
        )
      );
      process.exitCode = 1;
    } finally {
      await releaseSource(source);
    }
  }
}
