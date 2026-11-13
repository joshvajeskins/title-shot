#!/bin/zsh
# Usage: run.sh <jobs.tsv>  — generates each "<name>\t<prompt>" with Codex's built-in image tool into raw/<name>.png
DIR="$(cd "$(dirname "$0")/.." && pwd)"
gen() {
  local name="$1" prompt="$2"
  [ -s "$DIR/raw/$name.png" ] && { echo "skip $name"; return; }
  timeout 600 codex exec --skip-git-repo-check -s workspace-write -c model_reasoning_effort="low" -c service_tier="priority" -C "$DIR/raw" \
    "Use your built-in image generation tool (not code) to create ONE image and save it as $DIR/raw/$name.png. If the prompt asks for a transparent background, request a transparent PNG from the tool. Reply only with the saved path and pixel size. Image prompt: $prompt" > "$DIR/raw/$name.log" 2>&1
  [ -s "$DIR/raw/$name.png" ] && echo "ok $name" || echo "FAIL $name"
}
while IFS=$'\t' read -r name prompt; do gen "$name" "$prompt" & 
  while [ $(jobs -r | wc -l) -ge 5 ]; do sleep 2; done
done < "$1"
wait
