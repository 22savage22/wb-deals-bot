import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './wb_source.mjs';

const env = {WB_SOURCE_KEY: 'test-only-key'};
const call = (path, key = env.WB_SOURCE_KEY) => worker.fetch(new Request(
  `https://wb-source.example.test${path}`,
  {headers: key ? {authorization: `Bearer ${key}`} : {}}), env);

test('rejects anonymous and malformed requests without contacting WB', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {throw new Error('Unexpected upstream request');};
  try {
    assert.equal((await call('/search?query=dress', '')).status, 401);
    assert.equal((await call('/search?query=dress', 'wrong')).status, 401);
    assert.equal((await call('/search?query=dress&target=evil')).status, 400);
    assert.equal((await call('/cards?nm=1;2;bad')).status, 400);
    assert.equal((await call('/catalog/../../evil?query=dress')).status, 400);
  } finally {
    globalThis.fetch = original;
  }
});

test('forwards only expected WB endpoints and preserves source statuses', async () => {
  const original = globalThis.fetch;
  const targets = [];
  globalThis.fetch = async target => {
    targets.push(String(target));
    return new Response(JSON.stringify({products: [{id: 42}]}), {
      status: targets.length === 2 ? 403 : 200,
      headers: {'content-type': 'application/json'},
    });
  };
  try {
    assert.equal((await call('/search?query=dress&page=1&dest=-1257786')).status, 200);
    assert.equal((await call('/catalog/platya?query=dress')).status, 403);
    assert.equal((await call('/cards?nm=42%3B43')).status, 200);
    assert.match(targets[0], /^https:\/\/search\.wb\.ru\/exactmatch\/ru\/common\/v9\/search\?/);
    assert.match(targets[1], /^https:\/\/catalog\.wb\.ru\/catalog\/platya\/catalog\?/);
    assert.match(targets[2], /^https:\/\/card\.wb\.ru\/cards\/v4\/detail\?/);
  } finally {
    globalThis.fetch = original;
  }
});
