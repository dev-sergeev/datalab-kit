/** Conservative shell parsing: unfamiliar syntax is confirmed, never executed here. */
function shellCommands(input: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  const pushWord = () => { if (started) words.push(word); word = ''; started = false; };
  const pushCommand = () => { pushWord(); if (words.length) commands.push(words); words = []; };
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) { quote = undefined; continue; }
      if (quote === '"' && (char === '$' || char === '`' || char === '\\')) return undefined;
      word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === '\\') {
      const next = input[++index];
      if (next === undefined || next === '\n') return undefined;
      word += next; started = true; continue;
    }
    if ('<>$`(){}#'.includes(char) || char === '\u0000') return undefined;
    if (char === '&') {
      if (input[index + 1] !== '&') return undefined;
      index++; pushCommand(); continue;
    }
    if (char === '|' || char === ';' || char === '\n') { pushCommand(); continue; }
    if (/\s/.test(char)) { pushWord(); continue; }
    word += char; started = true;
  }
  if (quote) return undefined;
  pushCommand();
  return commands.length ? commands : undefined;
}

const readers = new Set(['read', 'cat', 'ls', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'fd',
  'head', 'tail', 'wc', 'stat', 'pwd', 'basename', 'dirname', 'realpath', 'which',
  'diff', 'cmp', 'comm', 'du', 'df', 'md5sum', 'sha1sum', 'sha256sum', 'cksum',
  'whoami', 'id', 'uname', 'uptime', 'ps', 'printenv', 'echo', 'cd', 'sort']);

export function isReadOnlyWords(words: readonly string[]): boolean {
  const [name, ...args] = words;
  if (!name) return false;
  if (name === 'curl') return ['-q', '--disable'].includes(args[0] ?? '')
    && args.includes('--noproxy') && isLocalReadCurl(args);
  if (name === 'git') {
    return ['status', 'diff', 'log', 'show', 'blame', 'ls-files'].includes(args[0] ?? '')
      && !args.some(arg => /^--(?:output|ext-diff|textconv)/.test(arg));
  }
  if (!readers.has(name)) return false;
  if (name === 'find' && args.some(arg => /^-(?:delete|exec|ok|fprint|fprintf|fls)/.test(arg))) return false;
  if (name === 'fd' && args.some(arg => /^--exec/.test(arg) || /^-[^-]*[xX]/.test(arg))) return false;
  if (name === 'rg' && args.some(arg => /^--pre/.test(arg))) return false;
  if (name === 'sort' && args.some(arg => /^--o/.test(arg) || /^-[^-]*o/.test(arg))) return false;
  if (name === 'diff' && args.some(arg => /^--out/.test(arg))) return false;
  return true;
}

export function isReadOnlyCommand(command: string): boolean {
  const commands = shellCommands(command);
  return commands !== undefined && commands.every(isReadOnlyWords);
}

export function isReadOnlyCommandInput(input: unknown): boolean {
  if (typeof input === 'string') return isReadOnlyCommand(input);
  if (input && typeof input === 'object' && 'command' in input && typeof input.command === 'string') {
    return isReadOnlyCommand(input.command);
  }
  return false;
}

function isLocalReadCurl(args: readonly string[]): boolean {
  let urls = 0;
  const switches = new Set(['-q', '--disable', '-s', '-S', '-sS', '-f', '-fsS', '-v', '-i', '-I',
    '--silent', '--show-error', '--fail', '--verbose', '--include', '--head']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (switches.has(arg)) continue;
    if (arg === '-X' || arg === '--request') {
      if (!['GET', 'HEAD'].includes(args[++index] ?? '')) return false;
      continue;
    }
    if (arg === '--noproxy') {
      if (args[++index] !== '*') return false;
      continue;
    }
    if (arg === '--max-time' || arg === '--connect-timeout' || arg === '-m') {
      if (!/^\d+(?:\.\d+)?$/.test(args[++index] ?? '')) return false;
      continue;
    }
    if (arg.startsWith('-')) return false;
    try {
      const url = new URL(arg);
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password) return false;
    } catch { return false; }
    urls++;
  }
  return urls > 0;
}

/** Local read requests must not inherit a proxy, curlrc mutation or redirect. */
export function normalizeLocalReadCurl(command: string): string | undefined {
  const commands = shellCommands(command);
  if (commands?.length !== 1 || commands[0]?.[0] !== 'curl' || !isLocalReadCurl(commands[0].slice(1))) return undefined;
  const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
  return commands.map(words => {
    const args = words[0] === 'curl' ? ['curl', '-q', '--noproxy', '*', ...words.slice(1)] : words;
    return args.map(quote).join(' ');
  }).join('');
}
