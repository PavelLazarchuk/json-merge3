import { describe, expect, it } from 'vitest';
import { MergeInputError } from './json';
import { merge3 } from './merge';
import type { MergeOptions } from './types';

interface Item {
    readonly id: number | string;
    readonly [member: string]: unknown;
}
interface Doc {
    readonly items: readonly Item[];
}

const byId: MergeOptions = { arrays: { '/items': { by: 'id' } } };
const docs = (base: Doc, ours: Doc, theirs: Doc, options: MergeOptions = byId) =>
    merge3<Doc>(base, ours, theirs, options);
const items = (...list: Item[]): Doc => ({ items: list });
const ids = (doc: Doc) => doc.items.map(item => item.id);

describe('atomic arrays (default)', () => {
    it('takes the one side that changed the array', () => {
        expect(merge3({ a: [1, 2] }, { a: [1, 2, 3] }, { a: [1, 2] }).value).toEqual({
            a: [1, 2, 3],
        });
    });

    it('reports both sides changing the array as one value conflict', () => {
        expect(merge3({ a: [1] }, { a: [1, 2] }, { a: [0, 1] }).conflicts).toEqual([
            { kind: 'value', path: '/a', base: [1], ours: [1, 2], theirs: [0, 1] },
        ]);
    });

    it('accepts identical array edits', () => {
        expect(merge3({ a: [1] }, { a: [2, 3] }, { a: [2, 3] }).ok).toBe(true);
    });

    it('can be requested explicitly over a broader rule', () => {
        const result = merge3(
            { a: [1], b: [1] },
            { a: [1, 2], b: [1, 2] },
            { a: [1, 3], b: [1, 3] },
            { arrays: { '/**': 'set', '/b': 'atomic' } }
        );
        expect(result.value.a).toEqual([1, 2, 3]);
        expect(result.conflicts.map(conflict => conflict.path)).toEqual(['/b']);
    });
});

describe('set arrays', () => {
    const sets: MergeOptions = { arrays: { '/tags': 'set' } };
    const tags = (base: unknown[], ours: unknown[], theirs: unknown[]) =>
        merge3({ tags: base }, { tags: ours }, { tags: theirs }, sets);

    it('applies additions and removals from both sides without conflicts', () => {
        expect(tags(['a', 'b'], ['a', 'b', 'c'], ['b', 'd'])).toMatchObject({
            ok: true,
            value: { tags: ['b', 'c', 'd'] },
        });
    });

    it('collapses duplicates and keeps the order ours chose', () => {
        expect(tags(['a', 'b'], ['b', 'a', 'a', 'x'], ['a', 'b', 'x', 'y']).value.tags).toEqual([
            'b',
            'a',
            'x',
            'y',
        ]);
    });

    it('compares objects in sets by value, regardless of member order', () => {
        expect(tags([{ k: 1, v: 1 }], [{ v: 1, k: 1 }, { k: 2 }], []).value.tags).toEqual([
            { k: 2 },
        ]);
    });

    it('distinguishes values of different types', () => {
        expect(
            tags([1, '1', null, true], [1, '1', null, true, 'null'], ['1', null, true]).value.tags
        ).toEqual(['1', null, true, 'null']);
    });

    it('keeps ours by reference when the merge adds nothing to it', () => {
        const ours = ['a', 'c'];
        expect(tags(['a', 'b'], ours, ['a']).value.tags).toBe(ours);
    });
});

