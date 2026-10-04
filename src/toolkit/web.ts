/**
 * The web — two tools every agent harness ends up with: `web_search` to FIND pages, `web_fetch` to
 * READ one. Discovery and retrieval are different jobs, so they are different tools.
 *
 * Search needs a backend. The default is the one opencode uses: Exa's hosted MCP endpoint, called
 * with a plain JSON-RPC POST — no key, no SDK, no dependency (an `EXA_API_KEY` raises its rate
 * limits). The backend is a seam: an app can hand in Brave, Tavily, or OpenRouter's search instead.
 *
 * Fetch reads a URL and returns it as Markdown: HTML is converted by a small hand-written
 * converter (headings, links, lists, code, tables), JSON and text pass through, binary files are
 * refused. Long pages come back in pieces (`start`). Every hop of a redirect is checked, and
 * addresses on the local machine or a private network are refused unless the app allows them,
 * so a web page cannot talk the agent into probing its host's network.
 *
 * Everything a page says is DATA, not instructions (the engine's system rules say so): a fetched
 * page can still lie, so answers should name the URLs they rest on.
 */
import type { AgentTool, Toolset } from '../index.ts';

/** Finds pages for a query and returns them as text for the model: title, URL, highlights. */
export type SearchBackend = (query: string, count: number, signal: AbortSignal) => Promise<string>;

export interface WebOptions {
  /** Default: Exa's hosted MCP (`exaSearch()`). */
  search?: SearchBackend;
  /** Fetch pages on localhost and private networks. Default false. */
  allowPrivate?: boolean;
  /** For tests, or to route through a proxy. */
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
}

const MAX_BYTES = 5_000_000;
const REDIRECTS = 5;
const PAGE = 12_000;

// ── search ──────────────────────────────────────────────────────────────────

export interface ExaOptions {
  /** Default: `process.env.EXA_API_KEY`. Without one, the free hosted endpoint is used. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** The text of a (possibly server-sent-events) JSON-RPC reply from an MCP server. */
export function mcpReplyText(body: string): string {
  const data = body.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
  const payloads = data.length ? data : [body.trim()];
  for (const p of payloads) {
    let msg: { result?: { content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
    try {
      msg = JSON.parse(p);
    } catch {
      continue;
    }
    if (msg.error) throw new Error(msg.error.message ?? 'The search service returned an error');
    const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n').trim();
    if (msg.result?.isError) throw new Error(text || 'The search service returned an error');
    return text;
  }
  throw new Error('The search service sent a reply that could not be read');
}

export function exaSearch(options: ExaOptions = {}): SearchBackend {
  return async (query, count, signal) => {
    const key = options.apiKey ?? process.env.EXA_API_KEY;
    const url = `https://mcp.exa.ai/mcp${key ? `?exaApiKey=${encodeURIComponent(key)}` : ''}`;
    const res = await (options.fetch ?? globalThis.fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, numResults: count } } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 25_000)]),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`The search service answered ${res.status}${res.status === 429 ? ' (rate-limited: try again shortly, or set EXA_API_KEY)' : ''}`);
    return mcpReplyText(body);
  };
}

// ── addresses we will not fetch ─────────────────────────────────────────────

/** True for localhost, loopback, link-local, private-network and `.local` / `.internal` hosts. A name that merely RESOLVES to such an address is not caught. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateHost(mapped[1]!);
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  return false;
}

// ── HTML → Markdown ─────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', rarr: '→', larr: '←', times: '×' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const absolute = (href: string, base?: string) => {
  try {
    return base ? new URL(href, base).href : href;
  } catch {
    return href;
  }
};

/** A web page as Markdown: the main content, headings, links, lists, code and tables; scripts and chrome dropped. */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  let s = html;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1];
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|iframe|head|canvas|select|button|form)\b[\s\S]*?<\/\1>/gi, '');
  // Prefer the page's main content when it says where that is.
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i.exec(s);
  if (main && main[2]!.length > 400) s = main[2]!;
  else s = s.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, '');

  // Code blocks are set aside while the rest is cleaned (a decoded `<` must not look like a tag, and
  // indentation must survive the whitespace pass), then put back.
  const blocks: string[] = [];
  s = s
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => {
      blocks.push(decodeEntities(code.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, ''));
      return `\n\n\u0000CODE${blocks.length - 1}\u0000\n\n`;
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => {
      const text = t.replace(/<[^>]+>/g, '').trim();
      return text && !href.startsWith('#') && !/^javascript:/i.test(href) ? `[${text}](${absolute(decodeEntities(href), baseUrl)})` : text;
    })
    .replace(/<img\b[^>]*?alt\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, alt: string) => `[image: ${alt}]`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t: string) => (t.trim() ? `**${t.trim()}**` : ''))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t: string) => (t.trim() ? `*${t.trim()}*` : ''))
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => `\`${t.replace(/<[^>]+>/g, '')}\``)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|ul|ol|table|blockquote|dl|figure|tr)>/gi, '\n\n')
    .replace(/<(p|div|section|ul|ol|table|blockquote|dl|figure)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');

  s = decodeEntities(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/(\| )+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000CODE(\d+)\u0000/g, (_, i: string) => `\`\`\`\n${blocks[Number(i)]}\n\`\`\``)
    .trim();
  const heading = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : '';
  return heading && !s.startsWith(`# ${heading}`) ? `# ${heading}\n\n${s}` : s;
}

