import { describe, expect, it } from 'vitest';
import { mapMount } from './mappers';

describe('mapMount', () => {
  it('carries the logical size and the live pool occupancy through untouched', () => {
    const got = mapMount({
      id: 'photos',
      name: 'photos',
      type: 'local',
      status: 'mounted',
      stats: {
        total_bytes: 596,
        node_count: 822,
        pool_total_bytes: 2000381014016,
        pool_used_bytes: 921854009344,
        pool_free_bytes: 1078527004672,
      },
    });
    expect(got.stats).toEqual({
      total_bytes: 596,
      node_count: 822,
      pool_total_bytes: 2000381014016,
      pool_used_bytes: 921854009344,
      pool_free_bytes: 1078527004672,
    });
  });

  it('carries stats that have no pool (logical numbers, unknown pool) without inventing one', () => {
    const got = mapMount({
      id: 'host',
      name: 'host',
      type: 'local',
      status: 'mounted',
      stats: { total_bytes: 2433320140800, node_count: 13 },
    });
    expect(got.stats).toEqual({ total_bytes: 2433320140800, node_count: 13 });
    expect(got.stats?.pool_total_bytes).toBeUndefined();
    expect(got.stats?.pool_used_bytes).toBeUndefined();
    expect(got.stats?.pool_free_bytes).toBeUndefined();
  });

  it('leaves stats undefined when the control plane gave none', () => {
    expect(mapMount({ id: 'x', name: 'x', type: 'local' }).stats).toBeUndefined();
  });
});
