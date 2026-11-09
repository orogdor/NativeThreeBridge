import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { deserialize, serialize } from 'node:v8';

const shim = readFileSync(new URL('../js/webapp-shim.js', import.meta.url), 'utf8');

test('world records commit in a later task, retain typed arrays and survive a new host', () => {
  const files = new Map();
  function host() {
    const context = createContext({ __nt: {
      log() {},
      storageRead: (key) => files.has(key) ? deserialize(files.get(key)) : undefined,
      storageClone: (value) => deserialize(serialize(value)),
      storageWrite(key, value, revision) {
        assert.equal(files.has(key) ? deserialize(files.get(key)).revision : 0, revision);
        files.set(key, serialize(value));
      },
    } });
    runInContext(shim, context);
    return context;
  }

  const first = host();
  runInContext(`
    const open = indexedDB.open('test-world', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('worlds');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('worlds', 'readwrite');
      const heights = new Float32Array([1.5, 3]);
      tx.objectStore('worlds').put({ heights }, 'world');
      heights[0] = 99;
      tx.oncomplete = () => {
        localStorage.setItem('save', 'world');
        sessionStorage.setItem('session', 'temporary');
      };
    };
  `, first);
  assert.equal(files.size, 0);
  first.__ntHost.frame(16);
  assert.equal(files.size, 1, 'opening and upgrading did not commit the queued record');
  first.__ntHost.frame(32);
  assert.equal(files.size, 2);

  const second = host();
  assert.equal(second.localStorage.getItem('save'), 'world');
  assert.equal(second.sessionStorage.getItem('session'), null);
  runInContext(`
    const open = indexedDB.open('test-world');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('worlds', 'readwrite');
      tx.objectStore('worlds').delete('world');
      tx.abort();
      tx.onabort = () => {
        const read = db.transaction('worlds').objectStore('worlds').get('world');
        read.onsuccess = () => { globalThis.loaded = read.result.heights; };
      };
    };
  `, second);
  second.__ntHost.frame(16);
  second.__ntHost.frame(32);
  second.__ntHost.frame(48);
  assert.equal(Object.prototype.toString.call(second.loaded), '[object Float32Array]');
  assert.deepEqual(Array.from(second.loaded), [1.5, 3]);
  assert.deepEqual(JSON.parse(second.__ntHost.status()).errors, []);
});
