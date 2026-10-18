import { describe, expect, it } from 'vitest';
import { merge3 } from './merge';

describe('merge3 — objects and scalars', () => {
    it('applies independent member changes from both sides', () => {
        const result = merge3({ a: 0, b: 0 }, { a: 1, b: 0 }, { a: 0, b: 2 });
        expect(result).toEqual({ ok: true, value: { a: 1, b: 2 }, conflicts: [], resolved: [] });
    });

    it('takes the one side that changed, even to another type', () => {
        expect(merge3<unknown>({ a: 1 }, { a: 1 }, { a: { nested: true } }).value).toEqual({
            a: { nested: true },
        });
        expect(merge3<unknown>({ a: 1 }, { a: 'one' }, { a: 1 }).value).toEqual({ a: 'one' });
    });

    it('accepts the same change made on both sides', () => {
        expect(merge3({ a: 1 }, { a: 2 }, { a: 2 })).toMatchObject({ ok: true, value: { a: 2 } });
        expect(merge3<object>({ a: 1, b: 1 }, { b: 1 }, { b: 1 })).toMatchObject({
            ok: true,
            value: { b: 1 },
        });
    });

    it('applies additions and deletions from either side', () => {
        const result = merge3<object>(
            { keep: 1, gone: 2 },
            { keep: 1, added: 3 },
            { keep: 1, gone: 2 }
        );
        expect(result.value).toEqual({ keep: 1, added: 3 });
        expect(merge3<object>({ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1 }).value).toEqual({ a: 1 });
    });

    it('treats null as a value, distinct from a missing member', () => {
        expect(merge3<unknown>({ a: 1 }, { a: null }, { a: 1 }).value).toEqual({ a: null });
        expect(merge3<object>({ a: null }, { a: null }, {}).value).toEqual({});
        expect(merge3<object>({}, { a: null }, { a: 1 }).conflicts).toEqual([
            { kind: 'add-add', path: '/a', ours: null, theirs: 1 },
        ]);
    });

    it('treats members set to undefined as absent', () => {
        const result = merge3<Record<string, unknown>>(
            { a: 1, b: 2 },
            { a: 1, b: undefined },
            { a: 3, b: 2 }
        );
        expect(result).toMatchObject({ ok: true, value: { a: 3 } });
        expect('b' in result.value).toBe(false);
    });

    it('merges nested objects member by member', () => {
        const base = { user: { name: 'Ann', address: { city: 'Kyiv', zip: '01001' } } };
        const ours = { user: { name: 'Anna', address: { city: 'Kyiv', zip: '01001' } } };
        const theirs = { user: { name: 'Ann', address: { city: 'Lviv', zip: '79000' } } };
        expect(merge3(base, ours, theirs).value).toEqual({
            user: { name: 'Anna', address: { city: 'Lviv', zip: '79000' } },
        });
    });

    it('compares numbers by value, so -0 equals 0', () => {
        expect(merge3({ a: 0 }, { a: -0 }, { a: 5 })).toMatchObject({ ok: true, value: { a: 5 } });
    });

    it('ignores member order when comparing objects', () => {
        const result = merge3({ o: { x: 1, y: 2 } }, { o: { y: 2, x: 1 } }, { o: { x: 1, y: 3 } });
        expect(result).toMatchObject({ ok: true, value: { o: { x: 1, y: 3 } } });
    });

    it('merges scalar roots and reports a root conflict at the empty pointer', () => {
        expect(merge3(1, 1, 2).value).toBe(2);
        expect(merge3('a', 'b', 'c')).toEqual({
            ok: false,
            value: 'b',
            conflicts: [{ kind: 'value', path: '', base: 'a', ours: 'b', theirs: 'c' }],
            resolved: [],
        });
    });
});

