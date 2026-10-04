/**
 * Tools for an agent nobody is watching (`agento mcp`).
 *
 * A change normally waits for a person to approve it. Here there is none, so the policy is decided
 * when the toolset is built, and the model is only ever offered what it may actually do:
 *   - by default, no changes at all: write_file, edit_file and run_command are not offered;
 *   - `autoApprove`: every tool is offered and nothing is asked;
 *   - `allowShell`: run_command is offered, but only for SIMPLE commands starting with one of those
 *     words; any other command comes back as a plain tool error (the turn goes on, it does not end).
 * Offering only what is allowed beats offering everything and refusing: a refused change ends a turn
 * as "the person declined", which in a graph would be a dead end.
 */
import type { Toolset } from '../index.ts';
import { shellAllowed } from './acp.ts';

export interface Unattended {
  autoApprove?: boolean;
  allowShell?: string[];
}

export function unattended(toolsets: Toolset[], policy: Unattended): Toolset[] {
  return toolsets.map(set => ({
    ...set,
    tools: set.tools.flatMap(tool => {
      if (!tool.write) return [tool];
      if (policy.autoApprove) return [{ ...tool, write: undefined }];
      if (tool.name === 'run_command' && policy.allowShell?.length) {
        const allow = policy.allowShell;
        return [
          {
            ...tool,
            description: `${tool.description} Here only simple commands starting with ${allow.map(w => `"${w}"`).join(', ')} are allowed.`,
            write: {
              describe: (args: Record<string, unknown>) => {
                if (!shellAllowed(args.command, allow)) throw new Error(`That command is not allowed here. Only simple commands starting with ${allow.map(w => `"${w}"`).join(', ')} can be run.`);
                return null; // allowed: no approval needed
              },
            },
          },
        ];
      }
      return [];
    }),
  }));
}
