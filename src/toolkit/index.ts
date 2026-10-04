/**
 * The standard tools — what any agent in a terminal, an editor or a chat needs, ready to hand over.
 *
 * The engine itself ships no tools: an app decides what its agent may do. But files, a shell and the
 * web are what nearly every agent needs, and each one is easy to get subtly wrong (paths that escape
 * the folder, a shell that never times out, a page that is 5 MB of script). So they are written once
 * here, tested, and offered as one call:
 *
 *   toolsets: standardToolsets({ root: '/path/to/project' })
 *
 * Reads run freely. Changes (write_file, edit_file, run_command) carry a `write` account, so the
 * loop asks the app's `approve` first — or refuses when the app gave none, which is how a read-only
 * agent is made. The web tools only read, but they reach out, so they can be left out (`web: false`).
 */
import type { Toolset } from '../index.ts';
import { fileToolset, type FileToolsetOptions } from './files.ts';
import { shellToolset } from './shell.ts';
import { webToolset, type WebOptions } from './web.ts';

export interface StandardToolsOptions {
  /** The working directory every file path and command is confined to. Needed unless both `files` and `shell` are off. */
  root?: string;
  /** Include the shell (run_command). Default true; each command still needs approval. */
  shell?: boolean;
  /** Include web_search and web_fetch. Default true. */
  web?: boolean;
  /** The file tools: `false` leaves them out (a web-only agent), or pass options such as `{ ripgrep: false }`. */
  files?: FileToolsetOptions | false;
  /** Search backend, private-address policy and so on. */
  webOptions?: WebOptions;
}

/** list_dir, read_file, glob, search, write_file, edit_file · run_command · web_search, web_fetch. */
export function standardToolsets(o: StandardToolsOptions = {}): Toolset[] {
  const withFiles = o.files !== false;
  const withShell = o.shell !== false;
  if ((withFiles || withShell) && !o.root) throw new Error('standardToolsets needs `root` for the file and shell tools (or pass files: false and shell: false)');
  const root = o.root ?? '';
  return [
    ...(withFiles ? [fileToolset(root, o.files || undefined)] : []),
    ...(withShell ? [shellToolset(root)] : []),
    ...(o.web === false ? [] : [webToolset(o.webOptions)]),
  ];
}

export { fileToolset, inside, walkFiles, globToRegExp, nodeSearch } from './files.ts';
export type { FileToolsetOptions } from './files.ts';
export { shellToolset, runCommand } from './shell.ts';
export { webToolset, exaSearch, mcpReplyText, htmlToMarkdown, htmlToText, isPrivateHost, parseIPv6, decodeEntities } from './web.ts';
export type { WebOptions, SearchBackend, ExaOptions } from './web.ts';
