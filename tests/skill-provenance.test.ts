import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSkillProvenance, describeSkillProvenance } from '../src/skill-provenance.ts';

describe('installed skill provenance', () => {
  let root: string;
  let skill: string;
  const commit = 'a'.repeat(40);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skills-provenance-'));
    skill = join(root, 'collection', 'tools', 'review');
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(root, 'collection', '.metadata.json'),
      JSON.stringify({
        version: 1,
        entries: {
          'tools/review': {
            source: 'github.com/team/skills/tools/review',
            type: 'github-subdir',
            repo_url: 'https://github.com/team/skills.git',
            version: commit.slice(0, 7),
            commit,
            tree_hash: 'b'.repeat(40),
          },
        },
      })
    );
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  it('does not infer source or version from metadata beside a symlink target', async () => {
    const link = join(root, 'installed-review');
    await symlink(skill, link, 'dir');
    const path = join(root, 'collection', '.metadata.json');
    const before = await readFile(path, 'utf8');
    const result = await readSkillProvenance(link);
    expect(result).toEqual({
      source: 'Unknown (no source recorded)',
      recordedBy: 'No source record',
      location: skill,
    });
    expect(await readFile(path, 'utf8')).toBe(before);
  });
  it('uses only the selected skills lock entry', async () => {
    const result = await readSkillProvenance(skill, {
      source: 'different/repo',
      sourceUrl: 'https://github.com/different/repo',
      ref: 'v2.0',
      computedHash: 'c'.repeat(64),
    });
    expect(result).toMatchObject({
      source: 'https://github.com/different/repo',
      ref: 'v2.0',
      recordedBy: 'skills lockfile',
    });
    expect(result.commit).toBeUndefined();
    expect(result.version).toBeUndefined();
  });
  it('does not confuse a content hash with a Git commit or package version', async () => {
    const result = await readSkillProvenance(undefined, {
      source: 'team/skills',
      skillFolderHash: 'd'.repeat(40),
    });
    const details = describeSkillProvenance(result);
    expect(details).toContain('Version: Not recorded');
    expect(details).toContain('Git ref: Not recorded');
    expect(details).toContain('Recorded commit: Not recorded');
    expect(details).toContain(`Content hash: ${'d'.repeat(40)}`);
  });
  it('shows the installed commit from this CLI lock separately from its tracked ref', async () => {
    const result = await readSkillProvenance(undefined, {
      source: 'team/skills',
      ref: 'main',
      commit,
    });
    expect(describeSkillProvenance(result)).toContain(`Recorded commit: ${commit}`);
    expect(result.ref).toBe('main');
  });
  it('shows a recorded npm version separately from a Git ref', async () => {
    const details = describeSkillProvenance(
      await readSkillProvenance(undefined, { source: 'skill-package', version: '2.4.1' })
    );
    expect(details).toContain('Version: 2.4.1');
    expect(details).toContain('Git ref: Not recorded');
  });
});