/** A page with the tags removed and nothing else. */
export function htmlToText(html: string): string {
  return decodeEntities(htmlToMarkdown(html).replace(/```/g, '').replace(/^#+ /gm, '').replace(/[*`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')).replace(/\n{3,}/g, '\n\n').trim();
}

// ── the tools ───────────────────────────────────────────────────────────────

const clampCount = (n: unknown) => Math.min(10, Math.max(1, Math.round(Number(n)) || 5));

export function webToolset(options: WebOptions = {}): Toolset {
  const doFetch = options.fetch ?? globalThis.fetch;
  const search = options.search ?? exaSearch({ fetch: options.fetch });
  const agent = options.userAgent ?? 'Mozilla/5.0 (compatible; agento/1.0; +https://github.com/ghostmind-labo/agento)';

  /** GET with redirects followed by hand, so each hop is checked. */
  async function get(url: string, signal: AbortSignal, timeoutMs: number): Promise<{ res: Response; finalUrl: string }> {
    let current = url;
    for (let hop = 0; hop <= REDIRECTS; hop++) {
      let u: URL;
      try {
        u = new URL(current);
      } catch {
        throw new Error(`"${current}" is not a valid URL`);
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http and https pages can be fetched (got ${u.protocol})`);
      if (!options.allowPrivate && isPrivateHost(u.hostname)) throw new Error(`${u.hostname} is a local or private address; fetching it is not allowed here`);
      const res = await doFetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': agent, Accept: 'text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current).href;
        continue;
      }
      return { res, finalUrl: current };
    }
    throw new Error(`Too many redirects (more than ${REDIRECTS})`);
  }

  async function body(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_BYTES) throw new Error(`The page is ${Math.round(declared / 1e6)} MB; the limit is ${MAX_BYTES / 1e6} MB`);
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error(`The page is larger than ${MAX_BYTES / 1e6} MB`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const tools: AgentTool[] = [
    {
      name: 'web_search',
      description:
        'Search the web and get the top pages: title, URL and the relevant passages. Use it to FIND information (news, documentation, facts that may have changed since your training); then read a result with web_fetch. Describe the page you want rather than listing keywords. Name the URLs your answer rests on.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, num_results: { type: 'number', description: '1–10, default 5' } }, required: ['query'] },
      run: async (a, ctx) => {
        const query = String(a.query ?? '').trim();
        if (!query) throw new Error('`query` is empty');
        const text = await search(query, clampCount(a.num_results), ctx.signal);
        return text ? (text.length > 12_000 ? `${text.slice(0, 12_000)}\n…(truncated)` : text) : 'No results.';
      },
    },
    {
      name: 'web_fetch',
      description: `Read one web page by URL and get it as Markdown (HTML is converted; JSON and text are returned as they are). Long pages come back in pieces of ${PAGE} characters: pass \`start\` to continue. Use web_search to find the URL first. \`format\` can be "markdown" (default), "text" or "html".`,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          format: { type: 'string', enum: ['markdown', 'text', 'html'] },
          start: { type: 'number', description: 'Character offset to continue from' },
          timeout_s: { type: 'number', description: 'Default 20, at most 60' },
        },
        required: ['url'],
      },
      run: async (a, ctx) => {
        const url = String(a.url ?? '').trim();
        const timeout = Math.min(60, Math.max(1, Number(a.timeout_s) || 20)) * 1000;
        const { res, finalUrl } = await get(url, ctx.signal, timeout);
        if (!res.ok) throw new Error(`${finalUrl} answered ${res.status} ${res.statusText}`.trim());
        const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (type && !/^(text\/|application\/(json|xml|xhtml\+xml|javascript|x-ndjson|yaml|toml)|application\/[a-z.+-]*\+(json|xml))/.test(type)) {
          throw new Error(`${finalUrl} is ${type}, which cannot be read as text`);
        }
        const raw = await body(res);
        const format = a.format === 'html' || a.format === 'text' ? a.format : 'markdown';
        const isHtml = type.includes('html') || (!type && /<html|<!doctype html/i.test(raw.slice(0, 500)));
        const text = !isHtml ? raw : format === 'html' ? raw : format === 'text' ? htmlToText(raw) : htmlToMarkdown(raw, finalUrl);
        const start = Math.max(0, Math.floor(Number(a.start) || 0));
        const piece = text.slice(start, start + PAGE);
        const rest = text.length - (start + piece.length);
        return `${finalUrl}${finalUrl !== url ? ` (from ${url})` : ''} · ${type || 'text'} · ${text.length} characters\n\n${piece}${rest > 0 ? `\n\n…(${rest} more characters; continue with start=${start + piece.length})` : ''}`;
      },
    },
  ];
  return { name: 'web', description: 'Search the web and read pages.', tools };
}
