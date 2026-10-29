import { describe, expect, it, vi } from 'vitest';
import { MergeInputError } from './json';
import { merge3 } from './merge';
import type { Conflict, MergeOptions, Resolution, Strategy } from './types';

type Loose = Record<string, unknown>;
const loose = (base: Loose, ours: Loose, theirs: Loose, options?: MergeOptions) =>
    merge3<Loose>(base, ours, theirs, options);

describe('strategies', () => {
    it('settles conflicts by taking a side and reports them as resolved', () => {
        expect(loose({ a: 1 }, { a: 2 }, { a: 3 }, { strategies: { '/a': 'theirs' } })).toEqual({
            ok: true,
            value: { a: 3 },
            conflicts: [],
            resolved: [
                {
                    kind: 'value',
                    path: '/a',
                    base: 1,
                    ours: 2,
                    theirs: 3,
                    resolution: { use: 'theirs' },
                    by: 'strategy',
                },
            ],
        });
        expect(loose({ a: 1 }, { a: 2 }, { a: 3 }, { strategies: { '/a': 'base' } }).value).toEqual(
            {
                a: 1,
            }
        );
        expect(
            loose({ a: 1 }, { a: 2 }, { a: 3 }, { strategies: { '/a': 'ours' }, prefer: 'theirs' })
                .value
        ).toEqual({ a: 2 });
    });

    it('covers everything below the pattern, with the deepest match winning', () => {
        const base = { settings: { a: 0, b: 0, nested: { c: 0 } } };
        const ours = { settings: { a: 1, b: 1, nested: { c: 1 } } };
        const theirs = { settings: { a: 2, b: 2, nested: { c: 2 } } };
        const result = merge3(base, ours, theirs, {
            strategies: { '/settings': 'theirs', '/settings/b': 'ours' },
        });
        expect(result.value).toEqual({ settings: { a: 2, b: 1, nested: { c: 2 } } });
        expect(result.resolved.map(conflict => conflict.path)).toEqual([
            '/settings/a',
            '/settings/b',
            '/settings/nested/c',
        ]);
    });

    it('settles deletes against edits when the strategy picks a side', () => {
        expect(loose({ a: 1 }, {}, { a: 2 }, { strategies: { '/**': 'theirs' } }).value).toEqual({
            a: 2,
        });
        expect(loose({ a: 1 }, {}, { a: 2 }, { strategies: { '/**': 'ours' } }).value).toEqual({});
        expect(loose({}, { a: 1 }, { a: 2 }, { strategies: { '/a': 'base' } }).value).toEqual({});
    });

    it('max and min pick the larger or smaller number or string', () => {
        const pick = (strategy: Strategy, ours: unknown, theirs: unknown) =>
            loose({ v: 0 }, { v: ours }, { v: theirs }, { strategies: { '/v': strategy } }).value.v;
        expect(pick('max', 5, 3)).toBe(5);
        expect(pick('max', 3, 5)).toBe(5);
        expect(pick('min', 5, 3)).toBe(3);
        expect(pick('min', 3, 5)).toBe(3);
        expect(pick('max', '2026-10-01T10:00:00Z', '2026-10-03T08:00:00Z')).toBe(
            '2026-10-03T08:00:00Z'
        );
        expect(loose({}, { v: 1 }, { v: 9 }, { strategies: { '/v': 'max' } }).value).toEqual({
            v: 9,
        });
    });

    it('compares timestamps with hour-only offsets and sub-millisecond fractions by instant', () => {
        const pick = (strategy: Strategy, ours: string, theirs: string) =>
            loose({ t: '' }, { t: ours }, { t: theirs }, { strategies: { '/t': strategy } }).value
                .t;
        expect(pick('max', '2024-03-01T10:00:00+05', '2024-03-01T06:00:00Z')).toBe(
            '2024-03-01T06:00:00Z'
        );
        expect(pick('min', '2024-03-01T06:00:00Z', '2024-03-01T10:00:00+05')).toBe(
            '2024-03-01T10:00:00+05'
        );
        expect(pick('min', '2024-03-01T10:00:00.000000001Z', '2024-03-01T10:00:00Z')).toBe(
            '2024-03-01T10:00:00Z'
        );
        expect(pick('max', '2024-03-01T10:00:00.1Z', '2024-03-01T10:00:00.09999999Z')).toBe(
            '2024-03-01T10:00:00.1Z'
        );
    });

    it('settles a value first set on both sides from null', () => {
        const result = loose(
            { lastSeenAt: null },
            { lastSeenAt: '2026-10-03T08:00:00Z' },
            { lastSeenAt: '2026-10-03T09:30:00Z' },
            { strategies: { '/lastSeenAt': 'max' } }
        );
        expect(result.value).toEqual({ lastSeenAt: '2026-10-03T09:30:00Z' });
        expect(result.resolved).toMatchObject([{ kind: 'type', by: 'strategy' }]);
        expect(
            loose({ n: null }, { n: 2 }, { n: 3 }, { strategies: { '/n': 'counter' } }).value
        ).toEqual({ n: 5 });
    });

    it('counter applies both deltas', () => {
        const counter: MergeOptions = { strategies: { '/likes': 'counter' } };
        expect(loose({ likes: 10 }, { likes: 12 }, { likes: 15 }, counter).value).toEqual({
            likes: 17,
        });
        expect(loose({}, { likes: 2 }, { likes: 3 }, counter).value).toEqual({ likes: 5 });
        expect(loose({ likes: 10 }, { likes: 8 }, { likes: 15 }, counter).value).toEqual({
            likes: 13,
        });
    });

    it('counter adds identical changes from both sides', () => {
        const counter: MergeOptions = { strategies: { '/likes': 'counter' } };
        const result = loose({ likes: 10 }, { likes: 11 }, { likes: 11 }, counter);
        expect(result.value).toEqual({ likes: 12 });
        expect(result.resolved).toMatchObject([
            { kind: 'value', path: '/likes', resolution: { value: 12 }, by: 'strategy' },
        ]);
        expect(loose({}, { likes: 2 }, { likes: 2 }, counter).value).toEqual({ likes: 4 });
        expect(loose({ likes: 10 }, { likes: 10 }, { likes: 10 }, counter).resolved).toEqual([]);
        const items = [{ id: 'a', qty: 1, name: 'x' }];
        const edited = [{ id: 'a', qty: 3, name: 'y' }];
        expect(
            loose(
                { items },
                { items: edited },
                { items: edited },
                {
                    arrays: { '/items': { by: 'id' } },
                    strategies: { '/items/*/qty': 'counter' },
                }
            ).value
        ).toEqual({ items: [{ id: 'a', qty: 5, name: 'y' }] });
        expect(
            loose(
                { s: { n: 1 } },
                { s: { n: 2 } },
                { s: { n: 2 } },
                { strategies: { '/**': 'counter' } }
            ).value
        ).toEqual({ s: { n: 3 } });
        expect(loose({ n: 1 }, { n: 2 }, { n: 2 }, { strategies: { '/n': 'max' } })).toEqual({
            ok: true,
            value: { n: 2 },
            conflicts: [],
            resolved: [],
        });
    });

    it('leaves conflicts a value strategy cannot handle', () => {
        const kinds = (base: Loose, ours: Loose, theirs: Loose, strategy: Strategy) =>
            loose(base, ours, theirs, { strategies: { '/v': strategy } }).conflicts.map(
                conflict => conflict.kind
            );
        expect(kinds({ v: 1 }, { v: 2 }, { v: 'x' }, 'max')).toEqual(['type']);
        expect(kinds({ v: 1 }, {}, { v: 2 }, 'counter')).toEqual(['delete-edit']);
        expect(kinds({ v: 'a' }, { v: 'b' }, { v: 'c' }, 'counter')).toEqual(['value']);
        expect(kinds({ v: 1 }, { v: [1] }, { v: [2] }, 'max')).toEqual(['type']);
        expect(kinds({ v: [0] }, { v: [1] }, { v: [2] }, 'min')).toEqual(['value']);
    });

    it('matches * to one segment and ** to any number of them', () => {
        const base = { a: { x: { n: 0 } }, b: { y: { n: 0 } }, c: { n: 0 } };
        const ours = { a: { x: { n: 1 } }, b: { y: { n: 1 } }, c: { n: 1 } };
        const theirs = { a: { x: { n: 2 } }, b: { y: { n: 2 } }, c: { n: 2 } };
        const result = merge3(base, ours, theirs, { strategies: { '/*/*/n': 'max' } });
        expect(result.value).toEqual({ a: { x: { n: 2 } }, b: { y: { n: 2 } }, c: { n: 1 } });
        expect(result.conflicts.map(conflict => conflict.path)).toEqual(['/c/n']);
        expect(merge3(base, ours, theirs, { strategies: { '/**/n': 'min' } }).ok).toBe(true);
    });

    it('prefers literal segments over wildcards, then fewer **, then declaration order', () => {
        const pick = (strategies: Record<string, Strategy>) =>
            merge3({ a: { b: 0 } }, { a: { b: 1 } }, { a: { b: 2 } }, { strategies }).value.a.b;
        expect(pick({ '/a/*': 'ours', '/a/b': 'theirs' })).toBe(2);
        expect(pick({ '/**/b': 'theirs', '/a/*': 'ours' })).toBe(1);
        expect(pick({ '/*/b': 'theirs', '/a/*': 'ours' })).toBe(2);
    });
});

