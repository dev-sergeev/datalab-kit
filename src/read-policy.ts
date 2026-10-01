import { globSync } from 'node:fs';
import { resolve } from 'node:path';

type ShellWord = { text: string; glob: boolean };

/** Parse inspection syntax without executing expansions or subprocesses. */
function shellCommands(input: string): ShellWord[][] | undefined {
  if (input.includes('\u0000')) return undefined;
  const commands: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let word = '';
  let glob = false;
  let started = false;
  let inputTarget = false;
  let quote: "'" | '"' | undefined;
  const pushWord = () => {
    if (started) {
      if (inputTarget) inputTarget = false;
      else words.push({ text: word, glob });
    }
    word = ''; glob = false; started = false;
  };
  const pushCommand = () => { pushWord(); if (words.length) commands.push(words); words = []; };
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) { quote = undefined; continue; }
      if (quote === '"' && (char === '$' || char === '`')) return undefined;
      if (quote === '"' && char === '\\') {
        const next = input[++index];
        if (next === undefined) return undefined;
        if (next !== '\n') word += ['$', '`', '"', '\\'].includes(next) ? next : '\\' + next;
        continue;
      }
      word += char;
      continue;
    }
    if (!started) {
      // Descriptor duplication and discarding output touch no regular file.
      const redirect = input.slice(index).match(/^(?:[012])?(?:[<>]&[012]|>[ \t]*\/dev\/null)(?=$|[\s|;&])/);
      if (redirect) { index += redirect[0].length - 1; continue; }
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === '\\') {
      const next = input[++index];
      if (next === undefined) return undefined;
      if (next !== '\n') { word += next; started = true; }
      continue;
    }
    if (char === '#' && !started) {
      if (inputTarget) return undefined;
      while (index < input.length && input[index] !== '\n') index++;
      pushCommand(); continue;
    }
    if (char === '<') {
      // A single file input redirect only reads; heredocs/process substitutions
      // can execute code and are deliberately left to confirmation.
      if (input[index + 1] === '<' || input[index + 1] === '(') return undefined;
      pushWord();
      if (inputTarget) return undefined;
      inputTarget = true; continue;
    }
    if ('>$`(){}'.includes(char) || char === '\u0000') return undefined;
    if ('*?['.includes(char)) glob = true;
    if (char === '&') {
      if (inputTarget && !started) return undefined;
      if (input[index + 1] !== '&') return undefined;
      index++; pushCommand(); continue;
    }
    if (char === '|' || char === ';' || char === '\n') {
      if (inputTarget && !started) return undefined;
      pushCommand(); continue;
    }
    if (/\s/.test(char)) { pushWord(); continue; }
    word += char; started = true;
  }
  if (quote) return undefined;
  pushCommand();
  if (inputTarget) return undefined;
  return commands;
}

const readers = new Set(['read', 'cat', 'ls', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'fd',
  'head', 'tail', 'wc', 'stat', 'pwd', 'basename', 'dirname', 'realpath', 'which',
  'diff', 'cmp', 'comm', 'du', 'df', 'md5sum', 'sha1sum', 'sha256sum', 'cksum',
  'whoami', 'id', 'uname', 'uptime', 'ps', 'printenv', 'echo', 'cd', 'sort']);

export function isKnownReadCommand(name: string): boolean {
  return readers.has(name) || name === 'git' || name === 'curl';
}

