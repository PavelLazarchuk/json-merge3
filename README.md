# json-merge3

[![npm version](https://img.shields.io/npm/v/json-merge3.svg)](https://www.npmjs.com/package/json-merge3)
[![npm downloads](https://img.shields.io/npm/dm/json-merge3.svg)](https://www.npmjs.com/package/json-merge3)

Three-way merge for JSON — `git merge`, for objects.

Two people (or a person and an AI agent, or a phone and a server) edit the same
document from the same starting point. `json-merge3` takes the common **base**
and both edits, keeps every change that does not collide, and reports the real
conflicts with JSON Pointer paths, so nobody's work is silently overwritten.

```ts
import { merge3 } from 'json-merge3';

const base = { title: 'Draft', status: 'open', likes: 10 };
const ours = { title: 'Ready', status: 'open', likes: 12 };
const theirs = { title: 'Review', status: 'closed', likes: 15 };

const result = merge3(base, ours, theirs, { strategies: { '/likes': 'counter' } });

result.value; // { title: 'Ready', status: 'closed', likes: 17 }
result.conflicts; // [{ kind: 'value', path: '/title', base: 'Draft', ours: 'Ready', theirs: 'Review' }]
```

- **Merges what can be merged** — different members, nested objects, elements of arrays matched by id.
- **Reports what cannot** — six precise conflict kinds, JSON Pointer paths, all three values. Plain JSON, ready for a `409` response.
- **Arrays done right** — keep them atomic, merge them as sets, or merge them by id with inserts, deletes and moves from both sides.
- **Settles conflicts by rule** — `counter`, `max`, `min`, `ours`, `theirs`, `base` per path, or your own `resolve` callback.
- **Structural sharing** — untouched branches keep their identity, so `React.memo` and selectors keep working.
- **Safe** — never mutates inputs, rejects non-JSON input with a path, immune to `__proto__` pollution.
- **Small** — zero dependencies, ~4.5 kB gzipped, ESM + CJS, Node 18+, browsers, Deno, Bun, Workers.

```sh
npm install json-merge3
```

## Why

Most apps resolve concurrent edits with _last write wins_: the second save
replaces the whole document and the first person's changes vanish. Real-time
CRDTs (Yjs, Automerge) fix that, but they need their own document format, sync
protocol and storage.

A three-way merge needs none of that — only the version both edits started
from, which you usually already have (a `version` column, an ETag, the snapshot
a form was opened with, the document an agent was given).

## Use cases

### Optimistic concurrency without lost updates

The client sends its edit together with the version it started from. Instead of
rejecting every stale save with `409 Conflict`, merge it — and only return
`409` when the same field really was changed by both.

```ts
app.put('/documents/:id', async c => {
    const { baseVersion, document: ours } = await c.req.json();
    const current = await db.documents.get(c.req.param('id'));
    const base = await db.documentVersions.get(c.req.param('id'), baseVersion);

    const result = merge3(base.body, ours, current.body, {
        arrays: { '/blocks': { by: 'id' } },
        strategies: { '/updatedAt': 'max' },
    });
    if (!result.ok) return c.json({ conflicts: result.conflicts }, 409);

    await db.documents.save(c.req.param('id'), result.value, current.version + 1);
    return c.json(result.value);
});
```

### AI agents editing live documents

An agent receives a snapshot, works for thirty seconds, and returns an edited
document. Meanwhile the user kept typing. Merge the agent's output into the
current state instead of overwriting the user:

```ts
const snapshot = structuredClone(state);
const proposal = await agent.edit(snapshot);

const { value, conflicts } = merge3(snapshot, state, proposal, { prefer: 'ours' });
setState(value); // the user's edits win where both touched the same field
if (conflicts.length) showReview(conflicts); // let the user accept the agent's version per field
```

### Offline drafts and sync

A form restored from a crash-safe draft, a mobile app back online, a config file
edited in two branches — merge the local copy with the server copy against the
version both started from.

## Arrays

By default an array is one value: if both sides change it differently, that is
a conflict. Choose a rule per path with `arrays`:

```ts
merge3(base, ours, theirs, {
    arrays: {
        '/tags': 'set', // unordered unique values
        '/items': { by: 'id' }, // objects identified by a member
        '/lists/*/cards': { by: 'key' }, // patterns: * is one segment, ** any number
    },
});
```

| Rule           | Behaviour                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'atomic'`     | Default. The whole array is one value.                                                                                                                                                       |
| `'set'`        | Additions and removals from both sides apply; duplicates collapse; never conflicts. Objects compare by value.                                                                                |
| `{ by: 'id' }` | Elements match by `element.id` (a string or number, unique per array). Each element merges recursively; inserts land next to their neighbours; deletes apply; a reorder by one side is kept. |

With `{ by }`, conflicts inside elements are addressed by **id, not index**:
`/items/42/title`. Ids are checked everywhere the rule applies — a duplicate or
missing id throws a `MergeInputError` even in a part of the document that did
not change.

Ordering follows a few simple rules:

- A reorder made by one side is kept. A side only counts as having reordered
  when the elements **all three versions still share** changed their relative
  order — moving an element the other side deleted is not a reorder.
- An element only one side has lands right **before its next neighbour** on that
  side, or at the end when nothing follows it. So an item appended to the end
  stays last, and when both sides insert at the same spot, ours come first.
- If both sides reorder the shared elements differently, you get one `order`
  conflict for the whole array.

`'set'` and `{ by }` also apply when both sides hold an array but the base did
not — say, a `tags` field both sides added — the merge then starts from `[]`.

## Conflicts

```ts
interface Conflict {
    kind: 'value' | 'type' | 'add-add' | 'delete-edit' | 'edit-delete' | 'order';
    path: string; // RFC 6901 JSON Pointer, '' for the root
    base?: Json; // a side with nothing there is left out
    ours?: Json;
    theirs?: Json;
}
```

| Kind          | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `value`       | Both sides changed the value differently, same type.        |
| `type`        | Both sides changed it and the types no longer agree.        |
| `add-add`     | The member is new on both sides, with different values.     |
| `delete-edit` | Ours deleted it, theirs changed it.                         |
| `edit-delete` | Ours changed it, theirs deleted it.                         |
| `order`       | Both sides reordered an id-merged array, in different ways. |

Conflicts come sorted by path, segment by segment in UTF-16 order. `result.value`
is always a complete document: unresolved conflicts take the `prefer` side
(`'ours'` by default), so you can show a preview and let the user pick.

## Settling conflicts automatically

`strategies` settle conflicts at a path **and everything below it**. When several
patterns cover a conflict, the one with more literal segments wins, then the one
matching deeper, then the one with fewer `**` — so a `'/**'` catch-all never
overrides a rule written for a subtree.

```ts
merge3(base, ours, theirs, {
    strategies: {
        '/likes': 'counter', // 10 → 12 and 10 → 15 gives 17
        '/updatedAt': 'max', // the later ISO timestamp
        '/settings': 'theirs', // anything under settings: take theirs
        '/settings/theme': 'ours', // …except the theme
    },
});
```

| Strategy                       | Settles                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'ours'`, `'theirs'`, `'base'` | Any conflict, by taking that side (which may mean deleting the member).                                                                             |
| `'max'`, `'min'`               | Two numbers or two strings. ISO 8601 timestamps compare by instant, honouring fractions and offsets. Works when the base was `null` or missing too. |
| `'counter'`                    | Two numbers: `base + (ours − base) + (theirs − base)`; a missing or non-number base counts as 0.                                                    |

Anything a strategy cannot handle — say, `max` on a deletion — goes to
`resolve`, your own callback:

```ts
merge3(base, ours, theirs, {
    resolve(conflict) {
        if (conflict.path.endsWith('/description')) {
            return { value: `${conflict.ours}\n\n${conflict.theirs}` };
        }
        // return { use: 'ours' | 'theirs' | 'base' }, { value }, { remove: true },
        // or undefined to leave it in result.conflicts
    },
});
```

`resolve` is called as a method of the options object, so `this` works as you
would expect. A `{ value }` it returns must fit where it lands: it counts toward
`maxDepth` from the document root, and replacing an element of an id-merged
array requires an object with that element's id. Replacing or removing a whole
array (say, to settle an `order` conflict) also drops whatever conflicts were
found inside it.

Settled conflicts are listed in `result.resolved`, with the resolution and
whether a strategy or `resolve` made it — useful for audit logs.

## API

### `merge3(base, ours, theirs, options?)`

Returns `{ ok, value, conflicts, resolved }`.

| Option       | Default  | Description                                          |
| ------------ | -------- | ---------------------------------------------------- |
| `prefer`     | `'ours'` | Which side fills in unresolved conflicts in `value`. |
| `arrays`     | `{}`     | Array rules by path pattern.                         |
| `strategies` | `{}`     | Conflict strategies by path pattern.                 |
| `resolve`    | —        | Callback for conflicts no strategy settled.          |
| `maxDepth`   | `512`    | Inputs nested deeper than this are rejected.         |

Inputs must be JSON values: plain objects, arrays, strings, finite numbers,
booleans and `null`. Object members set to `undefined` count as absent. Anything
else — a `Date`, a `Map`, `NaN`, a cycle, a hole in an array — throws a
`MergeInputError` naming the side and the path:

```
MergeInputError: ours at /items/3/createdAt: is a Date — convert it with toISOString() first
```

Plain objects from another realm — an iframe, a `vm` context, a test environment
— are accepted like any other.

`merge3` never modifies its inputs. The result shares unchanged branches with
`ours` (and `theirs`), so treat it as immutable, like any state you get back from
Immer or Redux.

Merging is linear in the size of the documents: equality checks are remembered
for the duration of a call, and id-merged arrays place insertions in one pass.

### `jsonEqual(a, b)`

Deep JSON equality: member order does not matter, `undefined` members count as
absent, `0` equals `-0`, holes in arrays are not skipped. Values JSON cannot
hold — a `Date`, a `Map` — are only equal to themselves. Tree-shakes to a few
hundred bytes.

### `toPointer(segments)` / `fromPointer(pointer)`

Convert between path segments and RFC 6901 JSON Pointers, with `~0` / `~1`
escaping. `fromPointer` throws a `TypeError` for strings that are not pointers.

## Relation to the IETF draft

[draft-jurkovikj-json-three-way-merge](https://datatracker.ietf.org/doc/draft-jurkovikj-json-three-way-merge/)
(August 2026) specifies a deterministic three-way merge for JSON objects and
scalars. For documents without arrays, `json-merge3` follows the same rules — the
same equality, presence matrix and path ordering — and its conflict kinds map
one to one:

| Draft                       | json-merge3   |
| --------------------------- | ------------- |
| `concurrent_value_change`   | `value`       |
| `concurrent_type_change`    | `type`        |
| `add_add`                   | `add-add`     |
| `source_delete_target_edit` | `delete-edit` |
| `source_edit_target_delete` | `edit-delete` |

Where it goes further: the draft rejects any document containing an array and
returns no value at all when there is a conflict. `json-merge3` merges arrays by
rule and always returns a complete preview next to the conflicts.

## Compared to

|                                  | json-merge3                    | trimerge                        | jsondiffpatch   | Yjs / Automerge  |
| -------------------------------- | ------------------------------ | ------------------------------- | --------------- | ---------------- |
| Three-way merge of plain JSON    | ✅                             | ✅                              | ❌ (diff/patch) | ❌ (own format)  |
| All conflicts, with paths        | ✅ list + preview value        | ❌ throws on the first one      | —               | — (no conflicts) |
| Arrays merged by id              | ✅ declarative                 | ✅ via `trimergeArrayCreator`   | —               | ✅               |
| Per-path rules                   | ✅ patterns + strategies       | ✅ by composing merge functions | —               | —                |
| Merging edits inside one string  | ❌ bring your own in `resolve` | ✅ diff3                        | —               | ✅               |
| Works with your existing storage | ✅                             | ✅                              | ✅              | ❌               |
| Maintained                       | ✅                             | ❌ (alpha, last release 2021)   | ✅              | ✅               |

## License

MIT
