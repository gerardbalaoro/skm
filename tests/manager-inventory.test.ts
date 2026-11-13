import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManagerInventory } from '../src/tui/services.ts';
import { computeSkillFolderHash } from '../src/local-lock.ts';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-manager-inventory-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const alpha = join(root, '.agents', 'skills', 'alpha');
  const beta = join(root, 'collection', 'tools', 'beta');
  for (const [path, name] of [
    [alpha, 'alpha'],
    [beta, 'beta'],
  ]) {
    await mkdir(path!, { recursive: true });
    await writeFile(
      join(path!, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} description\n---\n`
    );
  }
  await symlink(beta, join(root, '.agents', 'skills', 'beta'), 'dir');
  await writeFile(
    join(root, 'collection', '.metadata.json'),
    JSON.stringify({
      version: 1,
      entries: {
        'tools/beta': {
          source: 'team/skills/tools/beta',
          repo_url: 'https://github.com/team/skills',
          type: 'github-subdir',
          commit: 'a'.repeat(40),
        },
      },
    })
  );
  await writeFile(
    join(root, 'skills-lock.json'),
    JSON.stringify({
      version: 2,
      skills: {
        alpha: {
          source: 'team/skills',
          sourceUrl: 'https://github.com/team/skills',
          sourceType: 'github',
          computedHash: await computeSkillFolderHash(alpha),
          ref: 'v1',
        },
        gamma: {
          source: 'team/skills',
          sourceUrl: 'https://github.com/team/skills',
          sourceType: 'github',
          computedHash: '',
        },
      },
    })
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
describe('manager inventory and source ownership', () => {
  it('groups sources while preserving per-skill lock ownership', async () => {
    const result = await loadManagerInventory(false);
    expect(result.skills.map((item) => [item.name, item.status])).toEqual([
      ['alpha', 'tracked'],
      ['beta', 'untracked'],
      ['gamma', 'missing'],
    ]);
    expect(result.skills[1]?.details).toContain('Recorded by: No source record');
    expect(result.sources).toHaveLength(2);
    expect(
      result.sources.find((item) => item.name === 'https://github.com/team/skills')
    ).toMatchObject({ names: ['alpha', 'gamma'], trackedNames: ['alpha', 'gamma'] });
    expect(result.sources.find((item) => item.name === 'No recorded source')).toMatchObject({
      names: ['beta'],
      trackedNames: [],
    });
  });
  it('keeps default summaries concise and full metadata available on demand', async () => {
    const { skills } = await loadManagerInventory(false);
    const alpha = skills.find((item) => item.name === 'alpha')!;
    const beta = skills.find((item) => item.name === 'beta')!;
    expect(alpha.summary).toEqual([
      'alpha description',
      '',
      'Source: https://github.com/team/skills',
      'Revision: v1',
    ]);
    expect(beta.summary).toEqual(['beta description']);
    expect(skills.flatMap((item) => item.summary ?? []).join('\n')).not.toMatch(
      /Not recorded|Status:|Recorded by:|Location:|Agents:/
    );
    expect(beta.details).toContain('Recorded by: No source record');
  });
  it('shows only the description when no source or version is recorded', async () => {
    await rm(join(root, 'collection', '.metadata.json'));
    const { skills } = await loadManagerInventory(false);
    expect(skills.find((item) => item.name === 'beta')?.summary).toEqual(['beta description']);
  });
  it('keeps long descriptions brief while retaining the full text in details', async () => {
    const description = 'A useful capability. ' + 'Additional usage instructions. '.repeat(30);
    await writeFile(
      join(root, '.agents', 'skills', 'alpha', 'SKILL.md'),
      `---\nname: alpha\ndescription: ${description.trim()}\n---\n`
    );
    const { skills } = await loadManagerInventory(false);
    const item = skills.find((item) => item.name === 'alpha')!;
    expect(item.summary?.[0]?.length).toBeLessThanOrEqual(240);
    expect(item.summary?.[0]).toMatch(/…$/);
    expect(item.details).toContain(description.trim());
  });
  it('does not describe filtered-out skills as missing', async () => {
    const result = await loadManagerInventory(false, ['universal']);
    expect(result.skills.some((item) => item.name === 'gamma')).toBe(false);
  });
});
