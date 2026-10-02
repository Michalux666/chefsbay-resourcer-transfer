# AWS development dependency setup

The cloud checkout now has a lockfile for the resourcer package. It records public npm dependencies while preserving the package manifest and application code.

During setup, dependencies were installed with lifecycle scripts disabled. A targeted better-sqlite3 rebuild passed an in-memory query. The project test suite was not run.

Application services and production workflows were not started. To install the locked dependencies from the package directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
```
