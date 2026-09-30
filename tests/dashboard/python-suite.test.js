'use strict';
/**
 * Runs the Python plugin tests (tests/dashboard/py, pytest + FastAPI TestClient) as part of `node --test`.
 * It needs an interpreter that can import fastapi, httpx and pytest. Set RESOURCER_PYTHON to pick one
 * (for example a venv); otherwise python3 and python are tried. When none qualifies the test is skipped,
 * so a laptop without Python still gets a green Node run and the report says the Python half did not run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const PY_DIR = path.join(__dirname, 'py');

function findPython() {
  const candidates = [process.env.RESOURCER_PYTHON, 'python3', 'python'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import fastapi, httpx, pytest'], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0) return c;
  }
  return null;
}

const python = findPython();

test('plugin_api.py: pytest suite against a synthetic workspace', { skip: python ? false : 'no Python with fastapi, httpx and pytest (set RESOURCER_PYTHON)', timeout: 600000 }, () => {
  const r = spawnSync(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-W', 'ignore', PY_DIR], {
    cwd: REPO, encoding: 'utf8', timeout: 540000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const tail = `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-40).join('\n');
  assert.equal(r.status, 0, tail);
});
