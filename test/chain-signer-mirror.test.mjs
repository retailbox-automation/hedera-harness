import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { readMirrorAccount, TESTNET_MIRROR_URL } = await import(
  pathToFileURL(path.resolve("dist/validation/chainSigner.js")).href
);

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

test("readMirrorAccount reads the balance from the mirror accounts endpoint", async () => {
  const f = fakeFetch(200, { account: "0.0.7", deleted: false, balance: { balance: 9_930_000_000 } });
  assert.deepEqual(await readMirrorAccount("0.0.7", f.impl), { state: "alive", tinybars: 9_930_000_000n });
  assert.deepEqual(f.calls, [`${TESTNET_MIRROR_URL}/api/v1/accounts/0.0.7?transactions=false`]);
});

test("a zero balance is alive, not deleted", async () => {
  const f = fakeFetch(200, { deleted: false, balance: { balance: 0 } });
  assert.deepEqual(await readMirrorAccount("0.0.7", f.impl), { state: "alive", tinybars: 0n });
});

test("a balance above 2^53 is read exactly, not rounded", async () => {
  const impl = async () =>
    new Response('{"deleted":false,"balance":{"balance":3388222396598749099,"tokens":[]}}', { status: 200 });
  assert.deepEqual(await readMirrorAccount("0.0.2", impl), { state: "alive", tinybars: 3388222396598749099n });
});

test("404 and deleted:true both mean the signer is gone", async () => {
  assert.deepEqual(await readMirrorAccount("0.0.7", fakeFetch(404, {}).impl), { state: "deleted" });
  const swept = fakeFetch(200, { deleted: true, balance: { balance: 0 } });
  assert.deepEqual(await readMirrorAccount("0.0.7", swept.impl), { state: "deleted" });
});

test("other mirror errors throw instead of recreating the signer", async () => {
  for (const status of [429, 500, 503]) {
    await assert.rejects(readMirrorAccount("0.0.7", fakeFetch(status, {}).impl), new RegExp(`HTTP ${status}`));
  }
});

test("a body without an integer balance throws instead of guessing 0", async () => {
  for (const body of [{}, { balance: null }, { balance: {} }, { balance: { balance: "5" } }, { balance: { balance: -1 } }, { balance: { balance: 1.5 } }]) {
    await assert.rejects(readMirrorAccount("0.0.7", fakeFetch(200, body).impl), /no balance/);
  }
});

test("a malformed account id is rejected before any request", async () => {
  for (const bad of ["", "0.0", "../../api/v1/network", "0.0.7?x=1", " 0.0.7"]) {
    const f = fakeFetch(200, { balance: { balance: 1 } });
    await assert.rejects(readMirrorAccount(bad, f.impl), /invalid account id/);
    assert.deepEqual(f.calls, []);
  }
});

test("no consensus-node AccountBalanceQuery left in src (removed in consensus node v0.77)", async () => {
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.ts$/.test(entry.name)) {
        const code = (await readFile(full, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        if (/(?<!MirrorNode)AccountBalanceQuery/.test(code)) offenders.push(full);
      }
    }
  }
  await walk(path.resolve("src"));
  assert.deepEqual(offenders, []);
});

test("the guard regex fires on a real call and ignores the mirror query", () => {
  const re = /(?<!MirrorNode)AccountBalanceQuery/;
  assert.ok(re.test("await new sdk.AccountBalanceQuery()"));
  assert.ok(!re.test("await new sdk.MirrorNodeAccountBalanceQuery()"));
});

test("live: testnet mirror read is free and keyless", { skip: process.env.HARNESS_LIVE_MIRROR !== "1" }, async () => {
  const alive = await readMirrorAccount("0.0.2");
  assert.equal(alive.state, "alive");
  assert.ok(alive.tinybars > BigInt(Number.MAX_SAFE_INTEGER));
  assert.deepEqual(await readMirrorAccount("0.0.999999999"), { state: "deleted" });
});