export function isReadOnlyWords(words: readonly string[]): boolean {
  const [name, ...args] = words;
  if (!name) return false;
  if (name === 'curl') return ['-q', '--disable'].includes(args[0] ?? '')
    && args.includes('--noproxy') && isLocalReadCurl(args);
  if (name === 'git') {
    return ['status', 'diff', 'log', 'show', 'blame', 'ls-files'].includes(args[0] ?? '')
      && !optionWords(args).some(arg => dangerousLongOption(arg, ['--output', '--ext-diff', '--textconv']));
  }
  if (!readers.has(name)) return false;
  if (name === 'find' && args.some(arg => /^-(?:delete|exec|ok|fprint|fprintf|fls)/.test(arg))) return false;
  const options = optionWords(args);
  if (name === 'fd' && options.some(arg => /^--exec/.test(arg) || /^-[^-]*[xX]/.test(arg))) return false;
  if (name === 'rg' && options.some(arg => /^--pre/.test(arg))) return false;
  if (name === 'sort' && options.some(arg => dangerousLongOption(arg, ['--output', '--compress-program']) || /^-[^-]*o/.test(arg))) return false;
  if (name === 'diff' && options.some(arg => /^--out/.test(arg))) return false;
  return true;
}

function optionWords(args: readonly string[]): readonly string[] {
  const end = args.indexOf('--');
  return end < 0 ? args : args.slice(0, end);
}

/** GNU tools accept abbreviated long options; harmless complete names stay usable. */
function dangerousLongOption(arg: string, names: readonly string[]): boolean {
  const option = arg.split('=', 1)[0]!;
  return option.startsWith('--') && names.some(name => name.startsWith(option) || option.startsWith(name));
}

function isReadOnlyShellWords(words: ShellWord[]): boolean {
  const [head, ...args] = words;
  if (!head || head.glob || !isReadOnlyWords(words.map(word => word.text))) return false;
  // Expansion must not introduce write/exec options. A fixed path prefix or
  // an explicit end-of-options marker keeps glob results in operand position.
  if (['find', 'fd', 'rg', 'sort', 'diff', 'git', 'curl'].includes(head.text)) {
    let operandsOnly = false;
    for (const arg of args) {
      if (!arg.glob && arg.text === '--') operandsOnly = true;
      if (!arg.glob) continue;
      const prefix = arg.text.split(/[*?[]/, 1)[0] ?? '';
      const fixedPath = prefix.includes('/') && !prefix.startsWith('-');
      // find expressions remain active after its paths, even with --.
      if (!fixedPath && (!operandsOnly || head.text === 'find')) return false;
    }
  }
  return true;
}

export function isReadOnlyCommand(command: string): boolean {
  const commands = shellCommands(command);
  return commands !== undefined && commands.every(isReadOnlyShellWords);
}

/** Only syntax whose effects can be decided by the individual command gates. */
export function inspectionCommands(command: string): string[] | undefined {
  const commands = shellCommands(command);
  if (commands === undefined || !commands.every(words => {
    const head = words[0];
    return head !== undefined && !head.glob && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(head.text)
      && words.every(word => !word.glob || !/[\s'"$`\\<>|&;(){}]/.test(word.text));
  })) return undefined;
  // Redirection filenames are not argv. Keep quoting and expansion roles when
  // asking the policy about the actual command, independently of upstream AST.
  return commands.map(words => words.map(word => word.glob || /^[\w./:@%+=,-]+$/.test(word.text)
    ? word.text : `'${word.text.replaceAll("'", "'\\''")}'`).join(' '));
}

/** Expand accepted shell globs for path checks without executing the command. */
export function shellGlobTokens(command: string): string[] {
  return (shellCommands(command) ?? []).flatMap(words => words.filter(word => word.glob).map(word => word.text));
}

export function expandShellGlob(pattern: string, cwd: string): string[] {
  return globSync(pattern, { cwd }).map(path => resolve(cwd, path));
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
  // Normalization must not erase the caller's redirect semantics.
  if (/[<>]/.test(command)) return undefined;
  const commands = shellCommands(command);
  if (commands?.length !== 1 || commands[0]?.[0]?.text !== 'curl' || !isLocalReadCurl(commands[0].slice(1).map(word => word.text))) return undefined;
  const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
  return commands.map(words => {
    const args = ['curl', '-q', '--noproxy', '*', ...words.slice(1).map(word => word.text)];
    return args.map(quote).join(' ');
  }).join('');
}
