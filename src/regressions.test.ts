import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MergeInputError, jsonEqual } from './json';
import { merge3 } from './merge';
import { fromPointer } from './path';
import type { MergeOptions, Resolution } from './types';

interface Item {
    readonly id: number | string;
    readonly [member: string]: unknown;
}
const byId: MergeOptions = { arrays: { '/items': { by: 'id' } } };
const items = (...ids: (number | Item)[]) => ({
    items: ids.map(id => (typeof id === 'number' ? { id } : id)),
});
const idsOf = (doc: { items: readonly Item[] }) => doc.items.map(item => item.id);

describe('order conflicts only when both sides reorder what both kept', () => {
    it('keeps a reorder when the other side only moved an element this side deleted', () => {
        const result = merge3(items(1, 2, 3), items(2, 1), items(3, 1, 2), byId);
        expect(result.ok).toBe(true);
        expect(idsOf(result.value)).toEqual([2, 1]);
    });

    it('never reports an order conflict when one side kept the base order of shared elements', () => {
        let seed = 7;
        const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
        const shuffle = (list: number[]) => list.sort(() => rand() - 0.5);
        for (let run = 0; run < 300; run += 1) {
            const base = shuffle([1, 2, 3, 4, 5, 6]);
            const ours = shuffle(base.filter(() => rand() < 0.7));
            const dropped = base.filter(id => !ours.includes(id) && rand() < 0.6);
            const kept = base.filter(id => ours.includes(id) && rand() < 0.8);
            const theirs = [...kept];
            for (const id of dropped)
                theirs.splice(Math.floor(rand() * (theirs.length + 1)), 0, id);
            const result = merge3(items(...base), items(...ours), items(...theirs), byId);
            expect(result.conflicts.filter(conflict => conflict.kind === 'order')).toEqual([]);
        }
    });
});

describe('set and id rules apply when there was no base array', () => {
    const sets: MergeOptions = { arrays: { '/tags': 'set' } };

    it('merges a set both sides created', () => {
        expect(merge3<object>({}, { tags: ['a'] }, { tags: ['b'] }, sets)).toMatchObject({
            ok: true,
            value: { tags: ['a', 'b'] },
        });
        expect(
            merge3<object>({ tags: null }, { tags: ['a'] }, { tags: ['a', 'b'] }, sets)
        ).toMatchObject({
            ok: true,
            value: { tags: ['a', 'b'] },
        });
    });

    it('merges an id array both sides created, element by element', () => {
        const result = merge3<object>(
            {},
            items(1, { id: 2, v: 'ours' }),
            items({ id: 2, v: 'theirs' }, 3),
            byId
        );
        expect(result.conflicts).toEqual([
            {
                kind: 'add-add',
                path: '/items/2',
                ours: { id: 2, v: 'ours' },
                theirs: { id: 2, v: 'theirs' },
            },
        ]);
        expect(idsOf(result.value as { items: Item[] })).toEqual([1, 2, 3]);
    });

    it('still reports a type clash when only one side holds an array', () => {
        const result = merge3<object>({ tags: null }, { tags: ['a'] }, { tags: 'a' }, sets);
        expect(result.conflicts[0]?.kind).toBe('type');
    });
});

