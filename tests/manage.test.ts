import { createElement } from 'react';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerApp } from '../src/tui/app.ts';
import type { ManagerItem, ManagerServices } from '../src/tui/services.ts';

const alpha: ManagerItem = {
  id: 'alpha',
  name: 'alpha',
  source: 'team/skills',
  status: 'tracked',
  details: ['Source: team/skills', 'Version: 2.1', 'Git ref: release'],
  names: ['alpha'],
  trackedNames: ['alpha'],
  path: '/skills/alpha',
};
const beta: ManagerItem = {
  ...alpha,
  id: 'beta',
  name: 'beta',
  details: ['Source: another/repo', 'Version: 3.0'],
  names: ['beta'],
  trackedNames: ['beta'],
};
const source: ManagerItem = {
  ...alpha,
  id: 'team/skills',
  name: 'team/skills',
  status: '2 skills',
  details: ['alpha · tracked', 'beta · tracked'],
  names: ['alpha', 'beta'],
  trackedNames: ['alpha', 'beta'],
};
let services: ManagerServices;
const start = async (global = false) => {
  const app = render(createElement(ManagerApp, { services, global }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Installed · 2'));
  // The first data frame precedes the select widget’s input-effect subscription.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return app;
};
const press = async (app: ReturnType<typeof render>, key: string) => {
  app.stdin.write(key);
  // Ink batches keyboard events; let React commit before sending the next key.
  await new Promise((resolve) => setTimeout(resolve, 40));
};
beforeEach(() => {
  services = {
    load: vi.fn().mockResolvedValue({ skills: [alpha, beta], sources: [source] }),
    discover: vi.fn().mockResolvedValue([
      {
        ...alpha,
        id: 'team/skills/pdf',
        name: 'pdf',
        status: 'available',
        names: [],
        trackedNames: [],
        install: { source: 'team/skills', name: 'pdf' },
      },
    ]),
    inspect: vi.fn().mockResolvedValue('# Alpha skill'),
    run: vi.fn(async (_action, _items, _global, onOutput) => {
      onOutput('Operation output\nDone\n');
      return 0;
    }),
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('fullscreen manager navigation and operations', () => {
  it('hides routine tracking labels and missing metadata until full details are requested', async () => {
    const uncluttered = {
      ...alpha,
      status: 'untracked',
      summary: ['Teach a new concept.'],
      details: ['Status: untracked', 'Git ref: Not recorded', 'Location: /skills/alpha'],
    };
    services.load = vi.fn().mockResolvedValue({ skills: [uncluttered, beta], sources: [source] });
    const app = await start();
    expect(app.lastFrame()).toContain('Teach a new concept.');
    expect(app.lastFrame()).not.toContain('untracked');
    expect(app.lastFrame()).not.toContain('Not recorded');
    expect(app.lastFrame()).not.toContain('Location:');
    await press(app, '\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Show full details'));
    await press(app, '\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Git ref: Not recorded'));
  });
  it('updates details immediately when moving and retains focus across tabs', async () => {
    const app = await start();
    expect(app.lastFrame()).toContain('Version: 2.1');
    await press(app, '\u001b[B');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Version: 3.0'));
    await press(app, '\t');
    await press(app, '\t');
    expect(app.lastFrame()).toContain('Sources · 1');
    await press(app, '\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Version: 3.0'));
    expect(services.run).not.toHaveBeenCalled();
  });
  it('preserves scroll position and batch selection across tabs and dialogs', async () => {
    const many = Array.from({ length: 30 }, (_, n) => ({
      ...alpha,
      id: `skill-${String(n).padStart(2, '0')}`,
      name: `skill-${String(n).padStart(2, '0')}`,
    }));
    services.load = vi.fn().mockResolvedValue({ skills: many, sources: [source] });
    const app = render(createElement(ManagerApp, { services, global: false }));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Installed · 30'));
    for (let n = 0; n < 20; n++) await press(app, '\u001b[B');
    await press(app, ' ');
    await press(app, '\u001b[A');
    await press(app, '\u001b[A');
    const leftPane = () =>
      app
        .lastFrame()!
        .split('\n')
        .map((line) => line.slice(0, 40))
        .join('\n');
    const before = leftPane();
    await press(app, '\t');
    await press(app, '\t');
    await press(app, '\t');
    expect(leftPane()).toBe(before);
    expect(app.lastFrame()).toContain('1 selected');
    await press(app, '\r');
    await press(app, '\u001b');
    expect(leftPane()).toBe(before);
  });
  it('adapts to terminal resize without losing the highlighted skill', async () => {
    const app = await start();
    await press(app, '\u001b[B');
    Object.defineProperty(app.stdout, 'columns', { value: 70, configurable: true });
    Object.defineProperty(app.stdout, 'rows', { value: 20, configurable: true });
    app.stdout.emit('resize');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Version: 3.0'));
    Object.defineProperty(app.stdout, 'columns', { value: 40, configurable: true });
    app.stdout.emit('resize');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Enlarge terminal'));
  });
  it('filters locally without running network operations', async () => {
    const app = await start();
    await press(app, '/');
    await press(app, 'beta');
    await press(app, '\r');
    expect(app.lastFrame()).toContain('Installed · 1');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Version: 3.0'));
    expect(services.discover).not.toHaveBeenCalled();
    expect(services.run).not.toHaveBeenCalled();
  });
  it('switches scope and reloads the selected scope', async () => {
    const app = await start();
    await press(app, 'g');
    await vi.waitFor(() => expect(services.load).toHaveBeenLastCalledWith(true, undefined));
    expect(app.lastFrame()).toContain('Global');
  });
  it('does not act on stale skills while a new scope is loading', async () => {
    services.load = vi
      .fn()
      .mockResolvedValueOnce({ skills: [alpha, beta], sources: [source] })
      .mockReturnValueOnce(new Promise(() => {}));
    const app = await start();
    await press(app, 'g');
    await press(app, 'd');
    expect(app.lastFrame()).toContain('Global');
    expect(app.lastFrame()).not.toContain('Confirm remove');
    expect(services.run).not.toHaveBeenCalled();
  });
  it('defaults removal confirmation to cancel', async () => {
    const app = await start(true);
    await press(app, 'd');
    expect(app.lastFrame()).toContain('Confirm remove · Global');
    await press(app, '\r');
    expect(services.run).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain('Installed · 2');
  });
  it('updates a batch only after confirmation and keeps output on screen', async () => {
    const app = await start();
    await press(app, ' ');
    await press(app, '\u001b[B');
    await press(app, ' ');
    await press(app, 'u');
    expect(app.lastFrame()).toContain('Confirm update · Project');
    expect(services.run).not.toHaveBeenCalled();
    await press(app, '\u001b[A');
    await press(app, '\r');
    await vi.waitFor(() =>
      expect(services.run).toHaveBeenCalledWith(
        'update',
        [alpha, beta],
        false,
        expect.any(Function),
        expect.any(AbortSignal)
      )
    );
    expect(app.lastFrame()).toContain('Operation output');
    await press(app, '\u001b');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Version: 3.0'));
  });
  it('checks a selected source using its tracked skill names without confirmation', async () => {
    const app = await start(true);
    await press(app, '\t');
    await press(app, '\t');
    await press(app, 'c');
    await vi.waitFor(() =>
      expect(services.run).toHaveBeenCalledWith(
        'check',
        [source],
        true,
        expect.any(Function),
        expect.any(AbortSignal)
      )
    );
  });
  it('explains why a skill without a lock entry cannot be updated', async () => {
    services.load = vi.fn().mockResolvedValue({
      skills: [{ ...alpha, trackedNames: [], status: 'untracked' }, beta],
      sources: [source],
    });
    const app = await start();
    await press(app, 'c');
    expect(app.lastFrame()).toContain('No skills lock entries');
    expect(services.run).not.toHaveBeenCalled();
  });
  it('discovers only after search submission and confirms installation', async () => {
    const app = await start();
    await press(app, '\t');
    expect(services.discover).not.toHaveBeenCalled();
    await press(app, '/');
    await press(app, 'pdf');
    expect(services.discover).not.toHaveBeenCalled();
    await press(app, '\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Discover · 1'));
    expect(services.discover).toHaveBeenCalledWith('pdf', expect.any(AbortSignal));
    await press(app, '\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('1 selection(s) · Project'));
    await press(app, '\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Confirm install · Project'));
    expect(services.run).not.toHaveBeenCalled();
    await press(app, '\u001b[A');
    await press(app, '\r');
    await vi.waitFor(() =>
      expect(services.run).toHaveBeenCalledWith(
        'install',
        expect.arrayContaining([expect.objectContaining({ name: 'pdf' })]),
        false,
        expect.any(Function),
        expect.any(AbortSignal)
      )
    );
  });
  it('keeps discovery counts and queries out of other tabs', async () => {
    services.discover = vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 50 }, (_, n) => ({ ...alpha, id: `result-${n}`, name: `Result ${n}` }))
      );
    const app = await start();
    await press(app, '\t');
    await press(app, '/');
    await press(app, 'pdf');
    await press(app, '\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Discover · 50'));
    await press(app, '\t');
    expect(app.lastFrame()).toContain('Sources · 1');
    expect(app.lastFrame()).not.toContain('50');
    expect(app.lastFrame()).not.toContain('pdf');
    await press(app, '\t');
    expect(app.lastFrame()).toContain('Installed · 2');
    expect(app.lastFrame()).not.toContain('50');
    expect(app.lastFrame()).not.toContain('pdf');
  });
  it('does not display background discovery activity or results on Installed', async () => {
    let finish!: (items: ManagerItem[]) => void;
    services.discover = vi.fn(
      () =>
        new Promise<ManagerItem[]>((resolve) => {
          finish = resolve;
        })
    );
    const app = await start();
    await press(app, '\t');
    await press(app, '/');
    await press(app, 'pdf');
    await press(app, '\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Searching…'));
    await press(app, '\u001b[D');
    expect(app.lastFrame()).toContain('Installed · 2');
    expect(app.lastFrame()).not.toContain('Searching');
    finish(
      Array.from({ length: 50 }, (_, n) => ({ ...alpha, id: `found-${n}`, name: `Found ${n}` }))
    );
    await press(app, '\u001b[B');
    expect(app.lastFrame()).not.toContain('50');
    await press(app, '\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Discover · 50'));
    await press(app, '\u001b[D');
    expect(app.lastFrame()).not.toContain('50');
  });
  it('shows less common shortcuts only in the help view', async () => {
    const app = await start();
    expect(app.lastFrame()).not.toContain('PgUp/PgDn');
    expect(app.lastFrame()).toContain('? help');
    await press(app, '?');
    expect(app.lastFrame()).toContain('Keyboard shortcuts');
    expect(app.lastFrame()).toContain('PgUp/PgDn');
    await press(app, '\u001b');
    expect(app.lastFrame()).not.toContain('Keyboard shortcuts');
  });
  it('cancels a running operation with Escape', async () => {
    services.run = vi.fn(
      (_action, _items, _global, _onOutput, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        )
    );
    const app = await start();
    await press(app, 'c');
    expect(app.lastFrame()).toContain('Operation running');
    await press(app, '\u001b');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Operation cancelled.'));
  });
  it('scrolls through wrapped paragraphs and clamps at the end of output', async () => {
    services.inspect = vi
      .fn()
      .mockResolvedValue('START ' + 'long paragraph '.repeat(300) + 'END OF DOCUMENT');
    const app = await start();
    await press(app, 'i');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('START'));
    expect(app.lastFrame()).not.toContain('END OF DOCUMENT');
    for (let n = 0; n < 10; n++) await press(app, '\u001b[6~');
    expect(app.lastFrame()).toContain('END OF DOCUMENT');
    await press(app, '\u001b[A');
    expect(app.lastFrame()).not.toContain('END OF DOCUMENT');
  });
  it('reads SKILL.md in the fullscreen result pane', async () => {
    const app = await start();
    await press(app, 'i');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('# Alpha skill'));
    expect(services.run).not.toHaveBeenCalled();
  });
});
