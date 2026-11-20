// Dress colour analysis on synthetic photos (no camera, no model): a drawn person with known colours.
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, classify } = require('../docs/dress.js');

const W = 640, H = 360;
// A standing person, about 60% of the frame height, in normalised coordinates.
const P = { ls: [0.46, 0.25], rs: [0.54, 0.25], lh: [0.47, 0.50], rh: [0.53, 0.50], lk: [0.47, 0.66], rk: [0.53, 0.66], la: [0.47, 0.82], ra: [0.53, 0.82],
  lheel: [0.465, 0.84], rheel: [0.535, 0.84], lf: [0.445, 0.86], rf: [0.555, 0.86] };
const IDX = { ls: 11, rs: 12, lh: 23, rh: 24, lk: 25, rk: 26, la: 27, ra: 28, lheel: 29, rheel: 30, lf: 31, rf: 32 };
function landmarks(vis = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.1, visibility: 0.9 }));
  Object.keys(P).forEach(k => { lm[IDX[k]] = { x: P[k][0], y: P[k][1], visibility: vis[k] === undefined ? 0.95 : vis[k] }; });
  return lm;
}
function photo({ top = [245, 245, 245], coat = null, legs = [20, 20, 22], shoes = [15, 15, 15], belt = [25, 20, 18], wall = [180, 170, 150] }) {
  const data = new Uint8ClampedArray(W * H * 4);
  const rect = (x0, y0, x1, y1, c) => { for (let y = Math.floor(y0 * H); y < y1 * H; y++) for (let x = Math.floor(x0 * W); x < x1 * W; x++) { const i = (y * W + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; } };
  rect(0, 0, 1, 1, wall);
  rect(0.44, 0.24, 0.56, 0.50, top);
  if (coat) { rect(0.44, 0.24, 0.485, 0.50, coat); rect(0.515, 0.24, 0.56, 0.50, coat); } // open coat: white shows in the middle
  if (belt) rect(0.45, 0.47, 0.55, 0.50, belt);
  rect(0.45, 0.50, 0.495, 0.83, legs); rect(0.505, 0.50, 0.55, 0.83, legs);
  rect(0.43, 0.83, 0.49, 0.875, shoes); rect(0.51, 0.83, 0.57, 0.875, shoes);
  return { width: W, height: H, data };
}

test('colour classes', () => {
  assert.equal(classify(250, 250, 250), 'white');
  assert.equal(classify(20, 20, 25), 'dark');
  assert.equal(classify(200, 40, 40), 'other');
  assert.equal(classify(120, 120, 120), 'other');
});

test('correct uniform: everything OK', () => {
  assert.deepEqual(analyze(photo({}), landmarks()), { top: 'ok', trousers: 'ok', shoes: 'ok', belt: 'ok' });
});

test('a black coat over the white shirt is OK', () => {
  assert.equal(analyze(photo({ coat: [18, 18, 18] }), landmarks()).top, 'ok');
  assert.equal(analyze(photo({ top: [18, 18, 18] }), landmarks()).top, 'ok'); // coat closed
});

test('a coloured top, blue jeans and white shoes are each flagged', () => {
  assert.equal(analyze(photo({ top: [200, 40, 40] }), landmarks()).top, 'issue');
  assert.equal(analyze(photo({ legs: [70, 100, 160] }), landmarks()).trousers, 'issue');
  assert.equal(analyze(photo({ shoes: [240, 240, 240] }), landmarks()).shoes, 'issue');
  const one = analyze(photo({ shoes: [240, 240, 240] }), landmarks());
  assert.deepEqual([one.top, one.trousers], ['ok', 'ok']); // only the shoes
});

test('no belt band is only a hint (the server never flags on the belt alone)', () => {
  assert.equal(analyze(photo({ belt: null }), landmarks()).belt, 'issue');
});

test('a body part the model cannot see is "unknown", never a guess', () => {
  const r = analyze(photo({ shoes: [240, 240, 240] }), landmarks({ lf: 0.1, rf: 0.1 }));
  assert.equal(r.shoes, 'unknown');
  assert.equal(r.top, 'ok');
  assert.deepEqual(analyze(photo({}), null), { top: 'unknown', trousers: 'unknown', shoes: 'unknown', belt: 'unknown' });
  assert.equal(analyze(photo({}), landmarks({ lk: 0.2 })).trousers, 'unknown');
});
