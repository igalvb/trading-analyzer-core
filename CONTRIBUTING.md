# Contributing to the core

The core is private and versioned (`VERSION`, `CHANGELOG.md`). The repo owner approves every change.

| Step | Do |
|---|---|
| 1 | Work in your own copy. Never put keys, sheet ids, emails, your stock lists or results in a change |
| 2 | Open a pull request to `main` of the core with the template filled in |
| 3 | The checks must pass: `cd backend && npm ci && npm run typecheck && npm test` (also run by the PR check) |
| 4 | Wait for the owner's approval. Nobody merges without it |
| 5 | After the merge the owner (or the AI session) tags the new version and writes the CHANGELOG entry |

## Version numbers (MAJOR.MINOR.PATCH)

| Change | Bump | Users must |
|---|---|---|
| Bug fix | PATCH, e.g. 1.0.0 → 1.0.1 | just update |
| New feature, nothing breaks | MINOR, e.g. 1.0.1 → 1.1.0 | just update |
| Change that needs user action (new required setting, sheet column, key) | MAJOR, e.g. 1.4.2 → 2.0.0 | follow the steps in the release note |

## Updating your copy

GitHub: your copy → **Sync fork** (or follow docs/USER_MANUAL.md "Updating to a new core version"). For a MAJOR version read the CHANGELOG entry first.
