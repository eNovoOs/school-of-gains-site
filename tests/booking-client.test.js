const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require('node:path').join(__dirname, '../src/acquisition/book.js'), 'utf8');
async function run(ref, response) {
  const elements = {};
  const document = { querySelector(id) { return elements[id] ||= { textContent: '', hidden: true, addEventListener() {} }; } };
  const calls = [];
  vm.runInNewContext(script, { document, location: { search: '?ref=' + ref }, URLSearchParams, fetch: async (url, config) => { calls.push({ url, config }); return { ok: response.ok, status: response.status, json: async () => response.body }; } });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, calls };
}
test('missing reference does not request a booking or claim application success', async () => {
  const r = await run('', {});
  assert.equal(r.calls.length, 0);
  assert.equal(r.elements['#booking-restart'].hidden, false);
  assert.match(r.elements['#booking-heading'].textContent, /Start/);
});
test('verified application explicitly remains unbooked with disabled integration', async () => {
  const r = await run('opaque_signed_reference_123456789', { ok: true, status: 200, body: { ok: true, bookingEnabled: false } });
  assert.match(r.elements['#booking-heading'].textContent, /received/);
  assert.match(r.elements['#booking-detail'].textContent, /No appointment has been booked/);
  assert.equal(r.calls[0].config.cache, 'no-store');
  assert.equal(r.calls.length, 1);
});
test('expired context never presents a saved application or a booking', async () => {
  const r = await run('opaque_signed_reference_123456789', { ok: false, status: 401, body: {} });
  assert.match(r.elements['#booking-heading'].textContent, /no longer available/);
  assert.equal(r.elements['#booking-refresh'].hidden, false);
});
async function interactive(responses) {
  const elements = {};
  const calls = [];
  const slotTime = new Date(Date.now() + 86400000).toISOString();
  const slot = { dataset: { slot: slotTime }, setAttribute() {} };
  const document = { querySelector(id) { return elements[id] ||= { textContent: '', innerHTML: '', hidden: true, handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; }, querySelectorAll() { return [slot]; } }; } };
  const fetch = async (url, config) => {
    calls.push({ url, config });
    const response = url.startsWith('/api/booking-context') ? { ok: true, status: 200, body: { ok: true, bookingEnabled: true, existingBooking: responses.existing || null } } : url.startsWith('/api/booking-slots') ? { ok: true, status: 200, body: { ok: true, slots: [slotTime] } } : responses.posts.shift();
    return { ok: response.ok, status: response.status, json: async () => response.body };
  };
  vm.runInNewContext(script, { document, location: { search: '?ref=opaque_signed_reference_123456789' }, URLSearchParams, crypto: require('node:crypto'), fetch });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, calls, slotTime, async choose() { await elements['#booking-slots'].handlers.click({ target: { closest() { return slot; } } }); }, async confirm() { await elements['#confirm-booking'].handlers.click(); } };
}
test('stale slot refreshes availability and permits another selection without success', async () => {
  const r = await interactive({ posts: [{ ok: false, status: 409, body: { ok: false, error: 'slot_unavailable' } }] });
  await r.choose(); await r.confirm();
  assert.match(r.elements['#booking-error'].textContent, /no longer available/);
  assert.equal(r.elements['#booking-timezone'].disabled, false);
  assert.notEqual(r.elements['#booking-heading'].textContent, 'Your call is booked.');
  assert.equal(r.calls.filter(c => c.url.startsWith('/api/booking-slots')).length, 2);
});
test('pending booking locks selection and retries identical request before verified success', async () => {
  const time = new Date(Date.now() + 86400000).toISOString();
  const r = await interactive({ posts: [{ ok: true, status: 202, body: { ok: true, booked: false, pending: true } }, { ok: true, status: 200, body: { ok: true, booked: true, appointmentId: 'verified-appointment', startTime: time } }] });
  await r.choose(); await r.confirm();
  assert.equal(r.elements['#booking-timezone'].disabled, true);
  assert.equal(r.elements['#confirm-booking'].textContent, 'Check confirmation');
  assert.notEqual(r.elements['#booking-heading'].textContent, 'Your call is booked.');
  await r.confirm();
  const posts = r.calls.filter(c => c.url === '/api/bookings');
  assert.equal(posts[0].config.body, posts[1].config.body);
  assert.equal(r.elements['#booking-heading'].textContent, 'Your call is booked.');
  assert.equal(r.elements['#booking-picker'].hidden, true);
});
test('reload restores previous pending booking ID instead of creating a new request', async () => {
  const id = require('node:crypto').randomUUID();
  const time = new Date(Date.now() + 86400000).toISOString();
  const r = await interactive({ existing: { bookingId: id, startTime: time, timezone: 'UTC', state: 'pending', canRetry: true }, posts: [{ ok: true, status: 202, body: { ok: true, pending: true } }] });
  await r.confirm();
  const request = JSON.parse(r.calls.find(c => c.url === '/api/bookings').config.body);
  assert.equal(request.bookingId, id);
  assert.equal(request.startTime, time);
  assert.equal(r.calls.some(c => c.url.startsWith('/api/booking-slots')), false);
});
test('existing appointment conflict blocks new slot choices', async () => {
  const r = await interactive({ posts: [{ ok: false, status: 409, body: { ok: false, error: 'appointment_already_exists' } }] });
  await r.choose(); await r.confirm();
  assert.equal(r.elements['#confirm-booking'].hidden, true);
  assert.equal(r.elements['#booking-timezone'].disabled, true);
  assert.match(r.elements['#booking-error'].textContent, /sales team/);
});
