# Connector Reports

Field reports from connector creation runs. Each report captures what worked, what broke, and what to improve in the skill and tooling.

## Adding a report

After creating a connector, save a report here:

```
reports/YYYY-MM-DD-<platform>.md
```

Include:
- Platform name, extraction strategy, auth method
- Iteration count and what caused retries
- Validator results (passes/failures)
- Bugs or friction encountered
- What worked well

The vana-connect skill's `--contribute` flag will eventually generate these automatically.

## Reports

| Date | Platform | Runs | Strategy | Report |
|------|----------|------|----------|--------|
| 2026-03-11 | Linear | 1-2 | API key + httpFetch | [interrogator](https://github.com/vana-com/vana-product-interrogator/pull/13) |
| 2026-03-11 | Figma | 3 | API key + httpFetch | [interrogator](https://github.com/vana-com/vana-product-interrogator/pull/13) |
| 2026-03-11 | Linear | 4 | Browser login + DOM | [interrogator](https://github.com/vana-com/vana-product-interrogator/pull/13) |
| 2026-03-12 | Goodreads | 5 | Browser login + RSS | [interrogator](https://github.com/vana-com/vana-product-interrogator/pull/13) |
