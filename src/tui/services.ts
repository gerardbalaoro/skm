import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listInstalledSkills, sanitizeName } from '../installer.ts';
import { readLocalLock, getLockedSkillState } from '../local-lock.ts';
import { getAllLockedSkills } from '../skill-lock.ts';
import { readSkillProvenance, describeSkillProvenance } from '../skill-provenance.ts';
import { diagnostics } from '../diagnostics.ts';
import { sanitizeMetadata, stripTerminalEscapes } from '../sanitize.ts';
import type { AgentType } from '../types.ts';

export type ManagerAction = 'check' | 'update' | 'remove' | 'install';
export interface ManagerItem {
  id: string;
  name: string;
  source: string;
  status: string;
  /** Short, user-facing overview. Full metadata stays in details. */
  summary?: string[];
  details: string[];
  names: string[];
  trackedNames: string[];
  path?: string;
  /** Present only for a result returned by skills.sh discovery. */
  install?: { source: string; name: string };
}
export interface ManagerInventory {
  skills: ManagerItem[];
  sources: ManagerItem[];
}
export interface ManagerServices {
  load(global: boolean, agentFilter?: AgentType[]): Promise<ManagerInventory>;
  discover(query: string, signal: AbortSignal): Promise<ManagerItem[]>;
  inspect(item: ManagerItem): Promise<string>;
  run(
    action: ManagerAction,
    items: ManagerItem[],
    global: boolean,
    onOutput: (text: string) => void,
    signal: AbortSignal
  ): Promise<number>;
}

