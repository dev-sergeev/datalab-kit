import { globSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { getEnhancedParser } from './enhanced-parser.js';
import type { BashReparser, BashSyntaxNode, BashSyntaxTree } from './enhanced-parser.js';
import type { ClassificationContext, DangerousAnalysis } from './enhanced-types.js';
import { classifySqlClient } from './enhanced-sql.js';

const ANSI_C_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"' };
const DEFERRED_REDIRECT_BODIES: Record<string, true> = { command: true, list: true, pipeline: true, negated_command: true };
// Match the native wrapper roster; values must never become executable heads.
const WRAPPER_OPTIONS: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--chdir'],
  doas: ['-u', '-C'], env: ['-u', '--unset', '-C', '--chdir'],
  command: [], builtin: [], exec: ['-a'], nohup: [], setsid: [],
  nice: ['-n', '--adjustment'], timeout: ['-s', '--signal', '-k', '--kill-after'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  time: ['-o', '--output', '-f', '--format'], watch: ['-n', '--interval', '-q', '--equexit'],
  flock: ['-w', '-E', '--timeout', '--conflict-exit-code'],
  xargs: ['-a', '-E', '-I', '-i', '-L', '-l', '-n', '-P', '-s', '-d', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace', '--max-lines', '--max-chars', '--eof'],
  parallel: ['-j', '--jobs', '-a', '--arg-file', '-S', '--sshlogin', '-L', '--max-lines', '-N', '--max-args', '-n', '-P', '--max-procs', '--retries', '--timeout', '--colsep', '--wd', '--workdir', '--tmpdir', '--results', '--joblog', '-I', '--replace', '--tagstring', '--rpl', '--env'],
  'rust-parallel': ['-j', '--jobs'], rush: ['-j', '--jobs', '-n', '--nrecords', '-i', '--infile', '-o', '--out-file'],
};
const SHELL_TEMPLATE_WRAPPERS: Record<string, true> = { watch: true, parallel: true, 'rust-parallel': true, rush: true };
const FD_VALUE_OPTIONS: Record<string, true> = { '-e': true, '--extension': true, '-t': true, '--type': true, '-E': true, '--exclude': true, '-d': true, '--max-depth': true, '--min-depth': true, '--max-results': true, '--base-directory': true, '--search-path': true, '-j': true, '--threads': true, '--color': true, '--ignore-file': true };
const EXEC_FLAGS: Record<string, true> = { '-exec': true, '-execdir': true, '-ok': true, '-okdir': true, '-x': true, '--exec': true, '-X': true, '--exec-batch': true };

function staticWord(node: BashSyntaxNode, allowPatterns = false, depth = 0): string | undefined {
  // An undecodable operand remains dynamic; recognised protected tools still require approval.
  if (depth > 128 || node.text.length > 1_048_576) return undefined;
  if (node.type === 'command_name') {
    const child = node.namedChildren[0];
    return child ? staticWord(child, allowPatterns, depth + 1) : undefined;
  }
  if (node.type === 'raw_string') return node.text.slice(1, -1);
  if (node.type === 'ansi_c_string') {
    const value = node.text.slice(2, -1).replace(/\\(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|c.|[\s\S])/g, escape => {
      const code = escape.slice(1);
      if (code === '\n') return '';
      if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8) & 255);
      if (/^[xuU]/.test(code)) {
        const point = parseInt(code.slice(1), 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : '\0';
      }
      if (code.startsWith('c') && code.length === 2) return String.fromCharCode(code.charCodeAt(1) & 31);
      return ANSI_C_ESCAPES[code] ?? escape;
    });
    return value.split('\0', 1)[0];
  }
  if (node.type === 'string') {
    if (node.namedChildren.some(child => child.type !== 'string_content')) return undefined;
    return node.text.slice(1, -1).replace(/\\([$`"\\\n])/g, (_escape, char: string) => char === '\n' ? '' : char);
  }
  if (node.type === 'concatenation') {
    const parts = node.namedChildren.map(child => staticWord(child, allowPatterns, depth + 1));
    return parts.every(part => part !== undefined) ? parts.join('') : undefined;
  }
  if (node.type === 'word') {
    const syntax = node.text.replace(/\\[\s\S]/g, '');
    if (/[\$`{}~]/.test(syntax) || (!allowPatterns && /[*?\[\]]/.test(syntax))) return undefined;
    return node.text.replace(/\\([\s\S])/g, (_escape, char: string) => char === '\n' ? '' : char);
  }
  return undefined;
}

interface VisitFrame {
  node: BashSyntaxNode;
  context: ClassificationContext;
  functions: Map<string, BashSyntaxNode>;
  activeFunctions: ReadonlySet<BashSyntaxNode>;
  uncertainCwd?: boolean;
  cwdContext?: ClassificationContext;
  unknownEnv?: ReadonlySet<string>;
  inputRedirects?: readonly BashSyntaxNode[];
  background?: boolean;
}

interface PendingInvocation {
  argv: readonly (string | undefined)[];
  command: string;
  frame: VisitFrame;
  patterns: ReadonlySet<number>;
  pathArgv?: readonly (string | undefined)[];
}

function withInputRedirects(
  node: BashSyntaxNode, context: ClassificationContext, inherited?: readonly BashSyntaxNode[],
): ClassificationContext {
  const direct = node.childrenForFieldName('redirect');
  const redirects = inherited?.length ? [...inherited, ...direct].sort((a, b) => a.startIndex - b.startIndex) : direct;
  let stdin = context.stdin;
  for (const redirect of redirects) {
    const descriptor = redirect.childForFieldName('descriptor');
    if (descriptor && descriptor.text !== '0') continue;
    if (redirect.type === 'heredoc_redirect') {
      const body = redirect.namedChildren.find(child => child.type === 'heredoc_body');
      const dynamic = body?.namedChildren.some(child => ['expansion', 'simple_expansion', 'command_substitution'].includes(child.type));
      stdin = body && !dynamic ? { kind: 'text', value: redirect.text.includes('<<-') ? body.text.replace(/^\t+/gm, '') : body.text } : { kind: 'unknown' };
    } else if (redirect.type === 'herestring_redirect') {
      const valueNode = redirect.namedChildren.find(child => child.type !== 'file_descriptor');
      const value = valueNode && staticWord(valueNode);
      stdin = value !== undefined && value !== null ? { kind: 'text', value: `${value}\n` } : { kind: 'unknown' };
    } else if (redirect.type === 'file_redirect') {
      const operator = redirect.children.find(child => ['<', '<&', '<&-'].includes(child.text))?.text;
      if (!operator) continue;
      const destination = redirect.childForFieldName('destination');
      const value = destination && staticWord(destination);
      stdin = operator === '<' && value !== undefined && value !== null && (!context.dynamic || isAbsolute(value))
        ? { kind: 'file', value: resolve(context.cwd, value) }
        : { kind: 'unknown' };
    }
  }
  return { ...context, stdin };
}

function hasUnquotedPattern(node: BashSyntaxNode): boolean {
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (['string', 'raw_string'].includes(current.type)) continue;
    if (current.type === 'word' && /(^|[^\\])[*?\[]/.test(current.text)) return true;
    for (const child of current.namedChildren) pending.push(child);
  }
  return false;
}

function policyCommand(command: string, effective: ClassificationContext, originalCwd: string): string {
  if (effective.dynamic || effective.cwd === originalCwd) return command;
  return `cd '${effective.cwd.replace(/'/g, "'\\''")}' && ${command}`;
}

function shortFlags(option: string, valueOptions: string): string {
  let flags = '';
  if (!option.startsWith('-') || option.startsWith('--')) return flags;
  for (const char of option.slice(1)) {
    flags += char;
    if (valueOptions.includes(char)) break;
  }
  return flags;
}

function renderArgv(argv: readonly (string | undefined)[]): string {
  // Evidence only, never execution: unresolved operands remain symbolic.
  return argv.map(value => value === undefined ? '"${__KIT_UNKNOWN_ARG}"'
    : /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`).join(' ');
}

export function classifyParsedBash(root: BashSyntaxNode, context: ClassificationContext, parser: BashReparser): DangerousAnalysis {
  const result: DangerousAnalysis = { approval: 'ordinary', reasons: [], commands: [], paths: [] };
  const nestedTrees: BashSyntaxTree[] = [];
  const pending: VisitFrame[] = [{ node: root, context: { ...context, env: context.env ?? process.env }, functions: new Map(), activeFunctions: new Set() }];
  const expandedSqlCommands = new Set<string>();
  const invocations: PendingInvocation[] = [];

  function recordPath(operand: string, effect: 'read' | 'write' | 'unknown', effective: ClassificationContext, pattern = false): void {
    if (effective.dynamic && !isAbsolute(operand)) return;
    if (pattern) {
      try {
        if (operand.length > 4096) {
          result.reasons.push('Protected command path expansion exceeds the static analysis limit');
          return;
        }
        const matches = globSync(operand, { cwd: effective.cwd });
        for (const match of matches) result.paths.push({ path: resolve(effective.cwd, match), effect });
        if (matches.length === 0) result.paths.push({ path: resolve(effective.cwd, operand), effect });
      } catch {
        result.reasons.push('Protected command path expansion is unresolved');
      }
    } else {
      result.paths.push({ path: resolve(effective.cwd, operand), effect });
    }
  }

  function enqueueSource(source: string, frame: VisitFrame): void {
    const tree = parser.parse(source);
    if (!tree) throw new Error('Bash parser could not parse a static executable payload');
    nestedTrees.push(tree);
    pending.push({ ...frame, node: tree.rootNode, inputRedirects: undefined, background: false });
    result.commands.push(policyCommand(source, frame.context, context.cwd));
  }

  function changeDirectory(args: readonly (string | undefined)[], patterns: ReadonlySet<number>, frame: VisitFrame, effective: ClassificationContext): void {
    const operands = args.filter(arg => arg === undefined || !arg.startsWith('-') || arg === '-');
    const directory = operands.length === 0 ? effective.env?.HOME : operands[0];
    const cwdContext = frame.cwdContext ?? frame.context;
    if (directory === undefined || directory === '-' || patterns.size > 0 || frame.uncertainCwd || (effective.env?.CDPATH && !isAbsolute(directory))) cwdContext.dynamic = true;
    else {
      const resolved = resolve(frame.context.cwd, directory);
      try {
        cwdContext.cwd = args.includes('-P') ? realpathSync(resolved) : resolved;
        if (isAbsolute(directory)) cwdContext.dynamic = false;
      } catch { cwdContext.dynamic = true; }
    }
    frame.context.cwd = cwdContext.cwd;
    frame.context.dynamic = cwdContext.dynamic;
  }

  function inspectInvocation(argv: readonly (string | undefined)[], command: string, frame: VisitFrame, patterns: ReadonlySet<number> = new Set(), pathArgv?: readonly (string | undefined)[]): void {
    const sourceContext = frame.context;
    const effective: ClassificationContext = { ...frame.context };
    let offset = 0;
    let suppressFunctionLookup = false;
    while (offset < argv.length) {
      const name = argv[offset];
      if (!name) return; // Dynamic executable heads are intentionally not a blanket barrier.
      const executable = basename(name);
      const args = argv.slice(offset + 1);
      const pathArgs = pathArgv?.slice(offset + 1) ?? args;
      const definition = suppressFunctionLookup ? undefined : frame.functions.get(name);
      suppressFunctionLookup = false;
      if (definition && !name.includes('/')) {
        if (!frame.activeFunctions.has(definition)) {
          const body = definition.childForFieldName('body');
          if (body) pending.push({ ...frame, node: body, context: withInputRedirects(definition, effective), activeFunctions: new Set([...frame.activeFunctions, definition]) });
        }
        return;
      }
      if (executable === 'cd') { changeDirectory(args, patterns, frame, effective); return; }
      let protectedSql = false;
      if (['psql', 'beeline', 'hive', 'spark-sql'].includes(executable)) {
        const sql = classifySqlClient((pathArgv ?? argv).slice(offset).map(arg => arg ?? ''), {
          ...effective,
          dynamic: effective.dynamic || args.some(arg => arg === undefined) || patterns.size > 0 || frame.node.hasError,
        });
        protectedSql = sql.approval === 'enhanced';
        result.reasons.push(...sql.reasons);
        result.commands.push(policyCommand(command, sourceContext, context.cwd), ...sql.commands.map(inner => policyCommand(inner, effective, context.cwd)));
        result.paths.push(...sql.paths);
        for (const inner of sql.commands) {
          const key = `${effective.cwd}\0${inner}`;
          if (inner === command || expandedSqlCommands.has(key)) continue;
          expandedSqlCommands.add(key);
          enqueueSource(inner, { ...frame, context: { ...effective }, cwdContext: undefined, functions: new Map(), activeFunctions: new Set() });
        }
      }
      let reason: string | undefined;
      const rsyncOperands: { value: string; index: number }[] = [];
      let removesSources = false;
      if (['rm', 'rmdir', 'unlink'].includes(executable)) reason = `${executable} can delete files or directories`;
      if (['hadoop', 'hdfs'].includes(executable)) reason = `${executable} requires explicit approval`;
      if (executable === 'find' || executable === 'fd') {
        if (executable === 'fd') effective.stdin = { kind: 'unknown' };
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          const attachedExec = executable === 'fd' ? /^(?:--exec(?:-batch)?=|-[xX])(.+)$/.exec(arg ?? '') : null;
          if (executable === 'fd' && arg === '--') break;
          if (executable === 'find' && arg === undefined) reason = 'find has unresolved operation arguments';
          if (executable === 'find' && arg === '-delete') reason = 'find -delete deletes files or directories';
          if (attachedExec || (arg && EXEC_FLAGS[arg] === true && (executable === 'fd' ? !arg.startsWith('-exec') && !arg.startsWith('-ok') : arg.startsWith('-exec') || arg.startsWith('-ok')))) {
            let end = i + 1;
            while (end < args.length && ![';', '+'].includes(args[end] ?? '')) end++;
            const innerPatterns = new Set([...patterns].filter(index => index > offset + 1 + i && index < offset + 1 + end).map(index => index - offset - i - 2 + (attachedExec ? 1 : 0)));
            const words = (attachedExec ? [attachedExec[1]!, ...args.slice(i + 1, end)] : args.slice(i + 1, end))
              .map(value => executable === 'fd' && value?.includes('{}') ? undefined : value);
            const innerPaths = pathArgv && (attachedExec ? [attachedExec[1]!, ...pathArgs.slice(i + 1, end)] : pathArgs.slice(i + 1, end))
              .map(value => executable === 'fd' && value?.includes('{}') ? undefined : value);
            if (executable === 'fd') effective.dynamic = true; // Job paths replace placeholders or are appended implicitly.
            invocations.push({ argv: words, pathArgv: innerPaths, command: renderArgv(words),
              frame: { ...frame, context: executable === 'fd' ? effective : { ...effective, dynamic: effective.dynamic || arg?.endsWith('dir') }, cwdContext: undefined, functions: new Map() }, patterns: innerPatterns });
            i = end;
          } else if (arg && executable === 'fd' && (FD_VALUE_OPTIONS[arg] === true || arg.startsWith('--base-directory='))) {
            if (arg === '--base-directory' || arg.startsWith('--base-directory=')) {
              const directory = arg.startsWith('--base-directory=') ? arg.slice(17) : args[i + 1];
              if (directory === undefined) effective.dynamic = true;
              else effective.cwd = resolve(effective.cwd, directory);
            }
            if (!arg.includes('=')) i++;
          } else if (arg && executable === 'find' && (['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname', '-type', '-xtype', '-perm', '-user', '-group', '-uid', '-gid', '-size', '-links', '-inum', '-samefile', '-newer', '-anewer', '-cnewer', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-mindepth', '-maxdepth', '-printf', '-fprintf', '-fprint', '-fprint0', '-fls', '-f'].includes(arg) || /^-newer[a-zA-Z]{2}$/.test(arg))) {
            i += arg === '-fprintf' ? 2 : 1;
          }
        }
      }
      if (executable === 'git') {
        let clean = 0;
        while (clean < args.length && args[clean]?.startsWith('-')) {
          const option = args[clean++]!;
          if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(option)) clean++;
        }
        if (args[clean] === 'clean') {
          const tail = args.slice(clean + 1);
          const options: (string | undefined)[] = [];
          for (let i = 0; i < tail.length && tail[i] !== '--'; i++) {
            const option = tail[i];
            options.push(option);
            if (option) {
              const flags = shortFlags(option, 'e');
              if ((flags.endsWith('e') && flags.length === option.length - 1) || (option.startsWith('--') && option.length > 3 && '--exclude'.startsWith(option))) i++;
            }
          }
          let dry = false;
          let uncertain = false;
          for (const option of options) {
            if (option === undefined) { uncertain = true; dry = false; continue; }
            for (const flag of shortFlags(option, 'e')) {
              if (flag === 'n') dry = true;
            }
            if (option.startsWith('--') && option.length > 3) {
              if ('--dry-run'.startsWith(option)) dry = true;
              if (option === '--no-dry-run') dry = false;
            }
          }
          // Repository/global/environment configuration can disable requireForce.
          if (!dry || uncertain) {
            reason = 'git clean can delete untracked files or directories';
          }
        }
      }
      if (executable === 'rsync') {
        const options: (string | undefined)[] = [];
        let afterOptions = false;
        for (let i = 0; i < args.length; i++) {
          const option = args[i];
          if (option === '--' && !afterOptions) { afterOptions = true; continue; }
          if (option !== undefined && (afterOptions || !option.startsWith('-'))) {
            rsyncOperands.push({ value: option, index: offset + 1 + i });
            continue;
          }
          options.push(option);
          if (option) {
            const flags = shortFlags(option, 'BefM');
            const shortValue = flags.length === option.length - 1 && 'BefM'.includes(flags.at(-1) ?? '\0');
            const longValue = option.startsWith('--') && !option.includes('=') && ['--block-size', '--rsh', '--filter', '--remote-option', '--chmod', '--include', '--exclude', '--include-from', '--exclude-from', '--files-from', '--bwlimit', '--log-file', '--log-file-format', '--out-format', '--partial-dir', '--temp-dir', '--backup-dir', '--suffix', '--rsync-path', '--iconv', '--address', '--port', '--sockopts', '--password-file', '--timeout', '--contimeout', '--max-delete', '--usermap', '--groupmap', '--chown'].some(known => known.startsWith(option));
            if (shortValue || longValue) i++;
          }
        }
        let dry = false;
        let deletion = false;
        let uncertain = false;
        for (const option of options) {
          if (option === undefined) { uncertain = true; deletion = true; dry = false; continue; }
          if (option === '--no-dry-run') dry = false;
          if ((option.startsWith('--') && option.length >= 5 && '--dry-run'.startsWith(option)) || shortFlags(option, 'BefM').includes('n')) dry = true;
          if (['--remove-source-files', '--remove-sent-files'].includes(option)) { removesSources = true; deletion = true; }
          if (option === '--del' || option.startsWith('--delete') || (option.startsWith('--') && '--delete'.startsWith(option) && option.length >= 5)) deletion = true;
        }
        if ((!dry || uncertain) && deletion) reason = 'rsync deletion options can delete source or destination files';
      }
      if (reason || protectedSql) {
        if (reason) result.reasons.push(reason);
        result.commands.push(policyCommand(command, sourceContext, context.cwd));
        // Strip needless quoting for raw command denies, without splitting operands.
        result.commands.push(policyCommand(renderArgv((pathArgv ?? argv).slice(offset)), effective, context.cwd));
        if (['rm', 'rmdir', 'unlink'].includes(executable)) {
          let afterOptions = false;
          for (let i = 0; i < args.length; i++) {
            const operand = pathArgs[i];
            if (operand === '--' && !afterOptions) { afterOptions = true; continue; }
            if (operand !== undefined && (afterOptions || !operand.startsWith('-'))) recordPath(operand, 'write', effective, patterns.has(offset + 1 + i));
          }
        } else if (executable === 'find') {
          let foundRoot = false;
          for (let i = 0; i < args.length; i++) {
            const operand = pathArgs[i];
            if (operand === '-H' || operand === '-L' || operand === '-P' || operand === '--') continue;
            if (operand === undefined || operand.startsWith('-') || ['!', '('].includes(operand)) break;
            foundRoot = true;
            recordPath(operand, 'write', effective, patterns.has(offset + 1 + i));
          }
          if (!foundRoot) recordPath('.', 'write', effective);
        } else if (executable === 'rsync') {
          const destination = rsyncOperands.at(-1);
          if (destination && !/^[^/]*:/.test(destination.value)) recordPath(destination.value, 'write', effective, patterns.has(destination.index));
          if (removesSources) {
            for (const source of rsyncOperands.slice(0, -1)) if (!/^[^/]*:/.test(source.value)) recordPath(source.value, 'write', effective, patterns.has(source.index));
          }
        } else if (executable === 'git') {
          const gitContext = { ...effective };
          let workTree: string | undefined;
          for (let i = 0; i < args.length && args[i] !== 'clean'; i++) {
            const option = args[i];
            if (option === '-C') {
              const directory = pathArgs[++i];
              if (directory !== undefined) {
                const path = resolve(gitContext.cwd, directory);
                try { gitContext.cwd = realpathSync(path); }
                catch { gitContext.cwd = path; }
                if (isAbsolute(directory)) gitContext.dynamic = false;
              } else gitContext.dynamic = true;
            } else if (option === '--work-tree' || option?.startsWith('--work-tree=')) {
              workTree = option === '--work-tree' ? pathArgs[++i] : option.slice(12);
              if (workTree === undefined) gitContext.dynamic = true;
            } else if (option && ['-c', '--git-dir', '--namespace', '--config-env'].includes(option)) i++;
          }
          if (workTree !== undefined) {
            gitContext.cwd = resolve(gitContext.cwd, workTree);
            if (isAbsolute(workTree)) gitContext.dynamic = false;
          }
          recordPath('.', 'write', gitContext);
        }
      }
      if (['sh', 'bash', 'dash', 'zsh', 'ksh'].includes(executable) || executable === 'eval') {
        const index = executable === 'eval' ? -1 : args.findIndex(arg => arg === '--command' || (!!arg && /^-[^-]*c/.test(arg)));
        const payload = executable === 'eval' ? (args.every(arg => arg !== undefined) ? args.join(' ') : undefined) : index >= 0 ? args[index + 1] : undefined;
        if (payload !== undefined) {
          enqueueSource(payload, {
            ...frame,
            context: executable === 'eval' ? frame.context : { ...effective },
            functions: executable === 'eval' ? frame.functions : new Map(),
            activeFunctions: executable === 'eval' ? frame.activeFunctions : new Set(),
            cwdContext: executable === 'eval' ? frame.cwdContext ?? frame.context : undefined,
            uncertainCwd: executable === 'eval' ? frame.uncertainCwd : undefined,
          });
        }
        if (payload === undefined && executable === 'eval') {
          (frame.cwdContext ?? frame.context).dynamic = true;
          frame.context.dynamic = true;
        }
        return;
      }
      const wrapperOptions = Object.hasOwn(WRAPPER_OPTIONS, executable) ? WRAPPER_OPTIONS[executable] : undefined;
      if (!wrapperOptions) return;
      let next = offset + 1;
      let watchExec = false;
      while (next < argv.length) {
        const arg = argv[next];
        if (arg === undefined) return;
        if (arg === '--') { next++; break; }
        if (executable === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          const equal = arg.indexOf('=');
          effective.env = { ...effective.env, [arg.slice(0, equal)]: frame.unknownEnv?.has(arg.slice(0, equal)) ? undefined : arg.slice(equal + 1) };
          next++;
          continue;
        }
        if (executable === 'env' && arg === '-') { effective.env = {}; next++; continue; }
        if (!arg.startsWith('-')) break;
        if (executable === 'command' && /^-[^-]*[vV]/.test(arg)) return;
        if (executable === 'sudo' && ['-l', '--list', '-v', '--validate'].includes(arg)) return;
        if (executable === 'flock' && (arg === '-c' || arg === '--command' || arg.startsWith('--command='))) {
          const payload = arg.startsWith('--command=') ? arg.slice(10) : argv[next + 1];
          if (payload !== undefined) enqueueSource(payload, { ...frame, context: { ...effective, stdin: { kind: 'unknown' } }, cwdContext: undefined, functions: new Map(), activeFunctions: new Set() });
          return;
        }
        if (executable === 'env' && (arg === '-S' || arg === '--split-string' || arg.startsWith('--split-string=') || arg.startsWith('-S'))) {
          const attached = arg.startsWith('--split-string=') ? arg.slice(15) : arg.startsWith('-S') && arg.length > 2 ? arg.slice(2) : undefined;
          const payload = attached ?? argv[next + 1];
          if (payload === undefined) return;
          const tree = parser.parse(payload);
          if (!tree) throw new Error('Bash parser could not parse a static env split string');
          nestedTrees.push(tree);
          const statements = tree.rootNode.namedChildren;
          const statement = statements.length === 1 ? statements[0] : undefined;
          // env -S splits words, not shell operators, redirections, or generated values.
          if (statement?.type !== 'command' || statement.hasError || statement.childrenForFieldName('redirect').length > 0 || statement.namedChildren.some(child => child.type === 'variable_assignment')) return;
          const head = statement.childForFieldName('name');
          const splitArgs = [head ? staticWord(head) : undefined, ...statement.childrenForFieldName('argument').map(node => staticWord(node))];
          result.commands.push(policyCommand(payload, effective, context.cwd));
          const suffix = next + (attached === undefined ? 2 : 1);
          const words = ['env', ...splitArgs, ...argv.slice(suffix)];
          const splitPaths = pathArgv && ['env', ...splitArgs, ...pathArgv.slice(suffix)];
          invocations.push({ argv: words, pathArgv: splitPaths, command: renderArgv(words), frame: { ...frame, context: effective, cwdContext: undefined, functions: new Map() }, patterns: new Set() });
          return;
        }
        if (executable === 'env' && ['-i', '--ignore-environment', '-'].includes(arg)) effective.env = {};
        if (executable === 'env' && (arg === '-u' || arg === '--unset' || arg.startsWith('--unset='))) {
          const variable = arg.startsWith('--unset=') ? arg.slice(8) : argv[next + 1];
          if (variable) effective.env = { ...effective.env, [variable]: undefined };
        }
        if ((executable === 'env' && arg === '-C') || (executable === 'sudo' && arg === '-D') || (['env', 'sudo'].includes(executable) && (arg === '--chdir' || arg.startsWith('--chdir=')))) {
          const directory = arg.startsWith('--chdir=') ? arg.slice(8) : argv[next + 1];
          if (directory !== undefined) {
            try { effective.cwd = realpathSync(resolve(effective.cwd, directory)); }
            catch { effective.dynamic = true; }
          } else effective.dynamic = true;
        }
        const consumesValue = wrapperOptions.includes(arg);
        if (executable === 'watch' && (arg === '-x' || arg === '--exec')) watchExec = true;
        next += consumesValue ? 2 : 1;
      }
      if (executable === 'timeout' || executable === 'flock') next++; // Duration/lock is not an executable.
      const lockCommand = argv[next];
      if (executable === 'flock' && (lockCommand === '-c' || lockCommand === '--command' || lockCommand?.startsWith('--command='))) {
        const payload = lockCommand?.startsWith('--command=') ? lockCommand.slice(10) : argv[next + 1];
        if (payload !== undefined) enqueueSource(payload, { ...frame, context: { ...effective, stdin: { kind: 'unknown' } }, cwdContext: undefined, functions: new Map(), activeFunctions: new Set() });
        return;
      }
      if (SHELL_TEMPLATE_WRAPPERS[executable] === true && !watchExec) {
        const end = argv.findIndex((value, index) => index >= next && !!value && /^::::?\+?$/.test(value));
        const words = argv.slice(next, end < 0 ? undefined : end);
        const enqueueTemplate = (operands: readonly (string | undefined)[]): void => {
          const literal = operands.map(value => value ?? '$__KIT_UNKNOWN_ARG').join(' ');
          const source = executable === 'watch' ? literal : literal.replace(/\{(?:\d+|[#%./]+)?\}/g, '$__KIT_UNKNOWN_ITEM');
          enqueueSource(source, { ...frame, context: { ...effective, dynamic: effective.dynamic || executable !== 'watch', stdin: { kind: 'unknown' } }, cwdContext: undefined, functions: new Map(), activeFunctions: new Set() });
        };
        enqueueTemplate(words);
        // Keep the unknown primary analysis; add captured operand evidence without resolving its head.
        if (pathArgv && words[0] !== undefined) {
          const evidence = pathArgv.slice(next, end < 0 ? undefined : end);
          if (evidence.some((value, index) => value !== words[index])) enqueueTemplate(evidence);
        }
        return;
      }
      if (executable === 'command' || executable === 'builtin') suppressFunctionLookup = true;
      else if (!(executable === 'time' && name === 'time')) {
        frame = { ...frame, context: effective, cwdContext: undefined, functions: new Map() };
      }
      if (executable === 'xargs') { effective.stdin = { kind: 'unknown' }; effective.dynamic = true; }
      offset = next;
    }
  }

  try {
    while (pending.length > 0 || invocations.length > 0) {
      const invocation = invocations.pop();
      if (invocation) {
        inspectInvocation(invocation.argv, invocation.command, invocation.frame, invocation.patterns, invocation.pathArgv);
        continue;
      }
      let frame = pending.pop()!;
      // Clone when visited, not queued: earlier foreground statements may change cwd.
      if (frame.background) frame = { ...frame, background: false, context: { ...frame.context }, cwdContext: undefined, functions: new Map(frame.functions) };
      const { node } = frame;
      if (node.type === 'function_definition') {
        const name = node.childForFieldName('name');
        const body = node.childForFieldName('body');
        if (name && body) frame.functions.set(name.text, node);
        continue;
      }
      if (['comment', 'raw_string'].includes(node.type)) continue;
      if (node.type === 'redirected_statement') {
        const body = node.childForFieldName('body');
        const redirects = node.childrenForFieldName('redirect');
        for (let i = redirects.length - 1; i >= 0; i--) pending.push({ ...frame, node: redirects[i]!, inputRedirects: undefined });
        if (body) {
          // tree-sitter attaches a trailing redirect to an entire and/or list,
          // but the shell evaluates it for the final command, after earlier cd.
          const deferred = DEFERRED_REDIRECT_BODIES[body.type];
          pending.push({
            ...frame, node: body,
            context: deferred ? frame.context : withInputRedirects(node, frame.context, frame.inputRedirects),
            inputRedirects: deferred ? [...(frame.inputRedirects ?? []), ...redirects] : undefined,
            cwdContext: frame.cwdContext ?? frame.context,
          });
        }
        continue;
      }
      if (node.type === 'pipeline') {
        const statements = node.namedChildren;
        for (let i = statements.length - 1; i >= 0; i--) {
          pending.push({
            ...frame, node: statements[i]!,
            context: { ...frame.context, stdin: i > 0 ? { kind: 'unknown' } : frame.context.stdin },
            functions: new Map(frame.functions),
            cwdContext: undefined,
            inputRedirects: i === statements.length - 1 ? frame.inputRedirects : undefined,
          });
        }
        continue;
      }
      if (['if_statement', 'while_statement', 'for_statement', 'c_style_for_statement', 'case_statement'].includes(node.type) || (node.type === 'list' && node.children.some(child => child.text === '||'))) {
        frame.uncertainCwd = true;
      }
      if (node.type === 'variable_assignment') {
        const name = node.childForFieldName('name');
        const value = node.childForFieldName('value');
        if (name && name.type === 'variable_name') frame.context.env = { ...frame.context.env, [name.text]: value ? staticWord(value) : '' };
      }
      if (node.type === 'heredoc_body') {
        for (const child of node.namedChildren) {
          if (child.type === 'command_substitution') pending.push({ ...frame, node: child, context: { ...frame.context }, cwdContext: undefined, functions: new Map(frame.functions) });
        }
        continue;
      }
      if (node.type === 'command') {
        const head = node.childForFieldName('name');
        const name = head ? staticWord(head) : undefined;
        const argumentNodes = node.childrenForFieldName('argument');
        const args = argumentNodes.map(argument => {
          const value = staticWord(argument, true);
          // The assignment's lexical prefix is sufficient to skip it as an env operand.
          // Its generated value remains unknown, never an invented executable head.
          const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(argument.text);
          return value ?? (assignment && name && basename(name) === 'env' ? assignment[0] : undefined);
        });
        // Path/veto evidence only: never promote an executable or prove unknown SQL/dry-run safe.
        // Shell expands argv before applying this command's temporary environment assignments.
        let pathArgv: Array<string | undefined> | undefined;
        if (name !== undefined && !frame.context.dynamic && !frame.uncertainCwd) {
          for (let i = 0; i < args.length; i++) {
            if (args[i] !== undefined) continue;
            const reference = /^"\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})"$/.exec(argumentNodes[i]!.text);
            const value = reference && frame.context.env?.[reference[1] ?? reference[2]!];
            if (typeof value !== 'string') continue;
            pathArgv ??= [name, ...args];
            pathArgv[i + 1] = value;
          }
        }
        const patterns = new Set<number>();
        const unknownEnv = new Set<string>();
        for (const argument of argumentNodes) {
          const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(argument.text);
          if (assignment && staticWord(argument, true) === undefined) unknownEnv.add(assignment[1]!);
        }
        for (let i = 0; i < argumentNodes.length; i++) if (hasUnquotedPattern(argumentNodes[i]!)) patterns.add(i + 1);
        const invocationContext = withInputRedirects(node, frame.context, frame.inputRedirects);
        for (const assignment of node.namedChildren.filter(child => child.type === 'variable_assignment')) {
          const variable = assignment.childForFieldName('name');
          const value = assignment.childForFieldName('value');
          if (variable?.type === 'variable_name') invocationContext.env = { ...invocationContext.env, [variable.text]: value ? staticWord(value) : '' };
        }
        if (name === 'cd' && !frame.functions.has(name)) {
          changeDirectory(args, patterns, frame, invocationContext);
        } else {
          if (name === undefined || ['source', '.', 'pushd', 'popd'].includes(name)) {
            (frame.cwdContext ?? frame.context).dynamic = true;
            frame.context.dynamic = true;
            invocationContext.dynamic = true;
          }
          inspectInvocation([name, ...args], node.text, { ...frame, context: invocationContext, cwdContext: frame.cwdContext ?? frame.context, unknownEnv }, patterns, pathArgv);
        }
        const children = node.namedChildren;
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i]!;
          if (child.type === 'variable_assignment') {
            const value = child.childForFieldName('value');
            if (value) pending.push({ ...frame, node: value, context: { ...frame.context }, inputRedirects: undefined });
          } else {
            pending.push({ ...frame, node: child, inputRedirects: undefined });
          }
        }
        continue;
      }
      const isolated = ['subshell', 'command_substitution', 'process_substitution'].includes(node.type);
      const childFrame = isolated ? { ...frame, context: { ...frame.context }, cwdContext: undefined, functions: new Map(frame.functions) } : frame;
      const children = node.children;
      let finalStatement = true;
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i]!;
        if (!child.isNamed || child.type === 'comment') continue;
        pending.push({ ...childFrame, node: child, background: children[i + 1]?.type === '&',
          inputRedirects: node.type === 'list' && !finalStatement ? undefined : childFrame.inputRedirects });
        finalStatement = false;
      }
    }
  } finally {
    for (const tree of nestedTrees) tree?.delete();
  }
  result.reasons = [...new Set(result.reasons)];
  result.commands = [...new Set(result.commands)];
  const seenPaths = new Set<string>();
  result.paths = result.paths.filter(item => {
    const key = `${item.effect}\0${item.path}`;
    if (seenPaths.has(key)) return false;
    seenPaths.add(key);
    return true;
  });
  result.approval = result.reasons.length ? 'enhanced' : 'ordinary';
  return result;
}

export async function classifyDangerousCommand(command: string, context: ClassificationContext): Promise<DangerousAnalysis> {
  const parser = await getEnhancedParser();
  const tree = parser.parse(command);
  if (!tree) throw new Error('Bash parser could not produce a syntax tree');
  try {
    return classifyParsedBash(tree.rootNode, context, parser);
  } finally {
    tree.delete();
  }
}
