# Vendored anti-slop Oxlint plugin

Source: `install-anti-slop` skill bundle, `assets/anti-slop` snapshot.

Source revision: unknown. The bundle does not record an upstream repository or
commit. This copied snapshot is the reproducible base for future updates until
a verified revision is supplied.

Installed: 2026-11-19

- Entry point: `tools/oxlint/anti-slop/index.ts`
- Registered through `jsPlugins` as `anti-slop` in `.oxlintrc.json`
- Runtime: `oxlint` 1.94.0 with `@oxlint/plugins` 1.94.0 (exact)
- Configuration: `anti-slop/no-runtime-typeof` runs with
  `allowInTypeGuards: true`; runtime probes are centralized in
  `apps/api/src/json.ts` and the web type guards
- Intentional deviations: added `package.json` with `"type": "module"` so Node
  loads the TypeScript plugin as ESM without a typeless-package warning
- Verification: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and
  `pnpm build` pass after the source cleanup

The bundled third-party rule under `vendor/eslint-stylistic/` keeps its own
`UPSTREAM.md` and `LICENSE` (ESLint Stylistic commit
`435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08`).
