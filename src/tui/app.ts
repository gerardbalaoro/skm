import { createElement as h, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import SelectInput from 'ink-select-input';
import wrapAnsi from 'wrap-ansi';
import { TextInput } from '@inkjs/ui';
import { formatError } from '../diagnostics.ts';
import { stripTerminalEscapes } from '../sanitize.ts';
import type { AgentType } from '../types.ts';
import type { ManagerAction, ManagerInventory, ManagerItem, ManagerServices } from './services.ts';

const tabs = ['Installed', 'Discover', 'Sources'] as const;
type Tab = (typeof tabs)[number];
type Mode = 'browse' | 'search' | 'actions' | 'confirm' | 'output' | 'help';
interface Choice {
  label: string;
  value: string;
}
export interface ManagerAppProps {
  services: ManagerServices;
  global: boolean;
  agentFilter?: AgentType[];
}

function ListLabel({ label, isSelected }: { label: string; isSelected?: boolean }) {
  return h(Text, { color: isSelected ? 'cyan' : undefined, wrap: 'truncate-end' }, label);
}

/** Ink owns rendering, layout, input and terminal lifecycle; widgets own list/input editing. */
export function ManagerApp({ services, global: initialGlobal, agentFilter }: ManagerAppProps) {
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const [global, setGlobal] = useState(initialGlobal);
  const [tab, setTab] = useState<Tab>('Installed');
  const [inventory, setInventory] = useState<ManagerInventory>({ skills: [], sources: [] });
  const [discoveries, setDiscoveries] = useState<ManagerItem[]>([]);
  const [queries, setQueries] = useState<Record<Tab, string>>({
    Installed: '',
    Discover: '',
    Sources: '',
  });
  const [highlight, setHighlight] = useState<Record<Tab, string>>({
    Installed: '',
    Discover: '',
    Sources: '',
  });
  const [selections, setSelections] = useState<Record<Tab, Set<string>>>({
    Installed: new Set(),
    Discover: new Set(),
    Sources: new Set(),
  });
  const selected = selections[tab];
  const setSelected = (next: Set<string> | ((previous: Set<string>) => Set<string>)) => {
    setSelections((previous) => ({
      ...previous,
      [tab]: typeof next === 'function' ? next(previous[tab]) : next,
    }));
  };
  const [mode, setMode] = useState<Mode>('browse');
  const [pending, setPending] = useState<{ action: ManagerAction; items: ManagerItem[] }>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [notices, setNotices] = useState<Record<Tab, string>>({
    Installed: '',
    Discover: '',
    Sources: '',
  });
  const [outputStatus, setOutputStatus] = useState('');
  const setNotice = (message: string, view: Tab = tab) =>
    setNotices((previous) => ({ ...previous, [view]: message }));
  const [output, setOutput] = useState('');
  const [offset, setOffset] = useState(0);
  const operation = useRef<AbortController | undefined>(undefined);
  const search = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const inspection = useRef(0);
  const mounted = useRef(true);

  const reload = async () => {
    const version = ++generation.current;
    setLoading(true);
    setLoadError('');
    try {
      const result = await services.load(global, agentFilter);
      if (mounted.current && version === generation.current) {
        setInventory(result);
      }
    } catch (error) {
      if (mounted.current && version === generation.current) setLoadError(formatError(error));
    } finally {
      if (mounted.current && version === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    void reload();
  }, [global, services, agentFilter]);
  useEffect(
    () => () => {
      mounted.current = false;
      generation.current++;
      operation.current?.abort();
      search.current?.abort();
    },
    []
  );

  const allItems =
    tab === 'Installed' ? inventory.skills : tab === 'Sources' ? inventory.sources : discoveries;
  const query = queries[tab];
  const items =
    tab === 'Discover'
      ? allItems
      : allItems.filter((item) =>
          `${item.name} ${item.source} ${item.status}`.toLowerCase().includes(query.toLowerCase())
        );
  const current = items.find((item) => item.id === highlight[tab]) ?? items[0];
  const targets = selected.size
    ? items.filter((item) => selected.has(item.id))
    : current
      ? [current]
      : [];
  const wide = columns >= 95;
  const bodyHeight = Math.max(6, terminalRows - 7);
  const listPaneHeight = wide ? bodyHeight : Math.floor(bodyHeight * 0.45);
  const listHeight = Math.max(1, listPaneHeight - 1);
  const detailHeight = Math.max(1, wide ? bodyHeight - 2 : bodyHeight - listPaneHeight - 4);
  const scope = global ? 'Global' : 'Project';
  const outputHeight = Math.max(1, bodyHeight - 3);
  const outputWidth = Math.max(1, columns - 8);
  const detailWidth = Math.max(1, wide ? Math.floor((columns - 4) * 0.62) - 4 : columns - 4);
  const outputLines = wrapAnsi(output.replace(/\r(?!\n)/g, '\n'), outputWidth, {
    hard: true,
    trim: false,
  }).split('\n');
  const details = wrapAnsi(
    (current?.summary ?? current?.details ?? ['No selection.']).join('\n'),
    detailWidth,
    {
      hard: true,
      trim: false,
    }
  ).split('\n');

  const changeTab = (next: Tab) => {
    setTab(next);
    setMode('browse');
    setOffset(0);
  };
  const quit = () => {
    operation.current?.abort();
    search.current?.abort();
    exit();
  };
  const append = (chunk: string) => {
    if (!mounted.current) return;
    // Bound output memory while preserving the most recent operation results.
    setOutput((previous) => (previous + stripTerminalEscapes(chunk)).slice(-100_000));
  };
  const execute = async (action: ManagerAction, actionItems: ManagerItem[]) => {
    const controller = new AbortController();
    operation.current = controller;
    setPending(undefined);
    setMode('output');
    setOffset(0);
    setOutput('');
    setBusy(true);
    setOutputStatus(`${action} · ${scope.toLowerCase()} · ${actionItems.length} selection(s)`);
    try {
      const code = await services.run(action, actionItems, global, append, controller.signal);
      if (!mounted.current) return;
      await reload();
      setOutputStatus(
        `${action}: ${code === 0 ? 'completed' : `exited ${code}`} · ${scope.toLowerCase()}`
      );
    } catch (error) {
      if (mounted.current) {
        append(`\n${controller.signal.aborted ? 'Operation cancelled.' : formatError(error)}\n`);
        setOutputStatus(controller.signal.aborted ? 'Cancelled' : 'Operation failed');
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
        setSelected(new Set());
      }
      if (operation.current === controller) operation.current = undefined;
    }
  };
  const requestAction = (action: string) => {
    if (loading || busy) return;
    const inspectionId = ++inspection.current;
    if (action === 'back') {
      setMode('browse');
      return;
    }
    if (!targets.length) return;
    if (action === 'inspect') {
      setMode('output');
      setOffset(0);
      setOutput('');
      setOutputStatus('');
      void services
        .inspect(targets[0]!)
        .then((text) => {
          if (mounted.current && inspectionId === inspection.current) setOutput(text);
        })
        .catch((error) => {
          if (inspectionId === inspection.current) append(formatError(error));
        });
      return;
    }
    if (action === 'details') {
      setOutputStatus('');
      setMode('output');
      setOffset(0);
      setOutput(targets.map((item) => `${item.name}\n${item.details.join('\n')}`).join('\n\n'));
      return;
    }
    const typed = action as ManagerAction;
    if (
      (typed === 'check' || typed === 'update') &&
      !targets.some((item) => item.trackedNames.length)
    ) {
      setNotice(
        'No skills lock entries in this selection. Add the skill with this CLI to enable updates.'
      );
      setMode('browse');
      return;
    }
    if (typed === 'check') {
      void execute(typed, targets);
      return;
    }
    setPending({ action: typed, items: targets });
    setMode('confirm');
  };
  const submitSearch = async (value: string) => {
    setQueries((previous) => ({ ...previous, [tab]: value }));
    setMode('browse');
    setSelected(new Set());
    setNotice('');
    if (tab !== 'Discover') return;
    search.current?.abort();
    if (!value.trim()) {
      search.current = undefined;
      setSearching(false);
      setDiscoveries([]);
      return;
    }
    const controller = new AbortController();
    search.current = controller;
    setDiscoveries([]);
    setHighlight((previous) => ({ ...previous, Discover: '' }));
    setSearching(true);
    setNotice('', 'Discover');
    try {
      const result = await services.discover(value.trim(), controller.signal);
      if (mounted.current && search.current === controller) {
        setDiscoveries(result);
      }
    } catch (error) {
      if (mounted.current && search.current === controller)
        setNotice(controller.signal.aborted ? 'Search cancelled' : formatError(error), 'Discover');
    } finally {
      if (mounted.current && search.current === controller) setSearching(false);
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      quit();
      return;
    }
    if (key.escape) {
      if (busy) {
        operation.current?.abort();
        return;
      }
      if (searching && tab === 'Discover') {
        search.current?.abort();
        setSearching(false);
        setNotice('Search cancelled', 'Discover');
      }
      if (!(searching && tab === 'Discover')) setNotice('');
      inspection.current++;
      setMode('browse');
      setPending(undefined);
      setOffset(0);
      return;
    }
    if (mode === 'search' || mode === 'actions' || mode === 'confirm') return;
    if (input === 'q') {
      quit();
      return;
    }
    if (mode === 'help') {
      if (input === '?') setMode('browse');
      return;
    }
    if (mode === 'output') {
      if (key.downArrow || key.pageDown)
        setOffset((n) =>
          Math.min(
            Math.max(0, outputLines.length - outputHeight),
            n + (key.pageDown ? outputHeight : 1)
          )
        );
      if (key.upArrow || key.pageUp)
        setOffset((n) => Math.max(0, n - (key.pageUp ? outputHeight : 1)));
      return;
    }
    if (busy) return;
    if (input === '?') {
      setMode('help');
      return;
    }
    if (key.tab || key.leftArrow || key.rightArrow) {
      const direction = key.leftArrow || key.shift ? -1 : 1;
      changeTab(tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length]!);
      return;
    }
    if (input === '/') {
      setMode('search');
      return;
    }
    if (input === 'g') {
      setNotices({ Installed: '', Discover: '', Sources: '' });
      setLoading(true);
      setInventory({ skills: [], sources: [] });
      setGlobal((value) => !value);
      setSelections({ Installed: new Set(), Discover: new Set(), Sources: new Set() });
      setOffset(0);
      setHighlight({ Installed: '', Discover: '', Sources: '' });
      return;
    }
    if (input === 'r') {
      void reload();
      return;
    }
    if (input === ' ' && current && tab !== 'Discover') {
      setSelected((previous) => {
        const next = new Set(previous);
        if (next.has(current.id)) next.delete(current.id);
        else next.add(current.id);
        return next;
      });
    }
    if (key.pageDown)
      setOffset((n) => Math.min(Math.max(0, details.length - detailHeight), n + detailHeight));
    if (key.pageUp) setOffset((n) => Math.max(0, n - detailHeight));
    if (tab === 'Discover' && ['c', 'u', 'd'].includes(input)) return;
    if (input === 'c') requestAction('check');
    if (input === 'u') requestAction('update');
    if (input === 'd') requestAction('remove');
    if (input === 'i')
      requestAction(tab === 'Discover' ? 'install' : tab === 'Sources' ? 'details' : 'inspect');
  });

  const actionItems: Choice[] =
    tab === 'Discover'
      ? [
          { label: `Install into ${scope.toLowerCase()} scope`, value: 'install' },
          { label: 'Show source', value: 'details' },
          { label: 'Back', value: 'back' },
        ]
      : [
          { label: 'Show full details', value: 'details' },
          ...(tab === 'Installed' ? [{ label: 'Read SKILL.md', value: 'inspect' }] : []),
          { label: 'Check for updates (network)', value: 'check' },
          { label: 'Update selected skills', value: 'update' },
          { label: 'Remove from all agents in this scope', value: 'remove' },
          { label: 'Back', value: 'back' },
        ];
  const outputOffset = Math.min(offset, Math.max(0, outputLines.length - outputHeight));
  const detailOffset = Math.min(offset, Math.max(0, details.length - detailHeight));
  const dialog = mode === 'actions' || mode === 'confirm' || mode === 'search';
  let content;
  if (mode === 'help') {
    content = h(
      Box,
      { flexDirection: 'column', paddingX: 2, paddingTop: 1 },
      h(Text, { bold: true }, 'Keyboard shortcuts'),
      h(
        Text,
        {},
        '\n↑↓ or j/k    Move through skills\nEnter        Actions for the selection\n/            Filter or search\nTab / ⇧Tab   Switch tabs\ng            Switch project/global\nSpace        Select multiple skills\nPgUp/PgDn    Scroll details or output\nc / u / d    Check / update / remove\ni            Inspect or install\nr            Refresh\n\nEsc back     q quit'
      )
    );
  } else if (mode === 'search') {
    content = h(
      Box,
      {
        borderStyle: 'round',
        borderColor: 'cyan',
        paddingX: 1,
        flexDirection: 'column',
        width: Math.min(columns - 8, 68),
        alignSelf: 'center',
        marginTop: 1,
      },
      h(
        Text,
        { bold: true },
        tab === 'Discover' ? 'Search skills.sh' : `Filter ${tab.toLowerCase()}`
      ),
      h(TextInput, {
        key: tab,
        defaultValue: query,
        placeholder: 'Type a name or source…',
        onSubmit: (value) => {
          void submitSearch(value);
        },
      }),
      h(Text, { dimColor: true }, 'Enter apply · Esc cancel')
    );
  } else if (mode === 'confirm' && pending) {
    const names = [
      ...new Set(pending.items.flatMap((item) => (item.names.length ? item.names : [item.name]))),
    ];
    content = h(
      Box,
      {
        borderStyle: 'round',
        borderColor: 'yellow',
        paddingX: 1,
        flexDirection: 'column',
        width: Math.min(columns - 8, 68),
        alignSelf: 'center',
        marginTop: 1,
      },
      h(Text, { bold: true, color: 'yellow' }, `Confirm ${pending.action} · ${scope}`),
      h(Text, {}, `${names.length} skill(s) · ${scope.toLowerCase()} scope`),
      h(Text, { wrap: 'truncate-end' }, names.join(', ')),
      h(
        Text,
        {},
        pending.action === 'remove'
          ? 'Removes files and links from all agents in this scope, and their lock entries.'
          : 'Upstream content can replace local edits. Uses this scope’s detected agents.'
      ),
      h(SelectInput<string>, {
        items: [
          { label: 'Continue', value: 'yes' },
          { label: 'Cancel', value: 'no' },
        ],
        initialIndex: 1,
        onSelect: (item) => {
          if (item.value === 'yes') void execute(pending.action, pending.items);
          else {
            setPending(undefined);
            setMode('browse');
          }
        },
      })
    );
  } else if (mode === 'actions') {
    content = h(
      Box,
      {
        borderStyle: 'round',
        borderColor: 'cyan',
        flexDirection: 'column',
        paddingX: 1,
        width: Math.min(columns - 8, 68),
        alignSelf: 'center',
        marginTop: 1,
      },
      h(Text, { bold: true }, `${targets.length} selection(s) · ${scope}`),
      h(SelectInput<string>, { items: actionItems, onSelect: (item) => requestAction(item.value) })
    );
  } else if (mode === 'output') {
    content = h(
      Box,
      {
        borderStyle: 'round',
        borderColor: busy ? 'yellow' : 'cyan',
        paddingX: 1,
        flexDirection: 'column',
        flexGrow: 1,
        overflow: 'hidden',
      },
      h(Text, { bold: true }, busy ? 'Operation running…' : 'Result · Esc returns to browsing'),
      h(
        Text,
        { wrap: 'wrap' },
        outputLines.slice(outputOffset, outputOffset + outputHeight).join('\n') ||
          'Waiting for output…'
      )
    );
  }
  const browsing = h(
    Box,
    { flexDirection: wide ? 'row' : 'column', flexGrow: 1, overflow: 'hidden' },
    h(
      Box,
      {
        flexDirection: 'column',
        paddingRight: wide ? 2 : 0,
        width: wide ? '38%' : '100%',
        height: listPaneHeight,
        flexShrink: 0,
        overflow: 'hidden',
      },
      ...tabs.map((view) => {
        const data =
          view === 'Installed'
            ? inventory.skills
            : view === 'Sources'
              ? inventory.sources
              : discoveries;
        const visible =
          view === 'Discover'
            ? data
            : data.filter((item) =>
                `${item.name} ${item.source} ${item.status}`
                  .toLowerCase()
                  .includes(queries[view].toLowerCase())
              );
        return h(
          Box,
          { key: view, display: view === tab ? 'flex' : 'none', flexDirection: 'column' },
          visible.length
            ? h(SelectInput<string>, {
                key: `${global}:${view}:${queries[view]}:${listHeight}:${JSON.stringify(visible.map((item) => item.id))}`,
                items: visible.map((item) => ({
                  label: `${selections[view].has(item.id) ? '✓ ' : ''}${item.name}${item.status === 'modified' ? ' · local changes' : item.status === 'missing' ? ' · missing' : view === 'Sources' ? ` · ${item.status}` : ''}`,
                  value: item.id,
                })),
                limit: Math.max(1, listHeight),
                initialIndex: Math.max(
                  0,
                  visible.findIndex((item) => item.id === highlight[view])
                ),
                itemComponent: ListLabel,
                isFocused: view === tab && mode === 'browse' && !busy && !loading,
                onHighlight: (item) => {
                  if (item) {
                    setHighlight((previous) => ({ ...previous, [view]: item.value }));
                    setOffset(0);
                  }
                },
                onSelect: (item) => {
                  if (item) {
                    setHighlight((previous) => ({ ...previous, [view]: item.value }));
                    setMode('actions');
                  }
                },
              })
            : h(
                Text,
                { dimColor: true },
                loading
                  ? 'Loading…'
                  : view === 'Discover'
                    ? 'Press / to search skills.sh.'
                    : 'No skills match. Press / to filter or g to change scope.'
              )
        );
      })
    ),
    h(
      Box,
      {
        borderStyle: 'single',
        borderColor: 'gray',
        borderTop: !wide,
        borderLeft: wide,
        borderRight: false,
        borderBottom: false,
        flexDirection: 'column',
        paddingLeft: wide ? 2 : 0,
        paddingTop: wide ? 0 : 1,
        flexGrow: 1,
        width: wide ? '62%' : '100%',
        overflow: 'hidden',
      },
      h(
        Box,
        { height: 2, flexShrink: 0 },
        h(Text, { bold: true, wrap: 'truncate-end' }, current?.name ?? '')
      ),
      h(Text, { wrap: 'wrap' }, details.slice(detailOffset, detailOffset + detailHeight).join('\n'))
    )
  );
  if (columns < 52 || terminalRows < 16)
    return h(
      Box,
      { height: Math.max(1, terminalRows), width: columns, flexDirection: 'column' },
      h(Text, {}, 'Enlarge terminal to at least 52 × 16.'),
      h(Text, {}, 'Esc back · q quit · Ctrl+C quit')
    );
  const context =
    mode === 'output'
      ? outputStatus
      : mode !== 'browse'
        ? ''
        : tab === 'Discover'
          ? searching
            ? 'Searching…'
            : notices.Discover || (query ? `Search: ${query}` : '')
          : loading
            ? 'Loading…'
            : loadError || notices[tab] || (query ? `Filter: ${query}` : '');
  const footer =
    mode === 'search'
      ? 'Enter apply    Esc cancel'
      : mode === 'help'
        ? 'Esc back    q quit'
        : dialog
          ? '↑↓ choose    Enter confirm    Esc back'
          : mode === 'output'
            ? busy
              ? 'Esc cancel    Ctrl+C quit'
              : '↑↓ scroll    Esc back    q quit'
            : `↑↓ move    Enter actions    / ${tab === 'Discover' ? 'search' : 'filter'}    Tab switch    ? help    q quit`;
  return h(
    Box,
    {
      height: terminalRows,
      width: columns,
      paddingX: 2,
      flexDirection: 'column',
      overflow: 'hidden',
    },
    h(
      Box,
      { height: 2, flexShrink: 0 },
      h(Box, { flexGrow: 1 }, h(Text, { bold: true }, 'Skills')),
      h(
        Text,
        { dimColor: true },
        `${scope}${agentFilter?.length ? ` · ${agentFilter.join(', ')}` : ''}`
      )
    ),
    h(
      Box,
      { height: 2, gap: 3, flexShrink: 0 },
      ...tabs.map((name) =>
        h(
          Text,
          {
            key: name,
            bold: name === tab,
            color: name === tab ? 'cyan' : 'gray',
            underline: name === tab,
          },
          name === tab ? `${name} · ${items.length}` : name
        )
      )
    ),
    h(
      Box,
      { height: 1, flexShrink: 0 },
      h(Text, { dimColor: true, wrap: 'truncate-end' }, context)
    ),
    h(
      Box,
      { height: bodyHeight, flexDirection: 'column', overflow: 'hidden' },
      h(
        Box,
        { display: mode === 'browse' ? 'flex' : 'none', height: '100%', flexDirection: 'column' },
        browsing
      ),
      mode !== 'browse' ? content : null
    ),
    h(
      Box,
      { height: 1, flexShrink: 0 },
      h(
        Text,
        { dimColor: true, wrap: 'truncate-end' },
        `${selected.size ? `${selected.size} selected · ` : ''}${footer}`
      )
    )
  );
}
