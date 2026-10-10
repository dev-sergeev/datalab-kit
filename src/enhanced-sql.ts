import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClassificationContext, DangerousAnalysis } from './enhanced-types.js';

type Token = { kind: 'word' | 'identifier' | 'string' | 'symbol' | 'meta'; value: string; raw?: string; start?: number; end?: number };
const mutations: Record<string, true> = {
  INSERT: true, UPDATE: true, DELETE: true, DROP: true, TRUNCATE: true, ALTER: true,
  CREATE: true, REPLACE: true, MERGE: true, UPSERT: true, GRANT: true, REVOKE: true,
  COPY: true, LOAD: true, IMPORT: true, EXPORT: true, VACUUM: true, ANALYZE: true,
  ANALYSE: true, REFRESH: true, REINDEX: true, CLUSTER: true, COMMENT: true,
  SECURITY: true, CALL: true, EXECUTE: true, EXEC: true, DO: true, SET: true,
  RESET: true, USE: true, CACHE: true, UNCACHE: true, ADD: true, COMPILE: true,
  TRANSFORM: true, MAP: true, REDUCE: true, INTO: true, LOCK: true, UNLOCK: true,
  NOTIFY: true, LISTEN: true, UNLISTEN: true, DISCARD: true, PREPARE: true,
  DEALLOCATE: true, START: true, BEGIN: true, COMMIT: true, END: true,
  ROLLBACK: true, SAVEPOINT: true, RELEASE: true, ATTACH: true, DETACH: true,
  REPAIR: true, MSCK: true, OPTIMIZE: true, REBALANCE: true,
};
const readHeads: Record<string, true> = { SELECT: true, SHOW: true, DESCRIBE: true, DESC: true, VALUES: true, TABLE: true };
const safeFunctions: Record<string, true> = {
  COUNT: true, SUM: true, AVG: true, MIN: true, MAX: true, ABS: true, LOWER: true,
  UPPER: true, LENGTH: true, CHAR_LENGTH: true, OCTET_LENGTH: true, COALESCE: true,
  NULLIF: true, GREATEST: true, LEAST: true, ROUND: true, FLOOR: true, CEIL: true,
  CEILING: true, CONCAT: true, CONCAT_WS: true, SUBSTRING: true, SUBSTR: true,
  TRIM: true, LTRIM: true, RTRIM: true, REPLACE: true, POSITION: true,
  EXTRACT: true, DATE_PART: true, TO_CHAR: true, CAST: true,
};
const expressionGroups: Record<string, true> = {
  AS: true, IN: true, EXISTS: true, OVER: true, FILTER: true, SELECT: true,
  VALUES: true, DISTINCT: true, NOT: true, AND: true, OR: true, WHEN: true,
  THEN: true, ELSE: true, CASE: true,
};

/** Lex the complete script; quoted words cannot accidentally become SQL verbs. */
function tokenize(sql: string, cliLineSplitting = false): Token[] | undefined {
  const tokens: Token[] = [];
  for (let i = 0; i < sql.length;) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) return undefined;
      if (cliLineSplitting && /;[ \t]*\r?\n/.test(sql.slice(start, i))) return undefined;
      continue;
    }
    if (ch === '\\' || (ch === '!' && (tokens.length === 0 || tokens.at(-1)?.value === ';'))) {
      const start = i++;
      let quote = '';
      const shell = sql.startsWith('\\!', start);
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') {
        const next = sql[i]!;
        if (quote) {
          if (next === quote) quote = '';
          else if (next === '\\' && quote !== '`') i++;
        } else if (next === "'" || next === '"' || next === '`') quote = next;
        else if ((!shell && next === '\\') || (ch === '!' && next === ';')) break;
        i++;
      }
      if (quote) return undefined;
      tokens.push({ kind: 'meta', value: sql.slice(start, i).trim() });
      continue;
    }
    if (ch === '$') {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, i + delimiter.length);
        if (end < 0) return undefined;
        tokens.push({ kind: 'string', value: sql.slice(i + delimiter.length, end), start: i, end: end + delimiter.length });
        i = end + delimiter.length;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      const quote = ch;
      const kind = quote === "'" ? 'string' : 'identifier';
      let value = '';
      let closed = false;
      i++;
      while (i < sql.length) {
        const next = sql[i++]!;
        if (next === quote) {
          if (sql[i] === quote) { value += quote; i++; }
          else { closed = true; break; }
        } else if (next === '\\') {
          // Escape behavior differs by dialect/settings: ambiguity is protected.
          return undefined;
        } else value += next;
      }
      if (!closed) return undefined;
      if (cliLineSplitting && /;[ \t]*\r?\n/.test(sql.slice(start, i))) return undefined;
      tokens.push({ kind, value, start, end: i });
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(sql.slice(i))?.[0];
    if (word) { tokens.push({ kind: 'word', value: word.toUpperCase(), raw: word, start: i, end: i + word.length }); i += word.length; }
    else { tokens.push({ kind: 'symbol', value: ch, start: i, end: i + 1 }); i++; }
  }
  return tokens;
}

