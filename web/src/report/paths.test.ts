import { describe, expect, it } from 'vitest';
import { baseName, childPath, deriveExt, parentOf } from './paths';

describe('childPath', () => {
  it('joins from the root without doubling the slash', () => {
    expect(childPath('/', 'a')).toBe('/a');
  });

  it('joins nested paths', () => {
    expect(childPath('/a', 'b')).toBe('/a/b');
  });

  it('ignores a trailing slash on the parent', () => {
    expect(childPath('/a/', 'b')).toBe('/a/b');
  });
});

describe('parentOf', () => {
  it('walks up one level', () => {
    expect(parentOf('/a/b.jpg')).toBe('/a');
  });

  it('keeps the root as its own parent', () => {
    expect(parentOf('/a')).toBe('/');
    expect(parentOf('/')).toBe('/');
  });
});

describe('baseName', () => {
  it('returns the last segment', () => {
    expect(baseName('/a/b/c.txt')).toBe('c.txt');
  });

  it('returns an empty string for the root so callers pick a fallback', () => {
    expect(baseName('/')).toBe('');
    expect(baseName('')).toBe('');
  });
});

describe('deriveExt', () => {
  it('lowercases the extension', () => {
    expect(deriveExt('A.JPG')).toBe('jpg');
  });

  it('takes only the last suffix', () => {
    expect(deriveExt('archive.tar.gz')).toBe('gz');
  });

  it('returns empty for extensionless names', () => {
    expect(deriveExt('README')).toBe('');
  });

  it('treats dotfiles as extensionless', () => {
    expect(deriveExt('.gitignore')).toBe('');
  });

  it('returns empty for a trailing dot', () => {
    expect(deriveExt('weird.')).toBe('');
  });
});
