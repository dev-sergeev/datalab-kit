import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

/** Structural interface also accepted by the upstream parser integration. */
export interface BashSyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly isNamed: boolean;
  readonly namedChildren: readonly BashSyntaxNode[];
  readonly children: readonly BashSyntaxNode[];
  readonly hasError: boolean;
  childForFieldName(name: string): BashSyntaxNode | null;
  childrenForFieldName(name: string): readonly BashSyntaxNode[];
}

export interface BashSyntaxTree {
  readonly rootNode: BashSyntaxNode;
  delete(): void;
}

export interface BashReparser {
  parse(source: string): BashSyntaxTree | null;
}

let parserPromise: Promise<BashReparser> | undefined;

/** Parsing is synchronous after this one shared WASM initialization. */
export function getEnhancedParser(): Promise<BashReparser> {
  parserPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    await Parser.init();
    const language = await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'));
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
}
