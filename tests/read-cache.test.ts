import {describe, expect, it} from 'vitest';
import {ReadCache} from '../src/read-cache';

describe('shared immutable reads', () => {
  it('runs one provider for concurrent readers and retains a successful immutable snapshot', async () => {
    const cache = new ReadCache(100, 4);
    let reads = 0, finish!: (value: string) => void;
    const provider = () => {reads++; return new Promise<string>(resolve => {finish = resolve;});};
    const requests = Array.from({length: 6}, () => cache.read('snapshot', provider, value => value.length));
    await Promise.resolve();
    expect(reads).toBe(1);
    finish('saved snapshot');
    expect(await Promise.all(requests)).toEqual(Array(6).fill('saved snapshot'));
    expect(await cache.read('snapshot', provider, value => value.length)).toBe('saved snapshot');
    expect(reads).toBe(1);
  });
  it('coalesces mutable reads only while pending so refresh gets new data', async () => {
    const cache = new ReadCache(100, 4);
    let reads = 0;
    const provider = async () => ++reads;
    expect(await Promise.all([cache.read('list', provider), cache.read('list', provider)])).toEqual([1, 1]);
    expect(await cache.read('list', provider)).toBe(2);
  });
  it('removes failed reads so an unavailable snapshot can be retried', async () => {
    const cache = new ReadCache(100, 4);
    await expect(cache.read('failed', async () => {throw new Error('Unavailable');}, () => 1)).rejects.toThrow('Unavailable');
    expect(await cache.read('failed', async () => 'restored', () => 1)).toBe('restored');
  });
  it('evicts older retained results to keep memory within the byte budget', async () => {
    const cache = new ReadCache(16, 4);
    let reads = 0;
    const load = (key: string) => cache.read(key, async () => {reads++; return key.repeat(8);}, value => value.length);
    await load('a'); await load('b'); await load('c');
    expect(reads).toBe(3);
    await load('b'); expect(reads).toBe(3);
    await load('a'); expect(reads).toBe(4);
  });
  it('does not retain oversized results or let an old in-flight read repopulate a cleared cache', async () => {
    const cache = new ReadCache(8, 2);
    let reads = 0;
    const oversized = () => cache.read('large', async () => {reads++; return 'x'.repeat(16);}, value => value.length);
    await oversized(); await oversized(); expect(reads).toBe(2);
    let finish!: (value: string) => void;
    const obsolete = cache.read('key', () => new Promise<string>(resolve => {finish = resolve;}), value => value.length);
    await Promise.resolve(); cache.clear(); finish('old'); await obsolete;
    expect(await cache.read('key', async () => 'new', value => value.length)).toBe('new');
  });
});
