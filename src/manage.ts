import { diagnostics, formatError } from './diagnostics.ts';
import type { AgentType } from './types.ts';

/** Load Ink only for interactive sessions; ordinary CLI/API calls do not initialize a TUI. */
export async function runManager(global: boolean, agentFilter?: AgentType[]): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      formatError(
        diagnostics.SKILLS_MANAGEMENT_FAILED({
          reason:
            'Interactive list requires a terminal. Use skills list or skills list --json in scripts.',
        })
      )
    );
    process.exitCode = 1;
    return;
  }
  const [{ render }, { createElement }, { ManagerApp }, { createManagerServices }] =
    await Promise.all([
      import('ink'),
      import('react'),
      import('./tui/app.ts'),
      import('./tui/services.ts'),
    ]);
  const app = render(
    createElement(ManagerApp, {
      services: createManagerServices(process.argv[1]!),
      global,
      agentFilter,
    }),
    { alternateScreen: true, exitOnCtrlC: false, patchConsole: false }
  );
  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
  }
}
