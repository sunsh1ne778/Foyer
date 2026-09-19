export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function parseLine(line: string): { json: boolean; argv: string[] } {
  let argv = tokenize(line.trim());
  if (argv[0] === 'filestore') argv = argv.slice(1);
  const json = argv.includes('--json');
  argv = argv.filter(t => t !== '--json');
  return { json, argv };
}
