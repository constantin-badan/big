import { describe, test, expect } from 'bun:test';
import type { IDataFeed } from '../index';

describe('data-feed', () => {
  test('IDataFeed interface is importable', () => {
    const feed = {} as IDataFeed;
    expect(feed).toBeDefined();
  });
});
