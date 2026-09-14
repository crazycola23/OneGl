# Continuous Integration

OneGl uses `.github/workflows/ci.yml` to validate pull requests and pushes to `main`.

The workflow runs on Node.js 22 and performs:

1. `npm ci`;
2. `node --check` for JavaScript and MJS files under `src/`, `tools/`, and `test/`;
3. `npm test`.

The purpose is to catch syntax and regression errors before browser automation or reporting changes are merged. CI does not access a real Doubao account and does not perform live provider requests.