function isReadStatement(tokens: readonly Token[]): boolean {
  const head = tokens[0];
  if (!head || head.kind !== 'word') return false;
  if (!readHeads[head.value] && head.value !== 'WITH' && head.value !== 'EXPLAIN') return false;
  let depth = 0;
  let hasReadBody = !!readHeads[head.value];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.value === '(' && token.kind === 'symbol') depth++;
    if (token.value === ')' && token.kind === 'symbol' && --depth < 0) return false;
    if (token.kind === 'word') {
      if (mutations[token.value] && !(safeFunctions[token.value] && tokens[i + 1]?.value === '(')) return false;
      if (depth === 0 && i > 0 && readHeads[token.value]) hasReadBody = true;
      if (token.value === 'FOR') return false;
    }
    if ((token.kind === 'word' || token.kind === 'identifier') && tokens[i + 1]?.value === '(') {
      let cteDeclaration = false;
      if (head.value === 'WITH' && !hasReadBody && depth === 0) {
        let nesting = 0;
        for (let cursor = i + 1; cursor < tokens.length; cursor++) {
          const group = tokens[cursor]!;
          if (group.kind !== 'symbol') continue;
          if (group.value === '(') nesting++;
          else if (group.value === ')' && --nesting === 0) {
            cteDeclaration = tokens[cursor + 1]?.kind === 'word' && tokens[cursor + 1]?.value === 'AS';
            break;
          }
        }
      }
      if (!cteDeclaration) {
        if (token.kind !== 'word' || tokens[i - 1]?.value === '.') return false;
        if (!safeFunctions[token.value] && !expressionGroups[token.value]) return false;
      }
    }
    if (token.kind === 'symbol' && ['\\', ':', '$', '!'].includes(token.value)) {
      if (token.value === ':' && (tokens[i - 1]?.value === ':' || tokens[i + 1]?.value === ':')) continue;
      if (token.value === '!' && tokens[i + 1]?.value === '=') continue;
      return false;
    }
  }
  return depth === 0 && hasReadBody;
}