describe('merge3 — conflicts', () => {
    it('reports both sides changing a value differently', () => {
        expect(merge3({ title: 'Draft' }, { title: 'Ready' }, { title: 'Review' })).toEqual({
            ok: false,
            value: { title: 'Ready' },
            conflicts: [
                { kind: 'value', path: '/title', base: 'Draft', ours: 'Ready', theirs: 'Review' },
            ],
            resolved: [],
        });
    });

    it('reports a type change racing another change', () => {
        expect(merge3<unknown>({ a: 1 }, { a: 2 }, { a: 'two' }).conflicts).toEqual([
            { kind: 'type', path: '/a', base: 1, ours: 2, theirs: 'two' },
        ]);
        expect(
            merge3<unknown>({ a: { x: 1 } }, { a: [1] }, { a: { x: 2 } }).conflicts[0]?.kind
        ).toBe('type');
    });

    it('reports a delete racing an edit, from either side', () => {
        expect(merge3<object>({ a: 1 }, {}, { a: 2 }).conflicts).toEqual([
            { kind: 'delete-edit', path: '/a', base: 1, theirs: 2 },
        ]);
        expect(merge3<object>({ a: 1 }, { a: 2 }, {}).conflicts).toEqual([
            { kind: 'edit-delete', path: '/a', base: 1, ours: 2 },
        ]);
    });

    it('reports a delete racing a nested edit at the deleted member', () => {
        const result = merge3<object>({ a: { x: 1, y: 1 } }, {}, { a: { x: 2, y: 1 } });
        expect(result.conflicts).toEqual([
            { kind: 'delete-edit', path: '/a', base: { x: 1, y: 1 }, theirs: { x: 2, y: 1 } },
        ]);
    });

    it('reports two different additions of the same member', () => {
        expect(merge3<object>({}, { a: 1 }, { a: 2 }).conflicts).toEqual([
            { kind: 'add-add', path: '/a', ours: 1, theirs: 2 },
        ]);
    });

    it('fills unresolved conflicts from the preferred side', () => {
        expect(merge3({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 3, b: 5 }).value).toEqual({
            a: 2,
            b: 5,
        });
        expect(
            merge3({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 3, b: 5 }, { prefer: 'theirs' }).value
        ).toEqual({ a: 3, b: 5 });
        expect(merge3<object>({ a: 1 }, {}, { a: 2 }).value).toEqual({});
        expect(merge3<object>({ a: 1 }, {}, { a: 2 }, { prefer: 'theirs' }).value).toEqual({
            a: 2,
        });
    });

    it('sorts conflicts by path segments in UTF-16 order', () => {
        const base = { a: { b: 0 }, 'a!b': 0, z: 0, A: 0 };
        const ours = { a: { b: 1 }, 'a!b': 1, z: 1, A: 1 };
        const theirs = { a: { b: 2 }, 'a!b': 2, z: 2, A: 2 };
        expect(merge3(base, ours, theirs).conflicts.map(conflict => conflict.path)).toEqual([
            '/A',
            '/a/b',
            '/a!b',
            '/z',
        ]);
    });

    it('escapes JSON Pointer segments', () => {
        const conflict = merge3(
            { 'a/b': { '~x': 0 } },
            { 'a/b': { '~x': 1 } },
            { 'a/b': { '~x': 2 } }
        ).conflicts[0];
        expect(conflict?.path).toBe('/a~1b/~0x');
    });
});

describe('merge3 — structural sharing and safety', () => {
    it('returns the ours object itself when the result equals it', () => {
        const ours = { a: { deep: [1, 2] }, b: 2 };
        const result = merge3({ a: { deep: [1, 2] }, b: 1 }, ours, { a: { deep: [1, 2] }, b: 1 });
        expect(result.value).toBe(ours);
    });

    it('keeps untouched branches by reference', () => {
        const settings = { theme: 'dark' };
        const base = { settings: { theme: 'dark' }, title: 'a', count: 1 };
        const ours = { settings, title: 'b', count: 1 };
        const theirs = { settings: { theme: 'dark' }, title: 'a', count: 2 };
        const { value } = merge3(base, ours, theirs);
        expect(value).toEqual({ settings, title: 'b', count: 2 });
        expect(value.settings).toBe(settings);
    });

    it('never modifies its inputs', () => {
        const base = { list: [{ id: 1, v: 1 }], o: { a: 1 } };
        const ours = { list: [{ id: 1, v: 2 }], o: { a: 2 } };
        const theirs = { list: [{ id: 2, v: 1 }], o: { a: 3 } };
        const snapshot = JSON.stringify([base, ours, theirs]);
        merge3(base, ours, theirs, { arrays: { '/list': { by: 'id' } } });
        expect(JSON.stringify([base, ours, theirs])).toBe(snapshot);
    });

    it('keeps ours member order and appends members added by theirs', () => {
        const value = merge3<object>(
            { b: 1, a: 1 },
            { c: 1, b: 2, a: 1 },
            { b: 1, a: 1, d: 1 }
        ).value;
        expect(Object.keys(value)).toEqual(['c', 'b', 'a', 'd']);
    });

    it('treats __proto__ as an ordinary member without touching prototypes', () => {
        const base = JSON.parse('{"__proto__": {"x": 1}}');
        const ours = JSON.parse('{"__proto__": {"x": 1}, "a": 1}');
        const theirs = JSON.parse('{"__proto__": {"x": 2, "polluted": true}}');
        const { value } = merge3<Record<string, unknown>>(base, ours, theirs);
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
        expect(JSON.stringify(value)).toBe('{"__proto__":{"x":2,"polluted":true},"a":1}');
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('does not read inherited members such as constructor', () => {
        expect(merge3<object>({}, { constructor: 1 }, {}).value).toEqual({ constructor: 1 });
        expect(merge3<object>({ toString: 'a' }, {}, { toString: 'a' }).value).toEqual({});
    });

    it('accepts objects without a prototype', () => {
        const ours = Object.assign(Object.create(null), { a: 2 });
        expect(merge3({ a: 1 }, ours, { a: 1 }).value).toBe(ours);
    });
});
