/**
 * Shell — one command at a time, in the working directory, each approved by the person first.
 *
 * Every command is a change as far as the loop is concerned (it can do anything), so the core asks
 * `approve` with the command itself as the sentence. Output is capped, and a command that outlives
 * its timeout — or the turn's Stop — is killed.
 */
import { spawn } from 'node:child_process';
import type { Toolset } from '../engine.ts';

const OUT_CAP = 12_000;

export function runCommand(command: string, cwd: string, timeoutS: number, signal: AbortSignal): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise(ok => {
    const child = spawn('bash', ['-lc', command], { cwd, env: process.env, signal });
    let output = '';
    let timedOut = false;
    const add = (d: Buffer) => {
      if (output.length < OUT_CAP * 2) output += d.toString();
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutS * 1000);
    const done = (code: number | null) => {
      clearTimeout(timer);
      ok({ code, output: output.length > OUT_CAP ? `${output.slice(0, OUT_CAP / 2)}\n…(cut)…\n${output.slice(-OUT_CAP / 2)}` : output, timedOut });
    };
    child.on('close', done);
    child.on('error', () => done(null));
  });
}

export function shellToolset(root: string): Toolset {
  return {
    name: 'shell',
    description: `Shell commands in ${root}.`,
    tools: [
      {
        name: 'run_command',
        description: 'Run one bash command in the working directory and get its output and exit code. Default timeout 60 s (max 600). Asks the person first.',
        parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_s: { type: 'number' } }, required: ['command'] },
        write: { describe: a => `Run: ${String(a.command ?? '')}` },
        run: async (a, ctx) => {
          const t = Math.min(600, Math.max(1, Number(a.timeout_s) || 60));
          const r = await runCommand(String(a.command ?? ''), root, t, ctx.signal);
          return `${r.timedOut ? `(killed after ${t}s)\n` : ''}exit ${r.code ?? 'none'}\n${r.output || '(no output)'}`;
        },
      },
    ],
  };
}
