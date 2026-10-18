import { toPointer } from './path';
import type { Json } from './types';

export const MISSING: unique symbol = Symbol('missing');
export type Slot = Json | typeof MISSING;

export type JsonObject = { readonly [key: string]: Json | undefined };

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

export function isPlainObject(value: unknown): value is JsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
}

export function memberOf(object: JsonObject, key: string): Slot {
    if (!hasOwn(object, key)) return MISSING;
    const value = object[key];
    return value === undefined ? MISSING : value;
}

export function setMember(object: Record<string, Json>, key: string, value: Json): void {
    if (key === '__proto__') {
        Object.defineProperty(object, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    } else {
        object[key] = value;
    }
}

export function memberKeys(object: JsonObject): string[] {
    return Object.keys(object).filter(key => object[key] !== undefined);
}

export type JsonKind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

export const kindOf = (value: Json): JsonKind =>
    value === null
        ? 'null'
        : Array.isArray(value)
          ? 'array'
          : (typeof value as 'boolean' | 'number' | 'string' | 'object');

export type Equality = (a: unknown, b: unknown) => boolean;

function compareObjects(a: object, b: object, equal: Equality): boolean {
    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);
    if (aIsArray || bIsArray) {
        if (!aIsArray || !bIsArray || a.length !== b.length) return false;
        for (let index = 0; index < a.length; index += 1) {
            if (!equal(a[index], b[index])) return false;
        }
        return true;
    }
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = memberKeys(a);
    if (keys.length !== memberKeys(b).length) return false;
    for (const key of keys) {
        const other = memberOf(b, key);
        if (other === MISSING || !equal(a[key], other)) return false;
    }
    return true;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    return compareObjects(a, b, jsonEqual);
}

export function memoizedEqual(): Equality {
    const memo = new WeakMap<object, WeakMap<object, boolean>>();
    const equal: Equality = (a, b) => {
        if (a === b) return true;
        if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
            return false;
        }
        let row = memo.get(a);
        const known = row?.get(b);
        if (known !== undefined) return known;
        const result = compareObjects(a, b, equal);
        if (!row) {
            row = new WeakMap();
            memo.set(a, row);
        }
        row.set(b, result);
        return result;
    };
    return equal;
}

export class MergeInputError extends TypeError {
    readonly side: string;
    readonly path: string;

    constructor(side: string, path: readonly string[], message: string) {
        const pointer = toPointer(path);
        super(`${side}${pointer === '' ? '' : ` at ${pointer}`}: ${message}`);
        this.name = 'MergeInputError';
        this.side = side;
        this.path = pointer;
    }
}

const withArticle = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

function describe(value: unknown): string {
    if (Object.prototype.toString.call(value) === '[object Date]') {
        return 'a Date — convert it with toISOString() first';
    }
    if (typeof value === 'object' && value !== null) {
        const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;
        return `${withArticle(typeof name === 'string' && name !== '' ? name : 'exotic object')}, not a plain object`;
    }
    if (typeof value === 'number') return `${value}, which JSON cannot represent`;
    return `${value === undefined ? 'undefined' : withArticle(typeof value)}, which is not JSON`;
}

function stringifyOrUndefined(value: unknown): string | undefined {
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
}

export function preview(value: unknown): string {
    const text = stringifyOrUndefined(value);
    if (text !== undefined) return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    return typeof value === 'bigint' ? `${value}n` : withArticle(typeof value);
}

export function checkJson(
    value: unknown,
    side: string,
    maxDepth: number,
    at: readonly string[] = []
): void {
    const path = [...at];
    const open = new Set<object>();

    const walk = (current: unknown): void => {
        switch (typeof current) {
            case 'string':
            case 'boolean':
                return;
            case 'number':
                if (!Number.isFinite(current)) {
                    throw new MergeInputError(side, path, describe(current));
                }
                return;
            case 'object': {
                if (current === null) return;
                if (path.length >= maxDepth) {
                    throw new MergeInputError(
                        side,
                        path,
                        `nested deeper than maxDepth (${maxDepth})`
                    );
                }
                if (open.has(current)) throw new MergeInputError(side, path, 'circular reference');
                if (!Array.isArray(current) && !isPlainObject(current)) {
                    throw new MergeInputError(side, path, `is ${describe(current)}`);
                }
                open.add(current);
                if (Array.isArray(current)) {
                    for (let index = 0; index < current.length; index += 1) {
                        path.push(String(index));
                        const item: unknown = current[index];
                        if (item === undefined) {
                            throw new MergeInputError(
                                side,
                                path,
                                'is undefined (or a hole), which is not JSON'
                            );
                        }
                        walk(item);
                        path.pop();
                    }
                } else {
                    for (const key of memberKeys(current)) {
                        path.push(key);
                        walk(current[key]);
                        path.pop();
                    }
                }
                open.delete(current);
                return;
            }
            default:
                throw new MergeInputError(side, path, `is ${describe(current)}`);
        }
    };

    walk(value);
}

export function identityOf(value: Json): string {
    if (value === null || typeof value !== 'object') {
        return `${typeof value}:${typeof value === 'number' && value === 0 ? 0 : String(value)}`;
    }
    return `json:${stableStringify(value)}`;
}

function stableStringify(value: Json): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === 0 ? 0 : value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const object = value as JsonObject;
    return `{${memberKeys(object)
        .sort()
        .map(key => `${JSON.stringify(key)}:${stableStringify(object[key] as Json)}`)
        .join(',')}}`;
}
