// Unit tests for the extension's membership ops (extension/src/membershipOps.js): a malformed op is never queued
// or sent, and a 422 caused by one never stops item syncing. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { opProblem, splitOps, withoutOps, postWithOps } from "../../extension/src/membershipOps.js";

const add = (collection_id, ids = ["t1"]) => ({ op: "add", collection_id, ids });

test("opProblem: add/remove, an integer collection id from 0, item ids", () => {
  assert.equal(opProblem(add(0)), null);
  assert.equal(opProblem({ op: "remove", collection_id: 7, ids: ["a2", "t3"] }), null);
  assert.match(opProblem({ op: "move", collection_id: 1, ids: ["t1"] }), /unknown op "move"/);
  assert.match(opProblem(add(NaN)), /collection_id null/); // JSON shows NaN as null, as the server would see it
  assert.match(opProblem(add(null)), /collection_id null/);
  assert.match(opProblem(add("3")), /collection_id "3"/);
  assert.match(opProblem(add(-1)), /collection_id -1/);
  assert.match(opProblem(add(1.5)), /collection_id 1.5/);
  assert.equal(opProblem(add(1, [])), "no item ids");
  assert.equal(opProblem(add(1, [42])), "no item ids");
  assert.equal(opProblem(add(1, [""])), "no item ids");
  assert.equal(opProblem(null), "not an op");
});

test("splitOps keeps the good ones in order", () => {
  const ops = [add(0), add(NaN), { op: "remove", collection_id: 2, ids: ["t9"] }, { op: "x" }];
  assert.deepEqual(splitOps(ops), { good: [ops[0], ops[2]], bad: [ops[1], ops[3]] });
  assert.deepEqual(splitOps(undefined), { good: [], bad: [] });
});

test("withoutOps removes each done op once and keeps the rest in order", () => {
  const a = add(1, ["t1"]);
  const b = add(2, ["t2"]);
  const queue = [a, b, { ...a }, add(3)];
  assert.deepEqual(withoutOps(queue, [a]), [b, a, add(3)]);
  assert.deepEqual(withoutOps(queue, [b, add(9)]), [a, a, add(3)]);
});

// A stand-in for POST /api/sync/items: 422 (nothing written) while `refuse(body)` says so.
function server(refuse) {
  const calls = [];
  const post = async (body) => {
    calls.push(body);
    if (refuse(body)) throw Object.assign(new Error("HTTP 422"), { status: 422 });
    return { ok: true, items: Object.keys(body.items || {}).length };
  };
  return { post, calls };
}
const items = { items: { t1: { id: "t1" } }, deleted: [], full: false };

test("postWithOps: no ops: the items alone", async () => {
  const s = server(() => false);
  const seen = [];
  await postWithOps(s.post, items, [], { accept: (o) => seen.push(["accept", o]), drop: (o) => seen.push(["drop", o]) });
  assert.deepEqual(s.calls, [items]);
  assert.deepEqual(seen, []);
});

test("postWithOps: ops taken: one request, accepted", async () => {
  const s = server(() => false);
  const ops = [add(0)];
  const seen = [];
  await postWithOps(s.post, items, ops, { accept: (o) => seen.push(["accept", o]), drop: (o) => seen.push(["drop", o]) });
  assert.deepEqual(s.calls, [{ ...items, membership: ops }]);
  assert.deepEqual(seen, [["accept", ops]]);
});

test("postWithOps: a 422 because of an op: the items go without it, and the ops are dropped (not accepted)", async () => {
  const s = server((body) => (body.membership || []).some((op) => opProblem(op)));
  const ops = [add(0), { op: "add", collection_id: null, ids: ["t1"] }];
  const seen = [];
  const res = await postWithOps(s.post, items, ops, {
    accept: (o) => seen.push(["accept", o]),
    drop: (o, e) => seen.push(["drop", o, e.status]),
  });
  assert.deepEqual(s.calls, [{ ...items, membership: ops }, items], "sent again without the ops");
  assert.deepEqual(res, { ok: true, items: 1 }, "the items synced");
  assert.deepEqual(seen, [["drop", ops, 422]]);
});

test("postWithOps: a 422 the items cause too: thrown, and the ops stay queued", async () => {
  const s = server(() => true);
  const seen = [];
  await assert.rejects(
    postWithOps(s.post, items, [add(0)], { accept: (o) => seen.push(["accept", o]), drop: (o) => seen.push(["drop", o]) }),
    /422/
  );
  assert.equal(s.calls.length, 2);
  assert.deepEqual(seen, [], "neither dropped nor accepted");
});

test("postWithOps: the server away (no status): thrown, nothing dropped", async () => {
  const post = async () => {
    throw new Error("fetch failed");
  };
  const seen = [];
  await assert.rejects(postWithOps(post, items, [add(0)], { accept: () => seen.push("accept"), drop: () => seen.push("drop") }), /fetch failed/);
  assert.deepEqual(seen, []);
});
