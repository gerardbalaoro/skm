import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  managerCommand,
  runManagerCommand,
  discoverManagerSkills,
  type ManagerItem,
} from '../src/tui/services.ts';
const item: ManagerItem = {
  id: 'alpha',
  name: 'alpha',
  source: 'team/skills',
  status: 'tracked',
  details: [],
  names: ['alpha'],
  trackedNames: ['alpha'],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('fullscreen manager operation interface', () => {
  it('keeps source actions scoped and skill names literal', () => {
    const group = { ...item, names: ['--all', 'beta'], trackedNames: ['--all', 'beta'] };
    expect(managerCommand('update', [group], false)).toEqual([
      'update',
      '-p',
      '-y',
      '--',
      '--all',
      'beta',
    ]);
    expect(managerCommand('remove', [group], true)).toEqual([
      'remove',
      '-g',
      '-y',
      '--',
      '--all',
      'beta',
    ]);
    expect(managerCommand('check', [item], true)).toEqual(['check', '-g', '-y', '--', 'alpha']);
  });
  it('requires lock ownership for update but permits explicit untracked removal', () => {
    const external = { ...item, trackedNames: [] };
    expect(() => managerCommand('update', [external], true)).toThrow('No selected skills');
    expect(managerCommand('remove', [external], true)).toEqual([
      'remove',
      '-g',
      '-y',
      '--',
      'alpha',
    ]);
  });
  it('installs exactly the chosen source and skill', () => {
    expect(
      managerCommand(
        'install',
        [{ ...item, install: { source: 'team/skills', name: '--odd' } }],
        false
      )
    ).toEqual(['add', '-y', '--skill=--odd', '--', 'team/skills']);
  });
  it('runs the existing CLI without a shell and captures both output streams', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-manager-operation-'));
    try {
      const cli = join(root, 'cli.mjs');
      await writeFile(
        cli,
        'console.log(JSON.stringify(process.argv.slice(2))); console.error("stderr result"); process.exitCode=3;'
      );
      const output: string[] = [];
      expect(
        await runManagerCommand(
          cli,
          ['check', '--', '$(not-a-command)'],
          (text) => output.push(text),
          new AbortController().signal
        )
      ).toBe(3);
      expect(output.join('')).toContain('$(not-a-command)');
      expect(output.join('')).toContain('stderr result');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('cancels a subprocess when the session aborts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-manager-cancel-'));
    try {
      const cli = join(root, 'cli.mjs');
      await writeFile(cli, 'console.log("ready"); setInterval(()=>{},1000);');
      const abort = new AbortController();
      const job = runManagerCommand(cli, [], () => abort.abort(), abort.signal);
      await expect(job).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses cancellable search and preserves exact result source', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        skills: [{ id: 'team/skills/pdf', name: 'PDF', source: 'team/skills', installs: 12 }],
      }),
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('SKILLS_API_URL', 'https://directory.example');
    const result = await discoverManagerSkills('pdf tools', new AbortController().signal);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://directory.example/api/search?q=pdf+tools' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result[0]?.install).toEqual({ source: 'team/skills', name: 'pdf' });
  });
  it('reports HTTP search failures instead of presenting an empty successful search', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(discoverManagerSkills('pdf', new AbortController().signal)).rejects.toThrow(
      'Search failed'
    );
  });
});
