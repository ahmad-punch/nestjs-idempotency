# Contributing

1. `pnpm install`, then make your change with a test that fails without it.
2. Run `pnpm lint && pnpm test` and keep both green.
3. New stores should pass the shared contract in `test/store-contract.ts`; call `describeStoreContract('MyStore', () => new MyStore())` from a spec file.
4. Keep commits focused and messages in the imperative mood. Note user-facing changes in `CHANGELOG.md` under an "Unreleased" heading.

Bugs and ideas go in GitHub issues; please include a minimal reproduction.