type OptionEffect = 'sql' | 'file' | 'init' | 'write' | 'read' | 'connection' | 'unknown' | 'format';
const psqlOptions: Record<string, OptionEffect> = {
  c: 'sql', command: 'sql', f: 'file', file: 'file', o: 'write', output: 'write',
  L: 'write', 'log-file': 'write', d: 'connection', dbname: 'connection',
  h: 'connection', host: 'connection', p: 'connection', port: 'connection',
  U: 'connection', username: 'connection', v: 'unknown', set: 'unknown', variable: 'unknown',
  F: 'format', 'field-separator': 'format', R: 'format', 'record-separator': 'format',
  P: 'unknown', pset: 'unknown', T: 'format', 'table-attr': 'format',
};
const hiveOptions: Record<string, OptionEffect> = {
  e: 'sql', f: 'file', file: 'file', i: 'init', init: 'init',
  h: 'connection', p: 'connection', database: 'connection',
  d: 'unknown', define: 'unknown', hiveconf: 'unknown', hivevar: 'unknown',
};
const beelineOptions: Record<string, OptionEffect> = {
  e: 'sql', f: 'file', file: 'file', i: 'init', init: 'init', u: 'connection',
  n: 'connection', p: 'connection', a: 'connection', authType: 'connection',
  w: 'read', 'password-file': 'read', 'property-file': 'unknown',
  d: 'unknown', hiveconf: 'unknown', hivevar: 'unknown', delimiter: 'unknown',
  autosave: 'unknown', autoCommit: 'unknown', isolation: 'unknown',
  color: 'format', showHeader: 'format', headerInterval: 'format', fastConnect: 'format',
  verbose: 'format', showWarnings: 'format', showDbInPrompt: 'format', showNestedErrs: 'format',
  numberFormat: 'format', force: 'format', maxWidth: 'format', maxColumnWidth: 'format',
  silent: 'format', outputformat: 'format', truncateTable: 'format', delimiterForDSV: 'format',
  nullemptystring: 'format', incremental: 'format', incrementalBufferRows: 'format',
  maxHistoryRows: 'format', convertBinaryArrayToString: 'format',
};
const psqlFlags: Record<string, true> = {
  a: true, A: true, b: true, e: true, E: true, H: true, n: true, q: true,
  t: true, w: true, W: true, x: true, X: true, z: true, '0': true,
  'echo-all': true, 'no-align': true, 'echo-errors': true, 'echo-queries': true,
  'echo-hidden': true, html: true, 'no-readline': true, quiet: true, 'tuples-only': true,
  'no-password': true, password: true, expanded: true, 'no-psqlrc': true,
  'field-separator-zero': true, 'record-separator-zero': true, csv: true,
};
const hiveFlags: Record<string, true> = { S: true, silent: true, v: true, verbose: true };
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_FILES = 32;
const MAX_DEPTH = 8;

