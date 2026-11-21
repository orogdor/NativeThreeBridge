// Classic worker: transferred buffer, shared memory, timers, importScripts.
importScripts('./lib/helper.js');

self.addEventListener('message', ({ data }) => {
  if (data.type !== 'sum') return;
  const numbers = new Float32Array(data.buffer);
  let sum = 0;
  for (const n of numbers) sum += n;
  Atomics.store(data.shared, 0, 42);
  postMessage({ type: 'sum', sum, name: self.name });
  setTimeout(() => postMessage({ type: 'timer' }), 5);
  postMessage({ type: 'import', value: helper(7) });
});

self.onerror = (message) => {
  postMessage({ type: 'error', message: String(message) });
};