describe('arrays merged by id', () => {
    it('merges edits to different elements and to different members of one element', () => {
        const base = items({ id: 1, title: 'a', done: false }, { id: 2, title: 'b', done: false });
        const ours = items({ id: 1, title: 'A', done: false }, { id: 2, title: 'b', done: false });
        const theirs = items({ id: 1, title: 'a', done: true }, { id: 2, title: 'b', done: true });
        expect(docs(base, ours, theirs)).toMatchObject({
            ok: true,
            value: items({ id: 1, title: 'A', done: true }, { id: 2, title: 'b', done: true }),
        });
    });

    it('keeps insertions from both sides next to their neighbours', () => {
        const base = items({ id: 1 }, { id: 2 }, { id: 3 });
        const ours = items({ id: 1 }, { id: 10 }, { id: 2 }, { id: 3 });
        const theirs = items({ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 20 }, { id: 21 });
        expect(ids(docs(base, ours, theirs).value)).toEqual([0, 1, 10, 2, 3, 20, 21]);
    });

    it('applies deletions from either side', () => {
        const base = items({ id: 1 }, { id: 2 }, { id: 3 });
        const result = docs(base, items({ id: 1 }, { id: 3 }), items({ id: 1 }, { id: 2 }));
        expect(ids(result.value)).toEqual([1]);
    });

    it('reports a deleted element that the other side edited, addressed by id', () => {
        const base = items({ id: 'a', v: 1 });
        const theirs = items({ id: 'a', v: 2 });
        const result = docs(base, items(), theirs);
        expect(result.conflicts).toEqual([
            {
                kind: 'delete-edit',
                path: '/items/a',
                base: { id: 'a', v: 1 },
                theirs: { id: 'a', v: 2 },
            },
        ]);
        expect(result.value.items).toEqual([]);
        expect(docs(base, items(), theirs, { ...byId, prefer: 'theirs' }).value).toEqual(theirs);
    });

    it('reports conflicting edits inside elements with id-based paths', () => {
        const result = docs(
            items({ id: 7, title: 'x' }),
            items({ id: 7, title: 'y' }),
            items({ id: 7, title: 'z' })
        );
        expect(result.conflicts.map(conflict => conflict.path)).toEqual(['/items/7/title']);
    });

    it('follows a reorder made by only one side, keeping appended elements last', () => {
        const base = items({ id: 1 }, { id: 2 }, { id: 3 });
        const ours = items({ id: 1, v: 1 }, { id: 2 }, { id: 3 }, { id: 4 });
        const theirs = items({ id: 3 }, { id: 2 }, { id: 1 });
        const result = docs(base, ours, theirs);
        expect(result.ok).toBe(true);
        expect(result.value).toEqual(items({ id: 3 }, { id: 2 }, { id: 1, v: 1 }, { id: 4 }));
        expect(ids(docs(base, theirs, ours).value)).toEqual([3, 2, 1, 4]);
    });

    it('accepts the same reorder made by both sides', () => {
        const base = items({ id: 1 }, { id: 2 });
        const result = docs(
            base,
            items({ id: 2 }, { id: 1 }),
            items({ id: 2 }, { id: 1 }, { id: 3 })
        );
        expect(result).toMatchObject({ ok: true, value: items({ id: 2 }, { id: 1 }, { id: 3 }) });
    });

    it('reports different reorders as an order conflict', () => {
        const base = items({ id: 1 }, { id: 2 }, { id: 3 });
        const ours = items({ id: 2 }, { id: 1 }, { id: 3 }, { id: 4 });
        const theirs = items({ id: 1 }, { id: 3 }, { id: 2 });
        const result = docs(base, ours, theirs);
        expect(result.conflicts).toEqual([
            {
                kind: 'order',
                path: '/items',
                base: base.items,
                ours: ours.items,
                theirs: theirs.items,
            },
        ]);
        expect(ids(result.value)).toEqual([2, 1, 3, 4]);
        expect(ids(docs(base, ours, theirs, { ...byId, prefer: 'theirs' }).value)).toEqual([
            1, 3, 2, 4,
        ]);
    });

    it('settles an order conflict with a strategy or resolve()', () => {
        const base = items({ id: 1 }, { id: 2 }, { id: 3 });
        const ours = items({ id: 2 }, { id: 1 }, { id: 3, v: 1 });
        const theirs = items({ id: 1 }, { id: 3 }, { id: 2 });
        const run = (options: MergeOptions) => docs(base, ours, theirs, { ...byId, ...options });
        expect(ids(run({ strategies: { '/items': 'theirs' } }).value)).toEqual([1, 3, 2]);
        expect(run({ strategies: { '/items': 'base' } }).value).toEqual(
            items({ id: 1 }, { id: 2 }, { id: 3, v: 1 })
        );
        expect(run({ resolve: () => ({ value: { kept: true } }) }).value.items).toEqual({
            kept: true,
        });
        expect('items' in run({ resolve: () => ({ remove: true }) }).value).toBe(false);
        expect(run({ strategies: { '/items': 'max' } }).conflicts[0]?.kind).toBe('order');
    });

    it('keeps the ours array by reference when nothing from theirs lands in it', () => {
        const oursItems = [{ id: 1, v: 2 }];
        const result = merge3(
            { items: [{ id: 1, v: 1 }], x: 1 },
            { items: oursItems, x: 1 },
            { items: [{ id: 1, v: 1 }], x: 2 },
            byId
        );
        expect(result.value.items).toBe(oursItems);
    });

    it('matches ids by their text', () => {
        const result = docs(
            items({ id: 1, v: 0 }),
            items({ id: 1, v: 1 }),
            items({ id: 1, v: 0 }, { id: 'x', v: 0 })
        );
        expect(result.value).toEqual(items({ id: 1, v: 1 }, { id: 'x', v: 0 }));
    });

    it('applies rules by pattern to nested arrays', () => {
        const base = { lists: [{ id: 'a', cards: [{ key: 1 }] }] };
        const ours = { lists: [{ id: 'a', cards: [{ key: 1 }, { key: 2 }] }] };
        const theirs = { lists: [{ id: 'a', cards: [{ key: 0 }, { key: 1 }] }] };
        const result = merge3(base, ours, theirs, {
            arrays: { '/lists': { by: 'id' }, '/lists/*/cards': { by: 'key' } },
        });
        expect(result.value.lists[0]?.cards).toEqual([{ key: 0 }, { key: 1 }, { key: 2 }]);
    });

    it('rejects elements it cannot identify', () => {
        const run = (list: unknown[]) => () =>
            merge3<unknown>(items({ id: 1 }), { items: list }, items({ id: 2 }), byId);
        expect(run([1])).toThrow(MergeInputError);
        expect(run([1])).toThrow(
            'ours at /items/0: is not an object, so it has no "id" to merge by'
        );
        expect(run([{ name: 'x' }])).toThrow(
            'ours at /items/0: has no string or number "id" to merge by'
        );
        expect(run([{ id: 1 }, { id: 1 }])).toThrow(
            'ours at /items/1: repeats id 1 — ids must be unique'
        );
    });
});

describe('placement of insertions', () => {
    it('puts ours before theirs when both insert at the same spot', () => {
        const result = docs(
            items({ id: 0 }, { id: 3 }),
            items({ id: 0 }, { id: 1 }, { id: 3 }),
            items({ id: 0 }, { id: 2 }, { id: 3 })
        );
        expect(ids(result.value)).toEqual([0, 1, 2, 3]);
        const flipped = docs(
            items({ id: 0 }, { id: 3 }),
            items({ id: 0 }, { id: 2 }, { id: 3 }),
            items({ id: 0 }, { id: 1 }, { id: 3 })
        );
        expect(ids(flipped.value)).toEqual([0, 2, 1, 3]);
    });

    it('keeps runs of insertions together and in order', () => {
        const result = docs(
            items({ id: 1 }, { id: 9 }),
            items({ id: 1 }, { id: 'a' }, { id: 'b' }, { id: 9 }),
            items({ id: 'x' }, { id: 1 }, { id: 'c' }, { id: 'd' }, { id: 9 }, { id: 'z' })
        );
        expect(ids(result.value)).toEqual(['x', 1, 'a', 'b', 'c', 'd', 9, 'z']);
    });
});