/** Classify SQL client inputs without invoking a client or a database. */
export function classifySqlClient(argv: readonly string[], context: ClassificationContext): DangerousAnalysis {
  const client = basename(argv[0] ?? '');
  const analysis: DangerousAnalysis = { approval: 'ordinary', reasons: [], commands: [], paths: [] };
  if (!['psql', 'beeline', 'hive', 'spark-sql'].includes(client)) return analysis;
  const protect = (reason: string): void => {
    const message = `${client}: ${reason}`;
    if (!analysis.reasons.includes(message)) {
      analysis.reasons.push(message);
      analysis.approval = 'enhanced';
    }
  };
  const addPath = (path: string, effect: 'read' | 'write' | 'unknown'): void => {
    if (!analysis.paths.some(entry => entry.path === path && entry.effect === effect)) analysis.paths.push({ path, effect });
  };
  if (context.dynamic) protect('dynamic arguments or working directory');
  let totalBytes = 0;
  let files = 0;
  const active = new Set<string>();
  const localPath = (input: string, base: string): string | undefined => {
    if (!input || /[\0\r\n$`]|^~/.test(input)) return undefined;
    if (input.startsWith('file:')) {
      try { return fileURLToPath(input); } catch { return undefined; }
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)) return undefined;
    return resolve(base, input);
  };
  let effectiveCwd = context.cwd;
  const commandIntent = (command: string): void => {
    const literal = command.trim();
    const intent = effectiveCwd === context.cwd ? literal : `cd '${effectiveCwd.replace(/'/g, "'\\''")}' && ${literal}`;
    if (literal && !analysis.commands.includes(intent)) analysis.commands.push(intent);
    protect('SQL client executes a shell or DFS command');
  };
  const outputIntent = (value: string): void => {
    protect('SQL client writes output');
    if (value.startsWith('|')) commandIntent(value.slice(1));
    else addPath(localPath(value, effectiveCwd) ?? value, 'write');
  };
  const inspectScript = (sql: string, base: string, depth: number): void => {
    if (depth > MAX_DEPTH) { protect('SQL include limit exceeded'); return; }
    const bytes = Buffer.byteLength(sql);
    if (bytes > MAX_INPUT_BYTES - totalBytes) { protect('SQL input size limit exceeded'); return; }
    totalBytes += bytes;
    if (client !== 'psql' && /\$\{/.test(sql)) protect('unresolved Hive variable substitution');
    const tokens = tokenize(sql, client === 'hive' || client === 'spark-sql');
    if (!tokens) { protect('SQL syntax or escaping is unresolved'); return; }
    const literalArgument = (text: string): string | undefined => {
      const parsed = tokenize(text);
      if (!parsed || parsed.length !== 1) return undefined;
      const token = parsed[0]!;
      if (token.kind === 'string' || token.kind === 'identifier') return token.value;
      if (token.kind === 'word') return token.raw;
      return undefined;
    };
    const include = (text: string, relative: boolean): void => {
      // Bare paths include punctuation, unlike SQL identifiers.
      const path = /^[^\s'\"`$]+$/.test(text) && !text.startsWith(':') ? text : literalArgument(text);
      if (path === undefined) { protect('SQL include path is unresolved'); return; }
      inspectFile(path, relative ? base : effectiveCwd, depth + 1);
    };
    const meta = (text: string): void => {
      const match = /^([\\!])([A-Za-z+]+|!|)(?:\s*([\s\S]*))?$/.exec(text);
      if (!match) { protect('SQL meta command is unresolved'); return; }
      const prefix = match[1]!;
      const name = match[2]!;
      const args = match[3]?.trim() ?? '';
      if (prefix === '\\' && client !== 'psql') { protect('unexpected SQL escape'); return; }
      if (prefix === '\\' && name === '!') { commandIntent(args); return; }
      for (const shell of args.matchAll(/`([^`]*)`/g)) commandIntent(shell[1]!);
      if (/:[A-Za-z_'\"{]/.test(args)) protect('unresolved psql interpolation');
      if (prefix === '\\') {
        if (name === 'i' || name === 'include' || name === 'ir' || name === 'include_relative') {
          include(args, name === 'ir' || name === 'include_relative');
        } else if (name === 'cd') {
          const argument = args ? literalArgument(args) ?? args : context.env?.HOME;
          const path = argument === undefined ? undefined : localPath(argument, effectiveCwd);
          if (!path) protect('unresolved psql working directory');
          else {
            try {
              if (statSync(path).isDirectory()) effectiveCwd = path;
              else protect('psql working directory is not a directory');
            } catch { protect('psql working directory is unreadable'); }
          }
        } else if (name === 'o' || name === 'out' || name === 'w' || name === 'write' || name === 'g' || name === 'gx') {
          if (args) outputIntent(literalArgument(args) ?? args);
        } else if (name === 'copy') {
          protect('psql copy effect');
          const copy = tokenize(args);
          if (copy) recordSqlPaths(copy);
        } else if (name === 'gexec') protect('psql executes generated SQL');
        else if (!/^(?:q|quit|echo|warn|p|print|r|reset|x|conninfo|gdesc|d[a-zA-Z]*\+?)$/.test(name)) {
          protect(`unresolved psql meta command ${name}`);
        }
        return;
      }
      if (name === 'run' || name === 'source') {
        protect('SQL client executes an included script');
        include(args.replace(/^FILE\s+/i, ''), false);
        if (client !== 'beeline') commandIntent(`${name} ${args}`);
        return;
      }
      if (name === 'sh' || name === 'shell') { commandIntent(args); return; }
      if (client === 'beeline') {
        if (name === 'sql' || name === 'all') inspectScript(args, base, depth + 1);
        else if (name !== 'quit' && name !== 'exit') protect(`unresolved Beeline command ${name}`);
      } else commandIntent(`${name}${args ? ` ${args}` : ''}`);
    };
    const recordSqlPaths = (statement: readonly Token[]): void => {
      for (let index = 0; index < statement.length; index++) {
        const token = statement[index]!;
        if (token.kind !== 'word') continue;
        if (token.value === 'PROGRAM' && statement[index + 1]?.kind === 'string') {
          commandIntent(statement[index + 1]!.value);
        }
        const next = statement[index + 1];
        if (next?.kind === 'string' && ['TO', 'FROM', 'DIRECTORY', 'INPATH', 'LOCATION'].includes(token.value)) {
          const effect = token.value === 'FROM' || token.value === 'INPATH' ? 'read' : 'write';
          addPath(localPath(next.value, effectiveCwd) ?? next.value, effect);
        }
        if (token.value === 'USING' && next?.kind === 'string' && statement.some(item => item.kind === 'word' && ['TRANSFORM', 'MAP', 'REDUCE'].includes(item.value))) {
          commandIntent(next.value);
        }
      }
    };
    let start = 0;
    const statement = (end: number): void => {
      if (end <= start) return;
      const part = tokens.slice(start, end);
      const head = part[0]!;
      if (head.kind === 'word' && head.value === 'SOURCE') {
        protect('SQL client executes an included script');
        include(sql.slice(head.end, part.at(-1)?.end).trim().replace(/^FILE\s+/i, ''), false);
      } else if (head.kind === 'word' && head.value === 'DFS') {
        commandIntent(`hdfs dfs ${sql.slice(head.end, part.at(-1)?.end).trim()}`);
      } else {
        recordSqlPaths(part);
        if (!isReadStatement(part)) protect('SQL effect is not established as read-only');
      }
    };
    for (let index = 0; index <= tokens.length; index++) {
      const token = tokens[index];
      if (index !== tokens.length && token?.kind !== 'meta' && !(token?.kind === 'symbol' && token.value === ';')) continue;
      statement(index);
      if (token?.kind === 'meta') meta(token.value);
      start = index + 1;
    }
  };
  const inspectFile = (input: string, base: string, depth: number): void => {
    const path = localPath(input, base);
    addPath(path ?? input, 'read');
    if (!path) { protect('SQL input path is remote or unresolved'); return; }
    if (depth > MAX_DEPTH || ++files > MAX_FILES) { protect('SQL include limit exceeded'); return; }
    try {
      const canonical = realpathSync(path);
      addPath(canonical, 'read');
      if (active.has(canonical)) { protect('SQL include cycle'); return; }
      const info = statSync(canonical);
      if (!info.isFile() || info.size > MAX_INPUT_BYTES - totalBytes) { protect('SQL input is not a bounded regular file'); return; }
      active.add(canonical);
      try { inspectScript(readFileSync(canonical, 'utf8'), dirname(path), depth); }
      finally { active.delete(canonical); }
    } catch { protect('SQL input file is unreadable'); }
  };
  const inspectStdin = (): void => {
    if (context.stdin?.kind === 'text') inspectScript(context.stdin.value, effectiveCwd, 0);
    else if (context.stdin?.kind === 'file') inspectFile(context.stdin.value, effectiveCwd, 0);
    else protect('SQL standard input is unresolved');
  };
  let hasInput = false;
  let noPsqlrc = false;
  let hasUrl = false;
  const options = client === 'psql' ? psqlOptions : client === 'beeline' ? beelineOptions : hiveOptions;
  const flags: Record<string, true> = client === 'psql' ? psqlFlags : client === 'beeline' ? {} : hiveFlags;
  const apply = (name: string, value: string | undefined): void => {
    const effect = Object.hasOwn(options, name) ? options[name] : undefined;
    if (value === undefined) { protect(`missing value for option ${name}`); return; }
    if (effect === 'sql') { hasInput = true; inspectScript(value, effectiveCwd, 0); }
    else if (effect === 'file') {
      hasInput = true;
      if (client === 'psql' && value === '-') inspectStdin();
      else inspectFile(value, effectiveCwd, 0);
    } else if (effect === 'init') {
      for (const file of client === 'beeline' ? value.split(',') : [value]) inspectFile(file, effectiveCwd, 0);
    } else if (effect === 'write') {
      protect('client writes output to a file or command');
      if ((name === 'o' || name === 'output') && value.startsWith('|')) commandIntent(value.slice(1));
      else addPath(localPath(value, effectiveCwd) ?? value, 'write');
    } else if (effect === 'read') {
      addPath(localPath(value, effectiveCwd) ?? value, 'read');
    } else if (effect === 'unknown') {
      protect(`unresolved option ${name}`);
      if (name === 'property-file') addPath(localPath(value, effectiveCwd) ?? value, 'read');
    } else if (client === 'beeline' && name === 'u') {
      hasUrl = true;
      // Connection preferences can load scripts or alter parsing; inspect known initFile.
      if (!value.startsWith('jdbc:hive2://') || /[;?#[\]{}$`]/.test(value)) protect('unresolved JDBC connection preferences');
      for (const match of value.matchAll(/(?:[;?&#])initFile=([^;?&#]*)/gi)) {
        try { inspectFile(decodeURIComponent(match[1]!), effectiveCwd, 0); }
        catch { protect('unresolved JDBC initFile'); }
      }
    }
  };
  const pending: Array<{ name: string; value: string | undefined }> = [];
  let positional = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') { positional = true; continue; }
    if (positional || !arg.startsWith('-') || arg === '-') {
      if (client !== 'psql') protect('unresolved positional client argument');
      continue;
    }
    if (arg.startsWith('--') || arg.startsWith('-hiveconf') || arg.startsWith('-hivevar')) {
      const stripped = arg.replace(/^-{1,2}/, '');
      const equal = stripped.indexOf('=');
      const name = equal < 0 ? stripped : stripped.slice(0, equal);
      if (flags[name] === true && equal < 0) {
        if (name === 'no-psqlrc') noPsqlrc = true;
      } else if (Object.hasOwn(options, name)) {
        pending.push({ name, value: equal < 0 ? argv[++i] : stripped.slice(equal + 1) });
        if (client === 'beeline' && options[name] === 'init') {
          while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) pending.push({ name, value: argv[++i] });
        }
      } else protect(`unresolved option ${name}`);
      continue;
    }
    for (let offset = 1; offset < arg.length; offset++) {
      const name = arg[offset]!;
      if (flags[name] === true) { if (name === 'X') noPsqlrc = true; continue; }
      if (Object.hasOwn(options, name)) {
        const value = offset + 1 < arg.length ? arg.slice(offset + 1) : argv[++i];
        pending.push({ name, value });
        if (client === 'beeline' && options[name] === 'init') {
          while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) pending.push({ name, value: argv[++i] });
        }
        break;
      }
      protect(`unresolved option ${name}`);
    }
  }
  const hasInit = pending.some(option => options[option.name] === 'init' && option.value !== undefined);
  if (client === 'psql' && !noPsqlrc) {
    protect('psql startup files are unresolved (missing -X)');
    const rc = context.env?.PSQLRC ?? (context.env?.HOME ? resolve(context.env.HOME, '.psqlrc') : undefined);
    if (rc) inspectFile(rc, effectiveCwd, 0);
  }
  if ((client === 'hive' || client === 'spark-sql') && !hasInit) {
    protect('implicit .hiverc startup files are unresolved');
    if (context.env?.HIVE_HOME) inspectFile(resolve(context.env.HIVE_HOME, 'bin/.hiverc'), effectiveCwd, 0);
    if (context.env?.HOME) inspectFile(resolve(context.env.HOME, '.hiverc'), effectiveCwd, 0);
  }
  // Client startup/init files execute before query inputs, even when -i follows -e.
  for (const option of pending) {
    if (options[option.name] !== 'sql' && options[option.name] !== 'file' && options[option.name] !== 'init') apply(option.name, option.value);
  }
  for (const option of pending) if (options[option.name] === 'init') apply(option.name, option.value);
  for (const option of pending) if (options[option.name] === 'sql' || options[option.name] === 'file') apply(option.name, option.value);
  if (client === 'beeline' && !hasUrl) protect('Beeline saved connection preferences are unresolved');
  if (!hasInput) inspectStdin();
  return analysis;
}
