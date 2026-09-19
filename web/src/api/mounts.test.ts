import { describe, expect, it } from 'vitest';
import { isMetadataImport, mergeMounts, volumeMount } from './mounts';
import type { ApiMount } from './client';

const imported: ApiMount = {
  id: 'photos',
  name: 'photos',
  type: 'local',
  status: 'mounted',
  spec: { root: 'E:\\photos', container: '/mnt/e/photos', dest: '/photos', mode: 'metadata' },
};

describe('mounts merge', () => {
  it('always puts the gateway volume first', () => {
    const list = mergeMounts([imported]);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(volumeMount());
    expect(list[0].name).toBe('foyer');
    expect(list[1].name).toBe('photos');
  });

  it('skips entries that shadow the volume mount', () => {
    const list = mergeMounts([{ ...imported, id: 'foyer', name: 'foyer' }, imported]);
    expect(list.map(m => m.name)).toEqual(['foyer', 'photos']);
  });

  it('skips nameless entries', () => {
    const list = mergeMounts([{ id: 'x', name: '', type: 'local' }]);
    expect(list).toHaveLength(1);
  });

  it('defaults type and status', () => {
    const list = mergeMounts([{ id: 'a', name: 'a' }]);
    expect(list[1].type).toBe('local');
    expect(list[1].status).toBe('mounted');
  });
});

describe('isMetadataImport', () => {
  it('detects the metadata import mode', () => {
    expect(isMetadataImport(imported)).toBe(true);
    expect(isMetadataImport({ spec: { mode: 'copy' } })).toBe(false);
    expect(isMetadataImport({})).toBe(false);
    expect(isMetadataImport({ spec: { bucket: 'foyer' } })).toBe(false);
  });
});
