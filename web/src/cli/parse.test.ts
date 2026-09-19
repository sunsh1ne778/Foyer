import { describe, expect, it } from 'vitest';
import { parseLine, tokenize } from './parse';

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('ls photos:/a')).toEqual(['ls', 'photos:/a']);
  });

  it('keeps quoted refs with spaces', () => {
    expect(tokenize('ls "photos:/my dir"')).toEqual(['ls', 'photos:/my dir']);
  });
});

describe('parseLine', () => {
  it('strips optional filestore prefix', () => {
    expect(parseLine('filestore ls photos:/')).toEqual({ json: false, argv: ['ls', 'photos:/'] });
    expect(parseLine('ls photos:/')).toEqual({ json: false, argv: ['ls', 'photos:/'] });
  });

  it('strips --json from any position', () => {
    expect(parseLine('ls --json photos:/')).toEqual({ json: true, argv: ['ls', 'photos:/'] });
    expect(parseLine('--json mount ls')).toEqual({ json: true, argv: ['mount', 'ls'] });
  });

  it('returns empty argv for blank input', () => {
    expect(parseLine('   ')).toEqual({ json: false, argv: [] });
  });
});
