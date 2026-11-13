#!/usr/bin/env bash
# Reviews a pull request with Claude Code in print mode and posts the findings as one comment.
# Needs: claude (npm install -g @anthropic-ai/claude-code), gh, jq; ANTHROPIC_API_KEY, GH_TOKEN and PR set.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
marker='<!-- claude-review -->'

# Earlier findings from this bot, so a re-run reports only what is new or still open.
gh pr view "$PR" --json comments \
  --jq "[.comments[] | select(.body | startswith(\"$marker\")) | .body] | last // \"\"" > previous.md

claude -p "Review the changes on this branch against origin/main, using the review criteria in CLAUDE.md.
Report only bugs, security problems and possible data loss; skip style and naming.
previous.md holds the findings from the last review, if any. Report only issues that are new
or still not fixed, and mark each one new or still_open." \
  --output-format json \
  --json-schema "$(cat "$dir/review-schema.json")" \
  --allowedTools "Read,Grep,Glob,Bash(git diff *),Bash(git log *)" \
  --permission-mode dontAsk \
  --max-turns 20 \
  > review.json

# structured_output is missing when the run did not produce valid output: fail rather than post nothing.
jq -e '.structured_output.findings' review.json > /dev/null

jq -r --arg m "$marker" '
  .structured_output.findings as $f
  | "\($m)\n## Claude review\n\n"
  + (if ($f | length) == 0 then "No new problems found."
     else ($f | map("- **\(.severity)** `\(.file):\(.line)` \(.issue)" + (if .status == "still_open" then " _(still open)_" else "" end)) | join("\n"))
     end)' review.json > comment.md

gh pr comment "$PR" --body-file comment.md