export async function loadManagerInventory(
  global: boolean,
  agentFilter?: AgentType[]
): Promise<ManagerInventory> {
  const installed = await listInstalledSkills({ global, agentFilter });
  const locked = global ? await getAllLockedSkills() : (await readLocalLock()).skills;
  const byName = new Map(
    Object.entries(locked).map(([name, entry]) => [sanitizeName(name), { name, entry }])
  );
  const rows: { name: string; skill: (typeof installed)[number] | undefined }[] = installed.map(
    (skill) => ({ name: byName.get(sanitizeName(skill.name))?.name ?? skill.name, skill })
  );
  if (!agentFilter)
    for (const name of Object.keys(locked)) {
      if (!rows.some((row) => sanitizeName(row.name) === sanitizeName(name)))
        rows.push({ name, skill: undefined });
    }
  const skills = await Promise.all(
    rows.map(async ({ name, skill }): Promise<ManagerItem> => {
      const entry = byName.get(sanitizeName(name))?.entry;
      const provenance = await readSkillProvenance(skill?.canonicalPath, entry);
      let status = !skill ? 'missing' : entry ? 'tracked' : 'untracked';
      if (
        skill &&
        entry &&
        'computedHash' in entry &&
        (await getLockedSkillState(name, entry, undefined, skill.canonicalPath)) === 'modified'
      )
        status = 'modified';
      const description = skill?.description ?? 'Not installed.';
      const briefDescription =
        description.length > 240
          ? `${description.slice(0, 237).replace(/\s+\S*$/, '')}…`
          : description;
      return {
        id: name,
        name,
        source: provenance.source,
        status,
        names: [name],
        trackedNames: entry ? [name] : [],
        path: skill?.canonicalPath,
        summary: [
          briefDescription,
          ...(provenance.recordedBy !== 'No source record'
            ? ['', `Source: ${provenance.source}`]
            : []),
          ...(provenance.version
            ? [`Version: ${provenance.version}`]
            : provenance.ref || provenance.commit
              ? [`Revision: ${provenance.commit?.slice(0, 7) ?? provenance.ref}`]
              : []),
          ...(status === 'modified' ? ['', 'Local changes'] : []),
        ].map(sanitizeMetadata),
        details: [
          `Status: ${status}${!entry ? ' (no entry in this scope’s skills lockfile)' : ''}`,
          ...describeSkillProvenance(provenance),
          '',
          skill?.description ?? 'Missing from disk',
          '',
          `Agents: ${skill?.agents.join(', ') || 'none'}`,
        ].map(sanitizeMetadata),
      };
    })
  );
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const groups = new Map<string, ManagerItem[]>();
  for (const skill of skills) {
    const key = skill.source.startsWith('Unknown') ? 'No recorded source' : skill.source;
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  const sources = [...groups]
    .map(([source, items]): ManagerItem => ({
      id: source,
      name: source,
      source,
      status: `${items.length} skills`,
      names: items.flatMap((item) => item.names),
      trackedNames: items.flatMap((item) => item.trackedNames),
      summary: [`${items.length} skills`, '', ...items.map((item) => item.name)],
      details: [
        `Source: ${source}`,
        `${items.length} skills in this scope`,
        '',
        ...items.map((item) => `${item.name} · ${item.status}`),
        '',
        'Actions apply to this source’s skills in the selected scope.',
      ],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { skills, sources };
}

/** Use the existing search endpoint, with cancellation and a finite network timeout. */
export async function discoverManagerSkills(
  query: string,
  signal: AbortSignal
): Promise<ManagerItem[]> {
  const url = new URL('/api/search', process.env.SKILLS_API_URL || 'https://skills.sh');
  url.searchParams.set('q', query);
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!res.ok)
    throw diagnostics.SKILLS_MANAGEMENT_FAILED({ reason: `Search failed (HTTP ${res.status}).` });
  const data = (await res.json()) as {
    skills?: { id: string; name: string; source: string; installs?: number }[];
  };
  const seen = new Set<string>();
  return (data.skills ?? [])
    .filter((skill) => {
      if (
        typeof skill.id !== 'string' ||
        typeof skill.name !== 'string' ||
        typeof skill.source !== 'string' ||
        !skill.source ||
        seen.has(skill.id)
      )
        return false;
      seen.add(skill.id);
      return true;
    })
    .slice(0, 50)
    .map((skill) => ({
      id: skill.id,
      name: sanitizeMetadata(skill.name),
      source: sanitizeMetadata(skill.source),
      status: 'available',
      names: [],
      trackedNames: [],
      install: { source: skill.source, name: skill.id.split('/').at(-1) || skill.name },
      summary: [
        `Source: ${sanitizeMetadata(skill.source)}`,
        ...(typeof skill.installs === 'number'
          ? [`${skill.installs.toLocaleString('en-US')} installs`]
          : []),
      ],
      details: [
        `Source: ${sanitizeMetadata(skill.source)}`,
        `Installs: ${skill.installs ?? 'Unknown'}`,
        `Directory: https://skills.sh/${sanitizeMetadata(skill.id)}`,
        '',
        'Enter to install. The recorded source and version will appear after installation.',
      ],
    }));
}

/** Build argument arrays, keeping skill names literal even when they start with a dash. */
export function managerCommand(
  action: ManagerAction,
  items: ManagerItem[],
  global: boolean
): string[] {
  const scope = global ? ['-g'] : action === 'check' || action === 'update' ? ['-p'] : [];
  if (action === 'install') {
    const install = items[0]?.install;
    if (items.length !== 1 || !install)
      throw diagnostics.SKILLS_MANAGEMENT_FAILED({
        reason: 'Select one search result to install.',
      });
    return ['add', ...scope, '-y', `--skill=${install.name}`, '--', install.source];
  }
  const names = [
    ...new Set(items.flatMap((item) => (action === 'remove' ? item.names : item.trackedNames))),
  ];
  if (!names.length)
    throw diagnostics.SKILLS_MANAGEMENT_FAILED({
      reason:
        'No selected skills have entries in this scope’s skills lockfile. Add the skill with this CLI to enable updates.',
    });
  return [action, ...scope, '-y', '--', ...names];
}

/** Isolate CLI output from Ink's terminal renderer; invoke the same source or built CLI. */
export function runManagerCommand(
  cliPath: string,
  args: string[],
  onOutput: (text: string) => void,
  signal: AbortSignal
): Promise<number> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => onOutput(stripTerminalEscapes(chunk)));
    child.stderr.on('data', (chunk: string) => onOutput(stripTerminalEscapes(chunk)));
    const cancel = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const kill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        kill.on('error', () => child.kill());
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill();
        }
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    child.once('error', reject);
    child.once('close', (code) => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) reject(signal.reason);
      else resolve(code ?? 1);
    });
  });
}

export function createManagerServices(cliPath: string): ManagerServices {
  return {
    load: loadManagerInventory,
    discover: discoverManagerSkills,
    inspect: async (item) => {
      if (!item.path)
        throw diagnostics.SKILLS_MANAGEMENT_FAILED({ reason: 'This skill is missing from disk.' });
      return stripTerminalEscapes(await readFile(join(item.path, 'SKILL.md'), 'utf8'));
    },
    run: (action, items, global, onOutput, signal) =>
      runManagerCommand(cliPath, managerCommand(action, items, global), onOutput, signal),
  };
}