describe('resolve()', () => {
    it('receives each conflict no strategy settled', () => {
        const resolve = vi.fn<(conflict: Conflict) => Resolution | undefined>(() => undefined);
        const result = loose(
            { a: 1, b: 1 },
            { a: 2, b: 2 },
            { a: 3, b: 3 },
            {
                resolve,
                strategies: { '/a': 'ours' },
            }
        );
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(resolve).toHaveBeenCalledWith({
            kind: 'value',
            path: '/b',
            base: 1,
            ours: 2,
            theirs: 3,
        });
        expect(result.conflicts.map(conflict => conflict.path)).toEqual(['/b']);
    });

    it('applies every resolution shape', () => {
        const run = (resolution: Resolution) =>
            loose(
                { a: 1, keep: true },
                { a: 2, keep: true },
                { a: 3, keep: true },
                {
                    resolve: () => resolution,
                }
            );
        expect(run({ use: 'theirs' }).value).toEqual({ a: 3, keep: true });
        expect(run({ use: 'base' }).value).toEqual({ a: 1, keep: true });
        expect(run({ use: 'ours' }).value).toEqual({ a: 2, keep: true });
        expect(run({ value: { merged: [2, 3] } }).value).toEqual({
            a: { merged: [2, 3] },
            keep: true,
        });
        expect(run({ remove: true }).value).toEqual({ keep: true });
        expect(run({ value: null }).resolved[0]).toMatchObject({
            resolution: { value: null },
            by: 'resolve',
        });
    });

    it('rejects malformed resolutions with the conflict path', () => {
        const run = (resolution: unknown) => () =>
            merge3(
                { o: { a: 1 } },
                { o: { a: 2 } },
                { o: { a: 3 } },
                {
                    resolve: () => resolution as Resolution,
                }
            );
        expect(run({ use: 'mine' })).toThrow(MergeInputError);
        expect(run({ use: 'mine' })).toThrow('resolve() at /o/a: returned {"use":"mine"}');
        expect(run('theirs')).toThrow('resolve() at /o/a');
        expect(run({ remove: false })).toThrow('resolve() at /o/a');
        expect(run({ use: 'ours', value: 1 })).toThrow('resolve() at /o/a');
        expect(run({ value: new Date(0) })).toThrow('resolve() at /o/a: is a Date');
    });

    it('refuses to remove the whole document', () => {
        expect(() => merge3(1, 2, 3, { resolve: () => ({ remove: true }) })).toThrow(
            'cannot remove the whole document'
        );
    });
});

