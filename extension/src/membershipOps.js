// Membership ops (Phase 9): what the extension queues and sends as `membership` on POST /api/sync/items. The server
// answers a malformed op with 422 and writes nothing, items included, so a bad op must never stay queued: it would
// stop every later sync. Pure (no chrome APIs): unit-tested by scripts/unit/membershipOps.test.mjs.

/** Why `op` can't be sent, or null: {op: "add"|"remove", collection_id: an integer from 0, ids: [item ids]}. */
export function opProblem(op) {
  if (!op || typeof op !== "object") return "not an op";
  if (op.op !== "add" && op.op !== "remove") return `unknown op ${JSON.stringify(op.op)}`;
  if (!Number.isInteger(op.collection_id) || op.collection_id < 0) {
    return `collection_id ${JSON.stringify(op.collection_id)} isn't a collection's id`;
  }
  if (!Array.isArray(op.ids) || !op.ids.length || !op.ids.every((id) => typeof id === "string" && id)) return "no item ids";
  return null;
}

/** `ops` split into those that can be sent and those that can't. */
export function splitOps(ops) {
  const good = [];
  const bad = [];
  (Array.isArray(ops) ? ops : []).forEach((op) => (opProblem(op) ? bad : good).push(op));
  return { good, bad };
}

/** `queue` without `done` (each one once, the first equal op), the rest in order. */
export function withoutOps(queue, done) {
  const left = (Array.isArray(queue) ? queue : []).slice();
  done.forEach((op) => {
    const key = JSON.stringify(op);
    const i = left.findIndex((q) => JSON.stringify(q) === key);
    if (i >= 0) left.splice(i, 1);
  });
  return left;
}

/**
 * POST `body` (the items) with `ops` as `membership`. Taken: `accept(ops)`. A 422 with ops attached: `body` again,
 * without them; if that's taken, the ops were what the server refused: `drop(ops, error)` (the items are synced).
 * If it isn't, the items are the problem: the ops stay queued and that error is thrown.
 * @param {(body: object) => Promise<any>} post
 */
export async function postWithOps(post, body, ops, { accept, drop }) {
  if (!ops.length) return post(body);
  let res;
  try {
    res = await post({ ...body, membership: ops });
  } catch (e) {
    if (e.status !== 422) throw e;
    res = await post(body);
    await drop(ops, e);
    return res;
  }
  await accept(ops);
  return res;
}
