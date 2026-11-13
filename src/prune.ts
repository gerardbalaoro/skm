import { lstat, readdir } from 'fs/promises';
import { join, relative, sep } from 'path';
import { existsSync } from 'fs';
import * as p from '@clack/prompts';
import { cloneRepo, cleanupTempDir } from './git.ts';
import { discoverSkills } from './skills.ts';
import { readLocalLock, computeSkillFolderHash } from './local-lock.ts';
import { readSkillLock } from './skill-lock.ts';
import { buildLocalCloneSource } from './update-source.ts';
import { resolveSkillLocations } from './skill-relocation.ts';
import { getCanonicalPath, getInstallPath } from './installer.ts';
import { agents } from './agents.ts';
import { removeCommand } from './remove.ts';
import { diagnostics, formatError } from './diagnostics.ts';
import { sanitizeMetadata } from './sanitize.ts';
import type { AgentType } from './types.ts';

interface PruneEntry {
  source: string;
  sourceUrl?: string;
  sourceType: string;
  ref?: string;
  skillPath?: string;
  skillName?: string;
  computedHash?: string;
  skillFolderHash?: string;
  subagents?: string[];
}

function report(reason: string): void {
  console.error(formatError(diagnostics.SKILLS_MANAGEMENT_FAILED({ reason })));
}

// Count even malformed SKILL.md files. Discovery excluding one is insufficient
// evidence of deletion or relocation, so such a source is retained in full.
async function skillFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await skillFiles(path)));
    else if (entry.name === 'SKILL.md') files.push(path);
  }
  return files;
}

async function hasLinkedContent(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && (await hasLinkedContent(join(dir, entry.name)))) return true;
  }
  return false;
}

/** Verify every removal target, including copies outside the canonical directory. */
async function localState(
  name: string,
  entry: PruneEntry,
  global: boolean
): Promise<'clean' | 'edited' | 'unknown'> {
  let uncertain = !!entry.subagents?.length;
  const hash = entry.computedHash ?? entry.skillFolderHash;
  const paths = new Set([getCanonicalPath(name, { global })]);
  for (const [agent, config] of Object.entries(agents)) {
    if (global && !config.globalSkillsDir) continue;
    paths.add(getInstallPath(name, agent as AgentType, { global }));
  }
  for (const path of paths) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      uncertain = true;
      continue;
    }
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
      uncertain = true;
      continue;
    }
    try {
      if (await hasLinkedContent(path)) {
        uncertain = true;
        continue;
      }
      if ((await computeSkillFolderHash(path)) !== hash) return 'edited';
    } catch {
      uncertain = true;
    }
  }
  return uncertain ? 'unknown' : 'clean';
}

/** Prune only lock-tracked Git skills with affirmative evidence of upstream deletion. */
export async function runPrune(args: string[]): Promise<void> {
  const global = args.includes('-g') || args.includes('--global');
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('-y') || args.includes('--yes');
  if (global && (args.includes('-p') || args.includes('--project'))) {
    report('Prune accepts one scope at a time; choose -g or -p.');
    process.exitCode = 1;
    return;
  }
  const names = args.filter((arg) => !arg.startsWith('-'));
  const supported = new Set(['-g', '--global', '-p', '--project', '--dry-run', '-y', '--yes']);
  const unknown = args.find((arg) => arg.startsWith('-') && !supported.has(arg));
  if (unknown) {
    console.error(formatError(diagnostics.SKILLS_UNKNOWN_OPTION({ option: unknown })));
    process.exitCode = 1;
    return;
  }
  const lock: { skills: Record<string, PruneEntry> } = global
    ? await readSkillLock()
    : await readLocalLock();
  const groups = new Map<string, { url: string; ref?: string; entries: [string, PruneEntry][] }>();
  for (const [name, entry] of Object.entries(lock.skills)) {
    if (names.length && !names.includes(name)) continue;
    if (!['github', 'gitlab', 'git'].includes(entry.sourceType) || !entry.skillPath) {
      console.log(`Retaining ${sanitizeMetadata(name)}: source cannot prove deletion.`);
      continue;
    }
    const url = buildLocalCloneSource(entry);
    if (!url) continue;
    const key = JSON.stringify([url, entry.ref]);
    const group = groups.get(key) ?? { url, ref: entry.ref, entries: [] };
    group.entries.push([name, entry]);
    groups.set(key, group);
  }
  let candidates = 0;
  for (const group of groups.values()) {
    let tempDir: string | undefined;
    try {
      tempDir = await cloneRepo(group.url, group.ref);
      const discovered = await discoverSkills(tempDir, undefined, {
        fullDepth: true,
        includeDuplicateNames: true,
        includeInternal: true,
      });
      const rawFiles = await skillFiles(tempDir);
      const parsedPaths = new Set(discovered.map((skill) => join(skill.path, 'SKILL.md')));
      if (rawFiles.some((path) => !parsedPaths.has(path))) {
        report(`Retaining skills from ${group.url}: some SKILL.md files could not be discovered.`);
        continue;
      }
      const resolution = resolveSkillLocations(
        group.entries.map(([name]) => name),
        lock.skills,
        discovered.map((skill) => ({
          name: skill.name,
          skillPath: join(relative(tempDir!, skill.path), 'SKILL.md').split(sep).join('/'),
        })),
        { exactPathDisambiguates: true }
      );
      for (const name of resolution.deletedSkills) {
        const entry = lock.skills[name]!;
        // A malformed or excluded file at the locked path is still not a deletion.
        if (existsSync(join(tempDir, entry.skillPath!))) continue;
        candidates++;
        const state = await localState(name, entry, global);
        console.log(
          `${dryRun ? 'Would prune' : 'Deleted upstream:'} ${sanitizeMetadata(name)} (${state})`
        );
        if (dryRun) continue;
        if (state === 'edited') {
          report(
            `Retaining ${name}: local edits detected. Back up or migrate them before removal.`
          );
          continue;
        }
        if (state === 'unknown' && (yes || !process.stdin.isTTY)) {
          report(
            `Retaining ${name}: local changes cannot be verified; rerun interactively to review removal.`
          );
          continue;
        }
        if (!yes) {
          if (!process.stdin.isTTY) continue;
          const confirmed = await p.confirm({
            message: `Remove ${sanitizeMetadata(name)}${state === 'unknown' ? ' (local changes cannot be verified)' : ''}?`,
            initialValue: false,
          });
          if (p.isCancel(confirmed)) return;
          if (!confirmed) continue;
        }
        // Recheck content after the prompt before touching files or the lock.
        const currentState = await localState(name, entry, global);
        if (currentState === 'edited' || (currentState === 'unknown' && state !== 'unknown'))
          continue;
        await removeCommand([name], { global, yes: true });
      }
    } catch (error) {
      report(`Retaining skills from ${group.url}: ${formatError(error)}`);
      process.exitCode = 1;
    } finally {
      if (tempDir) await cleanupTempDir(tempDir);
    }
  }
  if (!candidates) console.log('No confirmed upstream deletions.');
}
