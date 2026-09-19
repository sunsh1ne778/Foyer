import { describe, expect, it } from 'vitest';
import { joinRef, keyRelativeToMount, refToKey } from './jfs';

describe('jfs keys', () => {
  it('joinRef and refToKey round-trip object keys', () => {
    expect(joinRef('foyer', '/a/b.txt')).toBe('foyer:/a/b.txt');
    expect(refToKey('foyer:/a/b.txt')).toBe('a/b.txt');
    expect(refToKey('foyer:/')).toBe('');
  });

  it('prefixes imported mount names onto object keys', () => {
    expect(refToKey('photos:/')).toBe('photos');
    expect(refToKey('photos:/raw/a.jpg')).toBe('photos/raw/a.jpg');
    expect(keyRelativeToMount('/photos/raw/a.jpg', 'photos')).toBe('/raw/a.jpg');
    expect(keyRelativeToMount('/a.jpg', 'foyer')).toBe('/a.jpg');
  });
});
