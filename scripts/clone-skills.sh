#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/mattpocock/skills.git"
SKILLS_DIR="./src/skills"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

git clone --depth 1 --quiet "$REPO" "$TMP_DIR"
COMMIT=$(git -C "$TMP_DIR" rev-parse --short HEAD)

copy_skill () {
    local upstream_path="$1"
    local local_name="$2"
    local src="$TMP_DIR/$upstream_path"
    local dest="$SKILLS_DIR/$local_name"

    rm -rf "$dest"
    mkdir -p "$dest"

    find "$src" -maxdepth 1 -type f -exec cp {} "$dest/" \;

    if [ -d "$src/agents" ]; then
        cp -r "$src/agents" "$dest/"
    fi

    echo "  $local_name/ <- $upstream_path"
}

echo "Cloning skills from mattpocock/skills..."

copy_skill "skills/engineering/grill-with-docs" "grill"
copy_skill "skills/productivity/grilling" "grilling"
copy_skill "skills/engineering/domain-modeling" "domain-modeling"
copy_skill "skills/engineering/to-spec" "to-spec"
copy_skill "skills/engineering/to-tickets" "to-tickets"
copy_skill "skills/engineering/tdd" "tdd"

# grill-with-docs is exposed as /grill
sed -i '' 's/^name: grill-with-docs$/name: grill/' \
    "$SKILLS_DIR/grill/SKILL.md"

cat > "$SKILLS_DIR/upstream.json" <<EOF
{
  "repo": "mattpocock/skills",
  "commit": "$COMMIT",
  "pulledAt": "$(date +%Y-%m-%d)"
}
EOF

echo ""
echo "Done. Commit: $COMMIT"
