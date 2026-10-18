import { describe, expect, it } from 'vitest';
import { MergeInputError, checkJson, identityOf, jsonEqual } from './json';
import { merge3 } from './merge';

describe('input validation', () => {
    const rejects = (value: unknown) => () => merge3<unknown>({}, value, {});

    it('names the side and the JSON Pointer of the offending value', () => {
        try {
            merge3<unknown>({}, { a: [1, { when: new Date(0) }] }, {});
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(MergeInputError);
            expect(error).toBeInstanceOf(TypeError);
            expect(error).toMatchObject({ side: 'ours', path: '/a/1/when' });
            expect((error as Error).message).toBe(
                'ours at /a/1/when: is a Date — convert it with toISOString() first'
            );
        }
    });

    it('rejects values JSON cannot represent', () => {
        expect(rejects({ a: Number.NaN })).toThrow('ours at /a: NaN, which JSON cannot represent');
        expect(rejects({ a: Infinity })).toThrow('Infinity');
        expect(rejects({ a: new Map() })).toThrow('is a Map, not a plain object');
        expect(rejects({ a: new (class Point {})() })).toThrow('is a Point, not a plain object');
        expect(rejects({ a: () => 1 })).toThrow('is a function, which is not JSON');
        expect(rejects({ a: 1n })).toThrow('is a bigint, which is not JSON');
        expect(rejects({ a: Symbol('s') })).toThrow('is a symbol');
        expect(rejects([1, undefined])).toThrow('ours at /1: is undefined (or a hole)');
        // eslint-disable-next-line no-sparse-arrays
        expect(rejects([1, , 3])).toThrow('ours at /1: is undefined (or a hole)');
        expect(() => merge3<unknown>(undefined, {}, {})).toThrow(
            'base: is undefined, which is not JSON'
        );
    });

    it('rejects circular references but accepts shared ones', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(rejects(circular)).toThrow('ours at /self: circular reference');
        const shared = { x: 1 };
        expect(merge3<unknown>({}, { a: shared, b: shared }, {}).value).toEqual({
            a: shared,
            b: shared,
        });
    });

    it('rejects nesting deeper than maxDepth', () => {
        let deep: unknown = 1;
        for (let level = 0; level < 5; level += 1) deep = { d: deep };
        expect(() => merge3<unknown>({}, deep, {}, { maxDepth: 4 })).toThrow(
            'ours at /d/d/d/d: nested deeper than maxDepth (4)'
        );
        expect(merge3<unknown>({}, deep, {}, { maxDepth: 5 }).ok).toBe(true);
    });

    it('merges documents near the default depth limit and rejects deeper ones', () => {
        const nest = (leaf: unknown, levels: number) => {
            let doc = leaf;
            for (let level = 0; level < levels; level += 1) doc = { d: doc };
            return doc;
        };
        const result = merge3<unknown>(
            nest({ x: 0, y: 0 }, 500),
            nest({ x: 1, y: 0 }, 500),
            nest({ x: 0, y: 1 }, 500)
        );
        expect(result).toMatchObject({ ok: true, value: nest({ x: 1, y: 1 }, 500) });
        expect(() => merge3<unknown>(nest(1, 600), 1, 1)).toThrow(
            'nested deeper than maxDepth (512)'
        );
    });

    it('checkJson accepts every JSON shape', () => {
        expect(() =>
            checkJson({ a: [null, true, 1.5, 'x', { b: [] }], c: undefined }, 'base', 10)
        ).not.toThrow();
    });
});

describe('jsonEqual', () => {
    it('compares JSON values deeply', () => {
        expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
        expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
        expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
        expect(jsonEqual(0, -0)).toBe(true);
        expect(jsonEqual([1, 2], [2, 1])).toBe(false);
        expect(jsonEqual([1], { 0: 1 })).toBe(false);
        expect(jsonEqual({ 0: 1 }, [1])).toBe(false);
        expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        expect(jsonEqual({ a: 1, c: 3 }, { a: 1, b: 3 })).toBe(false);
        expect(jsonEqual(null, {})).toBe(false);
        expect(jsonEqual('1', 1)).toBe(false);
    });
});

describe('identityOf', () => {
    it('gives equal JSON values equal identities and different types different ones', () => {
        expect(identityOf({ a: 1, b: [1, { c: null }] })).toBe(
            identityOf({ b: [1, { c: null }], a: 1 })
        );
        expect(identityOf(-0)).toBe(identityOf(0));
        expect(identityOf([-0])).toBe(identityOf([0]));
        const distinct = [1, '1', true, 'true', null, 'null', [1], { 1: 1 }].map(identityOf);
        expect(new Set(distinct).size).toBe(distinct.length);
    });
});