describe('cost stays linear in document size', () => {
    it('merges a deep, wide document quickly', () => {
        const build = (leaf: number) => {
            let doc: Record<string, unknown> = { leafA: 0, leafB: 0 };
            if (leaf === 1) doc.leafA = 1;
            if (leaf === 2) doc.leafB = 1;
            for (let level = 0; level < 400; level += 1) {
                const wrapper: Record<string, unknown> = { child: doc };
                for (let key = 0; key < 200; key += 1) wrapper[`k${key}`] = key;
                doc = wrapper;
            }
            return doc;
        };
        const started = performance.now();
        const result = merge3<unknown>(build(0), build(1), build(2));
        const elapsed = performance.now() - started;
        expect(result.ok).toBe(true);
        expect(elapsed).toBeLessThan(1500);
    });

    it('places many insertions in an id array in linear time', () => {
        const size = 50_000;
        const base = Array.from({ length: size }, (_, index) => ({ id: index * 3 }));
        const ours = base.flatMap(item => [item, { id: item.id + 1 }]);
        const theirs = base.flatMap(item => [item, { id: item.id + 2 }]);
        const started = performance.now();
        const result = merge3({ items: base }, { items: ours }, { items: theirs }, byId);
        const elapsed = performance.now() - started;
        expect(result.value.items).toHaveLength(size * 3);
        expect(result.value.items.slice(0, 6).map(item => item.id)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(elapsed).toBeLessThan(1500);
    });
});

describe('strategy precedence', () => {
    it('lets a literal subtree rule beat a ** catch-all', () => {
        const result = merge3(
            { settings: { a: 0 }, other: 0 },
            { settings: { a: 1 }, other: 1 },
            { settings: { a: 2 }, other: 2 },
            { strategies: { '/**': 'ours', '/settings': 'theirs' } }
        );
        expect(result.value).toEqual({ settings: { a: 2 }, other: 1 });
    });
});

describe('max and min understand ISO 8601 timestamps', () => {
    const pick = (strategy: 'max' | 'min', ours: string, theirs: string) =>
        merge3({ at: '' }, { at: ours }, { at: theirs }, { strategies: { '/at': strategy } }).value
            .at;

    it('compares fractional seconds and offsets by instant', () => {
        expect(pick('max', '2026-10-03T08:00:00Z', '2026-10-03T08:00:00.500Z')).toBe(
            '2026-10-03T08:00:00.500Z'
        );
        expect(pick('max', '2026-10-03T10:00:00+03:00', '2026-10-03T08:00:00Z')).toBe(
            '2026-10-03T08:00:00Z'
        );
        expect(pick('min', '2026-10-03T10:00:00+03:00', '2026-10-03T08:00:00Z')).toBe(
            '2026-10-03T10:00:00+03:00'
        );
        expect(pick('max', '2026-10-03T03:00:00-0500', '2026-10-03T07:30:00Z')).toBe(
            '2026-10-03T03:00:00-0500'
        );
        expect(pick('max', '2026-10-02', '2026-10-01T23:59:59Z')).toBe('2026-10-02');
    });

    it('falls back to code-unit order for other strings and for equal instants', () => {
        expect(pick('max', 'apple', 'banana')).toBe('banana');
        expect(pick('max', '2026-10-03T08:00:00Z', '2026-10-03T08:00:00.000Z')).toBe(
            '2026-10-03T08:00:00Z'
        );
    });
});

describe('replacing an array drops what was found inside it', () => {
    it('clears element conflicts when an order conflict removes the array', () => {
        const base = items({ id: 1, t: 'a' }, 2, 3);
        const ours = items(2, { id: 1, t: 'b' }, 3);
        const theirs = items({ id: 1, t: 'c' }, 3, 2);
        const removed = merge3<object>(base, ours, theirs, {
            ...byId,
            strategies: { '/items/1/t': 'ours' },
            resolve: conflict => (conflict.kind === 'order' ? { remove: true } : undefined),
        });
        expect(removed).toMatchObject({ ok: true, value: {}, conflicts: [] });
        expect(removed.resolved.map(conflict => conflict.path)).toEqual(['/items']);

        const replaced = merge3<object>(base, ours, theirs, {
            ...byId,
            resolve: conflict => (conflict.kind === 'order' ? { value: [{ id: 9 }] } : undefined),
        });
        expect(replaced).toMatchObject({ ok: true, value: { items: [{ id: 9 }] }, conflicts: [] });
    });
});

describe('id arrays are validated everywhere', () => {
    it('rejects bad ids even where the merge takes one side unchanged', () => {
        const run = (theirs: unknown) => () =>
            merge3<unknown>({ items: [{ id: 1 }] }, { items: [{ id: 1 }] }, theirs, byId);
        expect(run({ items: [{ id: 1 }, { id: 1 }] })).toThrow('theirs at /items/1: repeats id 1');
        expect(run({ items: [{ id: 1 }, 7] })).toThrow('theirs at /items/1: is not an object');
    });

    it('rejects bad ids nested inside untouched subtrees, with id-based paths', () => {
        const options: MergeOptions = {
            arrays: { '/lists': { by: 'id' }, '/lists/*/cards': { by: 'key' } },
        };
        const good = { lists: [{ id: 'a', cards: [{ key: 1 }] }] };
        const bad = { lists: [{ id: 'a', cards: [{ key: 1 }, { key: 1 }] }] };
        expect(() => merge3<unknown>(good, good, bad, options)).toThrow(
            'theirs at /lists/a/cards/1: repeats key 1'
        );
    });
});

describe('values from resolve() must fit where they land', () => {
    it('counts depth from the document root', () => {
        let deep: unknown = 1;
        for (let level = 0; level < 9; level += 1) deep = { d: deep };
        const run = () =>
            merge3(
                { o: { a: 1 } },
                { o: { a: 2 } },
                { o: { a: 3 } },
                {
                    maxDepth: 10,
                    resolve: () => ({ value: deep }) as Resolution,
                }
            );
        expect(run).toThrow('resolve() at /o/a/d/d/d/d/d/d/d/d: nested deeper than maxDepth (10)');
    });

    it('keeps elements of id arrays identifiable', () => {
        const run = (value: unknown) => () =>
            merge3<object>(items(), items({ id: 1, v: 1 }), items({ id: 1, v: 2 }), {
                ...byId,
                resolve: () => ({ value }) as Resolution,
            });
        expect(run(5)).toThrow('resolve() at /items/1: must be an object with id "1"');
        expect(run({ id: 2 })).toThrow('must be an object with id "1"');
        expect(run({ id: 1, v: 3 })().value).toEqual(items({ id: 1, v: 3 }));
        expect(run({ id: '1', v: 3 })().value).toEqual({ items: [{ id: '1', v: 3 }] });
    });

    it('checks a whole replacement array against its id rule', () => {
        const run = () =>
            merge3<object>(items(1, 2, 3), items(2, 1, 3), items(1, 3, 2), {
                ...byId,
                resolve: () => ({ value: [{ id: 5 }, { id: 5 }] }),
            });
        expect(run).toThrow('resolve() at /items/1: repeats id 5');
    });
});

describe('counter never produces a non-JSON number', () => {
    it('leaves an overflowing sum as a conflict', () => {
        const result = merge3(
            { n: 0 },
            { n: 1.7e308 },
            { n: 1.6e308 },
            {
                strategies: { '/n': 'counter' },
            }
        );
        expect(result.ok).toBe(false);
        expect(Number.isFinite(result.value.n)).toBe(true);
    });
});

describe('jsonEqual is strict about non-JSON values', () => {
    it('only equates Dates, Maps and other objects with themselves', () => {
        const date = new Date(0);
        expect(jsonEqual(new Date(0), new Date(1))).toBe(false);
        expect(jsonEqual(new Date(0), new Date(0))).toBe(false);
        expect(jsonEqual(date, date)).toBe(true);
        expect(jsonEqual(new Map([[1, 2]]), new Map())).toBe(false);
        expect(jsonEqual({ when: new Date(0) }, { when: new Date(0) })).toBe(false);
    });

    it('does not skip holes', () => {
        // eslint-disable-next-line no-sparse-arrays
        expect(jsonEqual([, 1], [2, 1])).toBe(false);
        // eslint-disable-next-line no-sparse-arrays
        expect(jsonEqual([, 1], [undefined, 1])).toBe(true);
    });
});

describe('objects from other realms', () => {
    it('accepts plain objects from a vm context and still rejects foreign Dates', () => {
        const foreign = runInNewContext('({ a: 1, nested: { list: [1, 2] } })');
        expect(merge3<unknown>({ a: 0 }, foreign, { a: 0 }).value).toBe(foreign);
        expect(() => merge3<unknown>({}, runInNewContext('({ d: new Date(0) })'), {})).toThrow(
            'ours at /d: is a Date'
        );
    });
});

describe('error messages never throw on their own', () => {
    it('reports unserializable resolutions with the conflict path', () => {
        const run = (answer: unknown) => () =>
            merge3(
                { o: { a: 1 } },
                { o: { a: 2 } },
                { o: { a: 3 } },
                {
                    resolve: () => answer as Resolution,
                }
            );
        expect(run(1n)).toThrow(MergeInputError);
        expect(run(1n)).toThrow('resolve() at /o/a: returned 1n');
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        expect(run(circular)).toThrow('resolve() at /o/a: returned an object');
        expect(run({ value: 1, extra: 2 })).toThrow('returned {"value":1,"extra":2}');
    });
});

describe('fromPointer validates its input', () => {
    it('rejects strings that are not RFC 6901 pointers', () => {
        expect(() => fromPointer('abc')).toThrow('"abc" is not a JSON Pointer');
        expect(() => fromPointer('a/b')).toThrow('is not a JSON Pointer');
        expect(() => fromPointer('/a~2')).toThrow("'~' must be escaped as '~0'");
        expect(() => fromPointer('/a~')).toThrow("'~' must be escaped as '~0'");
        expect(fromPointer('/~01')).toEqual(['~1']);
    });
});

describe('resolve() runs as a method of the options object', () => {
    it('sees the options as this, never the merge internals', () => {
        const options = {
            choice: 'theirs' as const,
            resolve(this: { choice: 'theirs' }): Resolution {
                return { use: this.choice };
            },
        };
        expect(merge3({ a: 1 }, { a: 2 }, { a: 3 }, options).value).toEqual({ a: 3 });
    });
});
