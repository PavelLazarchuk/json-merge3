import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const load = specifier => import(new URL(specifier, import.meta.url).href);

const [major] = process.versions.node.split('.').map(Number);
assert.ok(major >= 18, `expected Node >= 18, got ${process.versions.node}`);

const { merge3, jsonEqual, MergeInputError, toPointer, fromPointer } =
    await load('../dist/index.js');

const base = { title: 'Draft', likes: 10, tags: ['a', 'b'], items: [{ id: 1, done: false }] };
const ours = { title: 'Ready', likes: 12, tags: ['a', 'b', 'c'], items: [{ id: 1, done: true }] };
const theirs = {
    title: 'Review',
    likes: 15,
    tags: ['b'],
    items: [
        { id: 1, done: false },
        { id: 2, done: false },
    ],
};

const result = merge3(base, ours, theirs, {
    arrays: { '/tags': 'set', '/items': { by: 'id' } },
    strategies: { '/likes': 'counter' },
});
assert.equal(result.ok, false, 'the title conflict went unreported');
assert.deepEqual(result.value, {
    title: 'Ready',
    likes: 17,
    tags: ['b', 'c'],
    items: [
        { id: 1, done: true },
        { id: 2, done: false },
    ],
});
assert.deepEqual(result.conflicts, [
    { kind: 'value', path: '/title', base: 'Draft', ours: 'Ready', theirs: 'Review' },
]);
assert.deepEqual(
    JSON.parse(JSON.stringify(result.conflicts)),
    result.conflicts,
    'conflicts did not survive JSON'
);
assert.equal(result.resolved[0]?.path, '/likes');

const settings = { theme: 'dark' };
const shared = merge3({ settings, n: 1 }, { settings, n: 2 }, { settings, n: 1 });
assert.equal(shared.value.settings, settings, 'an untouched branch lost its identity');

assert.equal(jsonEqual({ a: 1, b: [2] }, { b: [2], a: 1 }), true);
assert.equal(toPointer(['a/b', '~']), '/a~1b/~0');
assert.deepEqual(fromPointer('/a~1b/~0'), ['a/b', '~']);
assert.throws(() => merge3({}, { when: new Date() }, {}), MergeInputError);

const polluted = merge3({}, JSON.parse('{"__proto__": {"admin": true}}'), {});
assert.equal(Object.getPrototypeOf(polluted.value), Object.prototype, 'a prototype was replaced');
assert.equal({}.admin, undefined, 'Object.prototype was polluted');

const cjs = require('../dist/index.cjs');
assert.equal(typeof cjs.merge3, 'function');
assert.deepEqual(
    Object.keys(cjs).sort(),
    Object.keys(await load('../dist/index.js')).sort(),
    'CJS and ESM entry points disagree'
);
assert.deepEqual(cjs.merge3({ a: 0, b: 0 }, { a: 1, b: 0 }, { a: 0, b: 2 }).value, { a: 1, b: 2 });

console.log(`smoke: ok on Node ${process.versions.node}`);