describe('options validation', () => {
    const run = (options: unknown) => () => merge3({}, {}, {}, options as MergeOptions);

    it('rejects malformed options up front', () => {
        expect(run(null)).toThrow('options: expected an object');
        expect(run({ prefer: 'base' })).toThrow('options.prefer');
        expect(run({ resolve: 'theirs' })).toThrow('options.resolve');
        expect(run({ maxDepth: 0 })).toThrow('options.maxDepth');
        expect(run({ maxDepth: 1.5 })).toThrow('options.maxDepth');
        expect(run({ arrays: { items: 'set' } })).toThrow('is not a JSON Pointer');
        expect(run({ arrays: { '/a': 'list' } })).toThrow('options.arrays["/a"]');
        expect(run({ arrays: { '/a': { by: '' } } })).toThrow('options.arrays["/a"]');
        expect(run({ arrays: { '/a': { by: 'id', extra: 1 } } })).toThrow('options.arrays["/a"]');
        expect(run({ strategies: { '/a': 'newest' } })).toThrow('options.strategies["/a"]');
        expect(run({ arrays: null })).toThrow('options.arrays: expected an object');
        expect(run({ arrays: ['/a'] })).toThrow('options.arrays: expected an object');
        expect(run({ strategies: 'max' })).toThrow('options.strategies: expected an object');
    });

    it('accepts a root pattern', () => {
        expect(merge3(1, 2, 3, { strategies: { '': 'theirs' } }).value).toBe(3);
        expect(merge3([1], [1, 2], [0, 1], { arrays: { '': 'set' } }).value).toEqual([1, 2, 0]);
    });
});
