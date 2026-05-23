# Examples

Sample integrations that consume the `Copilot-AI-Credits` trailers written by Copilot Budget.

## `github-actions/pr-title-aic-total.yml`

GitHub Actions workflow that, on every PR open/update, walks every commit between the PR's base and head, sums the `Copilot-AI-Credits:` trailer values, and rewrites the PR title as `[N AIC] <original title>`.

Copy into `.github/workflows/` in your repo. Requires no secrets beyond the default `GITHUB_TOKEN`. See the file header for the full behaviour notes.
