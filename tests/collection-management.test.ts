import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { runCli } from '../src/test-utils.ts';
import { computeSkillFolderHash } from '../src/local-lock.ts';

describe('collection management', { timeout: 30_000 }, () => {
  let root: string;
  let project: string;
  let repo: string;
  let home: string;
  let env: Record<string, string>;
  const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`;
  function git(...args: string[]) {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  const cli = (args: string[]) => runCli(args, project, env);
  const lock = () => JSON.parse(readFileSync(join(project, 'skills-lock.json'), 'utf8'));
  const globalLockPath = () => join(home, '.local', 'state', 'skills', '.skill-lock.json');
  function deleteUpstream() {
    rmSync(join(repo, 'alpha'), { recursive: true });
    git('add', '-A');
    git('commit', '-qm', 'delete alpha');
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-fork-'));
    project = join(root, 'project');
    repo = join(root, 'repo');
    home = join(root, 'home');
    env = { HOME: home, USERPROFILE: home };
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(project, { recursive: true });
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(repo, name), { recursive: true });
      writeFileSync(join(repo, name, 'SKILL.md'), skill(name));
    }
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'initial');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(['install', 'i'])('%s without source restores the project lock', async (command) => {
    writeFileSync(
      join(project, 'skills-lock.json'),
      JSON.stringify({
        version: 2,
        skills: {
          alpha: {
            source: join(repo, 'alpha'),
            sourceType: 'local',
            computedHash: await computeSkillFolderHash(join(repo, 'alpha')),
          },
        },
      })
    );
    expect(cli([command, '--frozen-lockfile']).exitCode).toBe(0);
    expect(existsSync(join(project, '.agents', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
  });
  it('install with source retains add behavior', () => {
    expect(
      cli(['install', pathToFileURL(repo).href, '-s', 'alpha', '-a', 'universal', '-y']).exitCode
    ).toBe(0);
    expect(lock().skills.alpha).toBeDefined();
  });
  it('restores global inventory without changing the project lock', () => {
    mkdirSync(join(home, '.local', 'state', 'skills'), { recursive: true });
    writeFileSync(
      globalLockPath(),
      JSON.stringify({
        version: 3,
        skills: {
          alpha: {
            source: join(repo, 'alpha'),
            sourceType: 'local',
            sourceUrl: join(repo, 'alpha'),
            skillFolderHash: 'x',
            installedAt: '2026-01-01',
            updatedAt: '2026-01-01',
          },
        },
      })
    );
    expect(cli(['install', '-g', '--dry-run']).stdout).toContain('Would restore alpha');
    expect(existsSync(join(home, '.agents', 'skills', 'alpha'))).toBe(false);
    const result = cli(['install', '-g']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(join(home, '.agents', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(project, 'skills-lock.json'))).toBe(false);
    expect(JSON.parse(readFileSync(globalLockPath(), 'utf8')).version).toBe(3);
  });
  it('global restore leaves existing agent copies and their local edits intact', () => {
    expect(
      cli([
        'add',
        pathToFileURL(repo).href,
        '-s',
        'alpha',
        '-a',
        'claude-code',
        '-g',
        '--copy',
        '-y',
      ]).exitCode
    ).toBe(0);
    const installed = join(home, '.claude', 'skills', 'alpha', 'SKILL.md');
    writeFileSync(installed, skill('alpha') + 'local changes');
    expect(cli(['install', '-g']).exitCode).toBe(0);
    expect(readFileSync(installed, 'utf8')).toContain('local changes');
  });
  it('restores the recorded path when a Git source has duplicate skill names', () => {
    mkdirSync(join(repo, 'mirror'), { recursive: true });
    writeFileSync(join(repo, 'mirror', 'SKILL.md'), skill('alpha') + 'mirror content');
    git('add', '.');
    git('commit', '-qm', 'mirror');
    mkdirSync(join(home, '.local', 'state', 'skills'), { recursive: true });
    writeFileSync(
      globalLockPath(),
      JSON.stringify({
        version: 3,
        skills: {
          alpha: {
            source: pathToFileURL(repo).href,
            sourceType: 'git',
            sourceUrl: pathToFileURL(repo).href,
            skillPath: 'mirror/SKILL.md',
            skillFolderHash: 'x',
          },
        },
      })
    );
    const result = cli(['install', '-g']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readFileSync(join(home, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain(
      'mirror content'
    );
  });
  it('restores a renamed global skill at its pinned commit after upstream deletion', () => {
    const pinned = git('rev-parse', 'HEAD').trim();
    const ref = git('branch', '--show-current').trim();
    const url = 'https://git.example.test/owner/skills.git';
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(repo).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: url,
    });
    const added = cli([
      'add',
      `${url}#${ref}`,
      '-s',
      'alpha',
      '--rename',
      'review',
      '-a',
      'universal',
      '-g',
      '-y',
    ]);
    expect(added.exitCode, added.stderr).toBe(0);
    const before = JSON.parse(readFileSync(globalLockPath(), 'utf8')).skills.review;
    expect(before).toMatchObject({ commit: pinned, skillName: 'alpha', ref });
    rmSync(join(home, '.agents', 'skills', 'review'), { recursive: true });
    deleteUpstream();
    const restored = cli(['install', '-g']);
    expect(restored.exitCode, restored.stderr).toBe(0);
    expect(readFileSync(join(home, '.agents', 'skills', 'review', 'SKILL.md'), 'utf8')).toContain(
      'name: review'
    );
    const after = JSON.parse(readFileSync(globalLockPath(), 'utf8')).skills.review;
    expect(after).toMatchObject({ commit: pinned, skillName: 'alpha', ref });
    expect(JSON.parse(readFileSync(globalLockPath(), 'utf8')).skills.alpha).toBeUndefined();
  });
  it('named update stays in project scope unless -g is passed', () => {
    mkdirSync(join(home, '.local', 'state', 'skills'), { recursive: true });
    writeFileSync(
      globalLockPath(),
      JSON.stringify({
        version: 3,
        skills: {
          alpha: {
            source: 'example/absent',
            sourceType: 'github',
            sourceUrl: 'https://github.com/example/absent',
            skillPath: 'SKILL.md',
            skillFolderHash: 'x',
          },
        },
      })
    );
    const result = cli(['update', 'alpha', '-y']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No installed skills found matching');
    expect(result.stdout).not.toContain('Fetching');
  });
});
