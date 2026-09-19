import { describe, expect, it } from 'vitest';
import { mapMount } from './mappers';

describe('mapMount', () => {
  it('carries real stats through so the UI never shows a hardcoded zero', () => {
    const got = mapMount({
      id: 'photos',
      name: 'photos',
      type: 'local',
      status: 'mounted',
      stats: { total_bytes: 596, node_count: 822, capacity_bytes: 4096 },
    });
    expect(got.stats).toEqual({ total_bytes: 596, node_count: 822, capacity_bytes: 4096 });
  });

  it('leaves stats undefined when the control plane gave none', () => {
    expect(mapMount({ id: 'x', name: 'x', type: 'local' }).stats).toBeUndefined();
  });
});
