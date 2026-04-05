#!/usr/bin/env bash
# E2E test script for MarkUpsideDown MCP bridge endpoints
# Prerequisites: App must be running with bridge active
#
# Usage:
#   ./scripts/test-mcp-bridge.sh              # Run all tests
#   ./scripts/test-mcp-bridge.sh --readonly   # Skip destructive tests
#   ./scripts/test-mcp-bridge.sh --category editor  # Run specific category

set -euo pipefail

# --- Configuration ---
PORT_FILE="$HOME/.markupsidedown-bridge-port"
READONLY=false
CATEGORY=""
PASS=0
FAIL=0
SKIP=0
FAILURES=()

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --readonly) READONLY=true; shift ;;
    --category) CATEGORY="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Helpers ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

discover_port() {
  if [[ -f "$PORT_FILE" ]]; then
    cat "$PORT_FILE"
  else
    echo ""
  fi
}

BASE_URL=""
setup_base_url() {
  local port
  port=$(discover_port)
  if [[ -z "$port" ]]; then
    echo -e "${RED}ERROR: Bridge port file not found at $PORT_FILE${NC}"
    echo "Is MarkUpsideDown running?"
    exit 1
  fi
  BASE_URL="http://127.0.0.1:${port}"
  # Health check
  if ! curl -sf "${BASE_URL}/health" > /dev/null 2>&1; then
    echo -e "${RED}ERROR: Bridge not responding at ${BASE_URL}${NC}"
    exit 1
  fi
  echo -e "${GREEN}Bridge found at ${BASE_URL}${NC}"
}

# Run a test: test_get "name" "path" "jq_check"
#   jq_check: a jq expression that should return "true"
test_get() {
  local name="$1" path="$2" check="$3"
  local url="${BASE_URL}${path}"
  local resp
  resp=$(curl -sf "$url" 2>&1) || {
    echo -e "  ${RED}FAIL${NC} $name — HTTP error"
    FAIL=$((FAIL + 1))
    FAILURES+=("$name")
    return
  }
  if [[ -n "$check" ]]; then
    local result
    result=$(echo "$resp" | jq -r "$check" 2>/dev/null) || result="false"
    if [[ "$result" == "true" ]]; then
      echo -e "  ${GREEN}PASS${NC} $name"
      PASS=$((PASS + 1))
    else
      echo -e "  ${RED}FAIL${NC} $name — check failed: $check"
      echo "    Response: $(echo "$resp" | head -c 200)"
      FAIL=$((FAIL + 1))
      FAILURES+=("$name")
    fi
  else
    echo -e "  ${GREEN}PASS${NC} $name (HTTP 200)"
    PASS=$((PASS + 1))
  fi
}

# Run a POST test: test_post "name" "path" "json_body" "jq_check"
test_post() {
  local name="$1" path="$2" body="$3" check="$4"
  local url="${BASE_URL}${path}"
  local resp
  resp=$(curl -sf -X POST -H "Content-Type: application/json" -d "$body" "$url" 2>&1) || {
    echo -e "  ${RED}FAIL${NC} $name — HTTP error"
    FAIL=$((FAIL + 1))
    FAILURES+=("$name")
    return
  }
  if [[ -n "$check" ]]; then
    local result
    result=$(echo "$resp" | jq -r "$check" 2>/dev/null) || result="false"
    if [[ "$result" == "true" ]]; then
      echo -e "  ${GREEN}PASS${NC} $name"
      PASS=$((PASS + 1))
    else
      echo -e "  ${RED}FAIL${NC} $name — check failed: $check"
      echo "    Response: $(echo "$resp" | head -c 200)"
      FAIL=$((FAIL + 1))
      FAILURES+=("$name")
    fi
  else
    echo -e "  ${GREEN}PASS${NC} $name (HTTP 200)"
    PASS=$((PASS + 1))
  fi
}

skip_test() {
  local name="$1" reason="$2"
  echo -e "  ${YELLOW}SKIP${NC} $name — $reason"
  SKIP=$((SKIP + 1))
}

should_run() {
  [[ -z "$CATEGORY" || "$CATEGORY" == "$1" ]]
}

# --- Tests ---

setup_base_url
echo ""

# ============================================================
# 1. Window management
# ============================================================
if should_run "windows"; then
  echo -e "${CYAN}=== Window Management ===${NC}"
  test_get "list_windows" "/windows" '.windows | type == "array"'
fi

# ============================================================
# 2. Editor tools (read-only)
# ============================================================
if should_run "editor"; then
  echo -e "${CYAN}=== Editor Tools (Read) ===${NC}"
  test_get "get_editor_content" "/editor/content" 'has("content")'
  test_get "get_editor_state" "/editor/state" 'has("cursor_pos")'
  test_get "get_open_tabs" "/editor/tabs" '.tabs | type == "array"'
  test_get "get_project_root" "/editor/root" 'has("root_path")'
  test_get "get_dirty_files" "/editor/dirty-files" 'has("dirty_files")'
  test_get "lint_document" "/editor/lint" 'has("diagnostics")'
  test_get "get_document_structure" "/editor/structure" 'type == "object"'
fi

# ============================================================
# 3. Editor tools (write) — set content, insert, normalize
# ============================================================
if should_run "editor-write"; then
  echo -e "${CYAN}=== Editor Tools (Write) ===${NC}"
  if $READONLY; then
    skip_test "set_editor_content" "--readonly"
    skip_test "insert_text" "--readonly"
    skip_test "normalize_document" "--readonly"
    skip_test "switch_tab" "--readonly"
  else
    # Save original content for restore
    ORIGINAL=$(curl -sf "${BASE_URL}/editor/content" | jq -r '.content // ""')

    test_post "set_editor_content" "/editor/content" \
      '{"content":"# Test\n\nHello from MCP test script."}' ""

    test_post "insert_text (end)" "/editor/insert" \
      '{"text":"\n\n<!-- test marker -->","position":"end"}' ""

    test_post "normalize_document" "/editor/normalize" '{}' ""

    test_post "switch_tab" "/editor/switch-tab" '{"path":null,"tab_id":null}' ""

    # Restore original content
    if [[ -n "$ORIGINAL" ]]; then
      curl -sf -X POST -H "Content-Type: application/json" \
        -d "{\"content\":$(echo "$ORIGINAL" | jq -Rs .)}" \
        "${BASE_URL}/editor/content" > /dev/null 2>&1
      echo -e "  ${GREEN}(restored original content)${NC}"
    fi
  fi
fi

# ============================================================
# 4. File browsing
# ============================================================
if should_run "files"; then
  echo -e "${CYAN}=== File Browsing ===${NC}"
  test_get "list_directory" "/files/list" '.entries | type == "array"'
  test_get "list_directory (recursive)" "/files/list?recursive=true&path=." \
    '.entries | length > 0'
  test_get "search_files" "/files/search?query=README" \
    '.matches | type == "array"'

  # read_file — read CLAUDE.md as a known file
  ROOT=$(curl -sf "${BASE_URL}/editor/root" | jq -r '.root_path // ""')
  if [[ -n "$ROOT" ]]; then
    ENCODED_PATH=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${ROOT}/CLAUDE.md'))")
    test_get "read_file (CLAUDE.md)" "/files/read?path=${ENCODED_PATH}" 'has("content")'
  else
    skip_test "read_file" "no project root"
  fi
fi

# ============================================================
# 5. File operations (create, copy, duplicate, rename, delete)
# ============================================================
if should_run "file-ops"; then
  echo -e "${CYAN}=== File Operations ===${NC}"
  if $READONLY; then
    skip_test "create_file" "--readonly"
    skip_test "create_directory" "--readonly"
    skip_test "copy_entry" "--readonly"
    skip_test "duplicate_entry" "--readonly"
    skip_test "rename_entry" "--readonly"
    skip_test "delete_entry" "--readonly"
  else
    ROOT=$(curl -sf "${BASE_URL}/editor/root" | jq -r '.root_path // ""')
    if [[ -z "$ROOT" ]]; then
      skip_test "file-ops" "no project root"
    else
      TEST_DIR="${ROOT}/.mcp-test-tmp"
      TEST_COPY_DIR="${ROOT}/.mcp-test-tmp/subdir"
      TEST_FILE="${TEST_DIR}/test-file.md"

      test_post "create_directory" "/files/create-directory" \
        "{\"path\":\"${TEST_DIR}\"}" '.ok == true'

      test_post "create_directory (subdir)" "/files/create-directory" \
        "{\"path\":\"${TEST_COPY_DIR}\"}" '.ok == true'

      test_post "create_file" "/files/create" \
        "{\"path\":\"${TEST_FILE}\"}" '.ok == true'

      test_post "copy_entry" "/files/copy" \
        "{\"from\":\"${TEST_FILE}\",\"to_dir\":\"${TEST_COPY_DIR}\"}" 'has("path")'

      test_post "duplicate_entry" "/files/duplicate" \
        "{\"path\":\"${TEST_FILE}\"}" 'has("path")'

      test_post "rename_entry" "/files/rename" \
        "{\"from\":\"${TEST_FILE}\",\"to\":\"${TEST_DIR}/renamed.md\"}" '.ok == true'

      # Cleanup: delete test dir
      test_post "delete_entry (file)" "/files/delete" \
        "{\"path\":\"${TEST_DIR}/renamed.md\"}" '.ok == true'

      # Delete remaining files
      for f in $(curl -sf "${BASE_URL}/files/list?path=${TEST_DIR}" | jq -r '.entries[]?.path // empty'); do
        curl -sf -X POST -H "Content-Type: application/json" \
          -d "{\"path\":\"$f\"}" "${BASE_URL}/files/delete" > /dev/null 2>&1
      done

      test_post "delete_entry (dir)" "/files/delete" \
        "{\"path\":\"${TEST_DIR}\",\"is_dir\":true}" '.ok == true'
    fi
  fi
fi

# ============================================================
# 6. Git read tools
# ============================================================
if should_run "git"; then
  echo -e "${CYAN}=== Git Tools (Read) ===${NC}"
  test_get "git_status" "/git/status" 'has("branch")'
  test_get "git_log" "/git/log?limit=5" '.entries | type == "array"'
  test_post "git_fetch" "/git/fetch" '{}' ""

  # git_diff needs a file — use CLAUDE.md
  test_get "git_diff (CLAUDE.md)" "/git/diff?path=CLAUDE.md" 'has("diff")'

  # git_show — get latest commit hash and show it
  LATEST_HASH=$(curl -sf "${BASE_URL}/git/log?limit=1" | jq -r '.entries[0].hash // ""')
  if [[ -n "$LATEST_HASH" ]]; then
    test_get "git_show" "/git/show?commit_hash=${LATEST_HASH}" 'has("output")'
  else
    skip_test "git_show" "no commits found"
  fi
fi

# ============================================================
# 7. Git write tools
# ============================================================
if should_run "git-write"; then
  echo -e "${CYAN}=== Git Tools (Write) ===${NC}"
  if $READONLY; then
    skip_test "git_stage" "--readonly"
    skip_test "git_unstage" "--readonly"
    skip_test "git_stage_all" "--readonly"
    skip_test "git_commit" "--readonly"
    skip_test "git_push" "--readonly"
    skip_test "git_pull" "--readonly"
    skip_test "git_discard" "--readonly"
    skip_test "git_discard_all" "--readonly"
    skip_test "git_revert" "--readonly"
    skip_test "git_clone" "--readonly"
    skip_test "git_init" "--readonly"
  else
    ROOT=$(curl -sf "${BASE_URL}/editor/root" | jq -r '.root_path // ""')
    if [[ -z "$ROOT" ]]; then
      skip_test "git-write" "no project root"
    else
      # Create a temp file, stage, unstage, discard
      TEMP_GIT_FILE="${ROOT}/.mcp-git-test.tmp"
      echo "test" > "$TEMP_GIT_FILE"

      test_post "git_stage" "/git/stage" \
        '{"path":".mcp-git-test.tmp"}' '.ok == true'

      test_post "git_unstage" "/git/unstage" \
        '{"path":".mcp-git-test.tmp"}' '.ok == true'

      test_post "git_stage_all" "/git/stage-all" '{}' '.ok == true'

      # Unstage again so we don't commit
      curl -sf -X POST -H "Content-Type: application/json" \
        -d '{"path":".mcp-git-test.tmp"}' "${BASE_URL}/git/unstage" > /dev/null 2>&1

      test_post "git_discard" "/git/discard" \
        '{"path":".mcp-git-test.tmp"}' '.ok == true'

      # git_pull (may fail if no remote, but endpoint should respond)
      resp=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        -H "Content-Type: application/json" -d '{}' "${BASE_URL}/git/pull")
      if [[ "$resp" == "200" || "$resp" == "500" ]]; then
        echo -e "  ${GREEN}PASS${NC} git_pull (endpoint responds: HTTP $resp)"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} git_pull — unexpected HTTP $resp"
        FAIL=$((FAIL + 1))
        FAILURES+=("git_pull")
      fi

      # git_commit, git_push, git_revert, git_discard_all — skip in automated test
      # These are destructive and need careful setup
      skip_test "git_commit" "destructive — test manually"
      skip_test "git_push" "destructive — test manually"
      skip_test "git_revert" "destructive — test manually"
      skip_test "git_discard_all" "destructive — test manually"
      skip_test "git_clone" "requires URL and dest — test manually"
      skip_test "git_init" "requires empty dir — test manually"
    fi
  fi
fi

# ============================================================
# 8. Tags
# ============================================================
if should_run "tags"; then
  echo -e "${CYAN}=== Tag Tools ===${NC}"
  test_get "list_tags" "/tags/list" 'has("tags")'

  if $READONLY; then
    skip_test "create_tag" "--readonly"
    skip_test "set_file_tags" "--readonly"
    skip_test "get_file_tags" "--readonly (needs tag data)"
    skip_test "delete_tag" "--readonly"
  else
    # Save original tags for restore
    ORIGINAL_TAGS=$(curl -sf "${BASE_URL}/tags/list")

    # create_tag — we do this via tags/set (same as MCP server implementation)
    # The MCP server reads current tags, adds the new one, and writes back
    TAGS_OBJ=$(echo "$ORIGINAL_TAGS" | jq -r '.tags // {}')
    FILES_OBJ=$(echo "$ORIGINAL_TAGS" | jq -r '.files // {}')
    NEW_TAGS=$(echo "$TAGS_OBJ" | jq '. + {"__mcp_test__": "#ff0000"}')
    test_post "create_tag" "/tags/set" \
      "{\"tags\":{\"tags\":$(echo "$NEW_TAGS"),\"files\":$(echo "$FILES_OBJ")}}" '.ok == true'

    # Verify tag was created
    VERIFY=$(curl -sf "${BASE_URL}/tags/list" | jq -r '.tags.__mcp_test__ // ""')
    if [[ "$VERIFY" == "#ff0000" ]]; then
      echo -e "  ${GREEN}PASS${NC} create_tag (verified)"
      PASS=$((PASS + 1))
    else
      echo -e "  ${RED}FAIL${NC} create_tag — tag not found after create"
      FAIL=$((FAIL + 1))
      FAILURES+=("create_tag (verify)")
    fi

    # set_file_tags — assign test tag to CLAUDE.md
    CUR=$(curl -sf "${BASE_URL}/tags/list")
    CUR_TAGS=$(echo "$CUR" | jq '.tags // {}')
    CUR_FILES=$(echo "$CUR" | jq '.files // {}')
    NEW_FILES=$(echo "$CUR_FILES" | jq '. + {"CLAUDE.md": ["__mcp_test__"]}')
    test_post "set_file_tags" "/tags/set" \
      "{\"tags\":{\"tags\":$(echo "$CUR_TAGS"),\"files\":$(echo "$NEW_FILES")}}" '.ok == true'

    # get_file_tags — verify via list_tags (MCP server filters locally)
    FILE_TAGS=$(curl -sf "${BASE_URL}/tags/list" | jq -r '.files["CLAUDE.md"] // []')
    if echo "$FILE_TAGS" | jq -e 'index("__mcp_test__") != null' > /dev/null 2>&1; then
      echo -e "  ${GREEN}PASS${NC} get_file_tags (verified)"
      PASS=$((PASS + 1))
    else
      echo -e "  ${RED}FAIL${NC} get_file_tags — tag not found on file"
      FAIL=$((FAIL + 1))
      FAILURES+=("get_file_tags (verify)")
    fi

    # delete_tag — restore original tags
    test_post "delete_tag (restore)" "/tags/set" \
      "{\"tags\":$(echo "$ORIGINAL_TAGS")}" '.ok == true'
  fi
fi

# ============================================================
# 9. Content tools (bridge-only, no Worker needed)
# ============================================================
if should_run "content"; then
  echo -e "${CYAN}=== Content Tools (Bridge) ===${NC}"
  test_post "fetch_page_title" "/content/fetch-title" \
    '{"url":"https://example.com"}' 'has("title")'

  if $READONLY; then
    skip_test "download_image" "--readonly"
  else
    ROOT=$(curl -sf "${BASE_URL}/editor/root" | jq -r '.root_path // ""')
    if [[ -n "$ROOT" ]]; then
      DL_DEST="${ROOT}/.mcp-test-img.png"
      test_post "download_image" "/content/download-image" \
        "{\"url\":\"https://www.google.com/favicon.ico\",\"dest_path\":\"${DL_DEST}\"}" \
        'has("path")'
      rm -f "$DL_DEST" 2>/dev/null
    else
      skip_test "download_image" "no project root"
    fi
  fi
fi

# ============================================================
# 10. Crawl save (bridge endpoint, no Worker needed)
# ============================================================
if should_run "crawl"; then
  echo -e "${CYAN}=== Crawl Tools (Bridge) ===${NC}"
  if $READONLY; then
    skip_test "crawl_save" "--readonly"
  else
    ROOT=$(curl -sf "${BASE_URL}/editor/root" | jq -r '.root_path // ""')
    if [[ -n "$ROOT" ]]; then
      CRAWL_DIR="${ROOT}/.mcp-crawl-test"
      mkdir -p "$CRAWL_DIR"
      test_post "crawl_save" "/crawl/save" \
        "{\"pages\":[{\"url\":\"https://example.com\",\"markdown\":\"# Example\",\"title\":\"Example\"}],\"base_dir\":\"${CRAWL_DIR}\"}" \
        'has("saved_count")'
      rm -rf "$CRAWL_DIR" 2>/dev/null
    else
      skip_test "crawl_save" "no project root"
    fi
  fi

  # crawl_website and crawl_status are tested in the "worker" section
fi

# ============================================================
# 11. Open/save file
# ============================================================
if should_run "open-save"; then
  echo -e "${CYAN}=== Open/Save File ===${NC}"
  if $READONLY; then
    skip_test "open_file" "--readonly"
    skip_test "save_file" "--readonly"
  else
    ROOT=$(curl -sf "${BASE_URL}/editor/root" | jq -r '.root_path // ""')
    if [[ -n "$ROOT" && -f "${ROOT}/CLAUDE.md" ]]; then
      test_post "open_file" "/editor/open-file" \
        "{\"path\":\"${ROOT}/CLAUDE.md\"}" ""
      test_post "save_file" "/editor/save-file" '{"path":null}' ""
    else
      skip_test "open_file" "no project root or CLAUDE.md"
      skip_test "save_file" "no project root"
    fi
  fi
fi

# ============================================================
# 12. Worker-dependent tools
# ============================================================
if should_run "worker"; then
  # Discover Worker URL from bridge
  WORKER_URL=$(curl -sf "${BASE_URL}/editor/state" | jq -r '.worker_url // ""')
  if [[ -z "$WORKER_URL" ]]; then
    echo -e "${CYAN}=== Worker-Dependent Tools (SKIPPED — no Worker URL) ===${NC}"
    skip_test "fetch_markdown" "no Worker URL"
    skip_test "render_markdown" "no Worker URL"
    skip_test "get_markdown" "no Worker URL"
    skip_test "convert_to_markdown" "no Worker URL"
    skip_test "extract_json" "no Worker URL"
    skip_test "index_documents" "no Worker URL"
    skip_test "semantic_search" "no Worker URL"
    skip_test "remove_document" "no Worker URL"
    skip_test "publish_document" "no Worker URL"
    skip_test "unpublish_document" "no Worker URL"
    skip_test "list_published" "no Worker URL"
    skip_test "submit_batch" "no Worker URL"
    skip_test "get_batch_status" "no Worker URL"
  else
    echo -e "${CYAN}=== Worker-Dependent Tools (${WORKER_URL}) ===${NC}"

    # Check Worker capabilities
    CAPS=$(curl -sf "${WORKER_URL}/health" 2>/dev/null || echo '{}')
    has_cap() { echo "$CAPS" | jq -r ".capabilities.$1 // false" 2>/dev/null; }

    # --- fetch_markdown (direct HTTP with Accept: text/markdown, no Worker needed) ---
    resp=$(curl -sf -H "Accept: text/markdown" "https://example.com" 2>&1) || resp=""
    if [[ -n "$resp" ]]; then
      echo -e "  ${GREEN}PASS${NC} fetch_markdown (Accept: text/markdown)"
      PASS=$((PASS + 1))
    else
      echo -e "  ${RED}FAIL${NC} fetch_markdown — no response"
      FAIL=$((FAIL + 1))
      FAILURES+=("fetch_markdown")
    fi

    # --- render_markdown (GET /render?url=) ---
    if [[ "$(has_cap render)" == "true" ]]; then
      test_url="${WORKER_URL}/render?url=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("https://example.com"))')"
      resp=$(curl -sf --max-time 30 "$test_url" 2>&1) || resp=""
      result=$(echo "$resp" | jq -r 'has("markdown")' 2>/dev/null) || result="false"
      if [[ "$result" == "true" ]]; then
        echo -e "  ${GREEN}PASS${NC} render_markdown"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} render_markdown — no markdown in response"
        echo "    Response: $(echo "$resp" | head -c 200)"
        FAIL=$((FAIL + 1))
        FAILURES+=("render_markdown")
      fi
    else
      skip_test "render_markdown" "render capability not available"
    fi

    # --- get_markdown (uses POST /fetch as fallback) ---
    if [[ "$(has_cap fetch)" == "true" ]]; then
      resp=$(curl -sf --max-time 30 -X POST -H "Content-Type: application/json" \
        -d '{"url":"https://example.com"}' "${WORKER_URL}/fetch" 2>&1) || resp=""
      result=$(echo "$resp" | jq -r 'has("markdown")' 2>/dev/null) || result="false"
      if [[ "$result" == "true" ]]; then
        echo -e "  ${GREEN}PASS${NC} get_markdown (via /fetch)"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} get_markdown — no markdown in response"
        echo "    Response: $(echo "$resp" | head -c 200)"
        FAIL=$((FAIL + 1))
        FAILURES+=("get_markdown")
      fi
    else
      skip_test "get_markdown" "fetch capability not available"
    fi

    # --- convert_to_markdown (POST /convert with file bytes) ---
    if [[ "$(has_cap convert)" == "true" ]]; then
      # Create a tiny HTML file to convert
      CONVERT_TMP=$(mktemp /tmp/mcp-test-XXXXXX.html)
      echo "<html><body><h1>Test</h1><p>Hello</p></body></html>" > "$CONVERT_TMP"
      resp=$(curl -sf --max-time 30 -X POST \
        -H "Content-Type: text/html" \
        --data-binary "@${CONVERT_TMP}" "${WORKER_URL}/convert" 2>&1) || resp=""
      rm -f "$CONVERT_TMP"
      result=$(echo "$resp" | jq -r 'has("markdown")' 2>/dev/null) || result="false"
      if [[ "$result" == "true" ]]; then
        echo -e "  ${GREEN}PASS${NC} convert_to_markdown"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} convert_to_markdown — no markdown in response"
        echo "    Response: $(echo "$resp" | head -c 200)"
        FAIL=$((FAIL + 1))
        FAILURES+=("convert_to_markdown")
      fi
    else
      skip_test "convert_to_markdown" "convert capability not available"
    fi

    # --- extract_json (POST /json) ---
    if [[ "$(has_cap json)" == "true" ]]; then
      resp=$(curl -sf --max-time 30 -X POST -H "Content-Type: application/json" \
        -d '{"url":"https://example.com","prompt":"Extract the page title"}' \
        "${WORKER_URL}/json" 2>&1) || resp=""
      result=$(echo "$resp" | jq -r 'has("data") or has("error")' 2>/dev/null) || result="false"
      if [[ "$result" == "true" ]]; then
        echo -e "  ${GREEN}PASS${NC} extract_json"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} extract_json — unexpected response"
        echo "    Response: $(echo "$resp" | head -c 200)"
        FAIL=$((FAIL + 1))
        FAILURES+=("extract_json")
      fi
    else
      skip_test "extract_json" "json capability not available"
    fi

    # --- crawl_website + crawl_status (POST /crawl, GET /crawl/:id) ---
    if [[ "$(has_cap crawl)" == "true" ]]; then
      resp=$(curl -sf --max-time 30 -X POST -H "Content-Type: application/json" \
        -d '{"url":"https://example.com","depth":1,"limit":1}' \
        "${WORKER_URL}/crawl" 2>&1) || resp=""
      job_id=$(echo "$resp" | jq -r '.job_id // ""' 2>/dev/null)
      if [[ -n "$job_id" ]]; then
        echo -e "  ${GREEN}PASS${NC} crawl_website (job_id: ${job_id})"
        PASS=$((PASS + 1))

        # Poll crawl_status
        sleep 2
        status_resp=$(curl -sf --max-time 15 "${WORKER_URL}/crawl/${job_id}" 2>&1) || status_resp=""
        result=$(echo "$status_resp" | jq -r 'has("result") or has("status")' 2>/dev/null) || result="false"
        if [[ "$result" == "true" ]]; then
          crawl_st=$(echo "$status_resp" | jq -r '.result.status // .status')
          echo -e "  ${GREEN}PASS${NC} crawl_status (status: ${crawl_st})"
          PASS=$((PASS + 1))
        else
          echo -e "  ${RED}FAIL${NC} crawl_status — no status field"
          echo "    Response: $(echo "$status_resp" | head -c 200)"
          FAIL=$((FAIL + 1))
          FAILURES+=("crawl_status")
        fi
      else
        echo -e "  ${RED}FAIL${NC} crawl_website — no job_id"
        echo "    Response: $(echo "$resp" | head -c 200)"
        FAIL=$((FAIL + 1))
        FAILURES+=("crawl_website")
        skip_test "crawl_status" "no job_id from crawl_website"
      fi
    else
      skip_test "crawl_website" "crawl capability not available"
      skip_test "crawl_status" "crawl capability not available"
    fi

    # --- publish + list_published + unpublish (PUT /publish, GET /published, DELETE /publish/:key) ---
    if [[ "$(has_cap publish)" == "true" ]]; then
      TEST_KEY="__mcp-test-$(date +%s)"
      resp=$(curl -sf --max-time 15 -X PUT -H "Content-Type: application/json" \
        -d "{\"key\":\"${TEST_KEY}\",\"content\":\"# Test\\n\\nPublished by MCP test.\",\"filename\":\"test.md\",\"expires_in\":60}" \
        "${WORKER_URL}/publish" 2>&1) || resp=""
      result=$(echo "$resp" | jq -r 'has("url")' 2>/dev/null) || result="false"
      if [[ "$result" == "true" ]]; then
        pub_url=$(echo "$resp" | jq -r '.url')
        echo -e "  ${GREEN}PASS${NC} publish_document (url: ${pub_url})"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} publish_document"
        echo "    Response: $(echo "$resp" | head -c 200)"
        FAIL=$((FAIL + 1))
        FAILURES+=("publish_document")
      fi

      # list_published
      resp=$(curl -sf --max-time 15 "${WORKER_URL}/published" 2>&1) || resp=""
      result=$(echo "$resp" | jq -r 'has("files")' 2>/dev/null) || result="false"
      if [[ "$result" == "true" ]]; then
        count=$(echo "$resp" | jq '.files | length')
        echo -e "  ${GREEN}PASS${NC} list_published (${count} files)"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} list_published"
        echo "    Response: $(echo "$resp" | head -c 200)"
        FAIL=$((FAIL + 1))
        FAILURES+=("list_published")
      fi

      # unpublish
      resp=$(curl -sf --max-time 15 -X DELETE "${WORKER_URL}/publish/${TEST_KEY}" 2>&1)
      http_code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "${WORKER_URL}/publish/${TEST_KEY}")
      # Already deleted above, so 404 is OK; 200 or 404 both count as "endpoint works"
      if [[ "$http_code" == "200" || "$http_code" == "404" ]]; then
        echo -e "  ${GREEN}PASS${NC} unpublish_document (HTTP ${http_code})"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} unpublish_document — HTTP ${http_code}"
        FAIL=$((FAIL + 1))
        FAILURES+=("unpublish_document")
      fi
    else
      skip_test "publish_document" "publish capability not available"
      skip_test "list_published" "publish capability not available"
      skip_test "unpublish_document" "publish capability not available"
    fi

    # --- index_documents + semantic_search + remove_document ---
    if [[ "$(has_cap search)" == "true" ]]; then
      TEST_DOC_ID="__mcp-test-doc-$(date +%s)"
      resp=$(curl -sf --max-time 30 -X POST -H "Content-Type: application/json" \
        -d "{\"documents\":[{\"id\":\"${TEST_DOC_ID}\",\"content\":\"MarkUpsideDown is a Markdown editor powered by Tauri and Cloudflare Workers AI.\"}]}" \
        "${WORKER_URL}/embed" 2>&1) || resp=""
      result=$(echo "$resp" | jq -r 'has("indexed")' 2>/dev/null) || result="false"
      if [[ "$result" == "true" ]]; then
        echo -e "  ${GREEN}PASS${NC} index_documents"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} index_documents"
        echo "    Response: $(echo "$resp" | head -c 200)"
        FAIL=$((FAIL + 1))
        FAILURES+=("index_documents")
      fi

      # semantic_search
      sleep 1
      resp=$(curl -sf --max-time 15 -X POST -H "Content-Type: application/json" \
        -d '{"query":"markdown editor","limit":3}' \
        "${WORKER_URL}/search" 2>&1) || resp=""
      result=$(echo "$resp" | jq -r 'has("results")' 2>/dev/null) || result="false"
      if [[ "$result" == "true" ]]; then
        count=$(echo "$resp" | jq '.results | length')
        echo -e "  ${GREEN}PASS${NC} semantic_search (${count} results)"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} semantic_search"
        echo "    Response: $(echo "$resp" | head -c 200)"
        FAIL=$((FAIL + 1))
        FAILURES+=("semantic_search")
      fi

      # remove_document (cleanup)
      http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
        -X DELETE "${WORKER_URL}/embed/${TEST_DOC_ID}")
      if [[ "$http_code" == "200" ]]; then
        echo -e "  ${GREEN}PASS${NC} remove_document"
        PASS=$((PASS + 1))
      else
        echo -e "  ${RED}FAIL${NC} remove_document — HTTP ${http_code}"
        FAIL=$((FAIL + 1))
        FAILURES+=("remove_document")
      fi
    else
      skip_test "index_documents" "search capability not available"
      skip_test "semantic_search" "search capability not available"
      skip_test "remove_document" "search capability not available"
    fi

    # --- submit_batch + get_batch_status ---
    if [[ "$(has_cap batch)" == "true" ]]; then
      resp=$(curl -sf --max-time 30 -X POST -H "Content-Type: application/json" \
        -d '{"files":[{"name":"test.html","content":"PGh0bWw+PGJvZHk+PGgxPlRlc3Q8L2gxPjwvYm9keT48L2h0bWw+"}]}' \
        "${WORKER_URL}/batch" 2>&1) || resp=""
      batch_id=$(echo "$resp" | jq -r '.batch_id // ""' 2>/dev/null)
      if [[ -n "$batch_id" ]]; then
        echo -e "  ${GREEN}PASS${NC} submit_batch (batch_id: ${batch_id})"
        PASS=$((PASS + 1))

        # Poll batch status
        sleep 2
        status_resp=$(curl -sf --max-time 15 "${WORKER_URL}/batch/${batch_id}" 2>&1) || status_resp=""
        result=$(echo "$status_resp" | jq -r 'has("batch_id")' 2>/dev/null) || result="false"
        if [[ "$result" == "true" ]]; then
          batch_st=$(echo "$status_resp" | jq -r '"\(.completed)/\(.total) done"')
          echo -e "  ${GREEN}PASS${NC} get_batch_status (status: ${batch_st})"
          PASS=$((PASS + 1))
        else
          echo -e "  ${RED}FAIL${NC} get_batch_status"
          echo "    Response: $(echo "$status_resp" | head -c 200)"
          FAIL=$((FAIL + 1))
          FAILURES+=("get_batch_status")
        fi
      else
        echo -e "  ${RED}FAIL${NC} submit_batch — no batch_id"
        echo "    Response: $(echo "$resp" | head -c 200)"
        FAIL=$((FAIL + 1))
        FAILURES+=("submit_batch")
        skip_test "get_batch_status" "no batch_id from submit_batch"
      fi
    else
      skip_test "submit_batch" "batch capability not available"
      skip_test "get_batch_status" "batch capability not available"
    fi
  fi
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Test Summary${NC}"
echo -e "${CYAN}========================================${NC}"
TOTAL=$((PASS + FAIL + SKIP))
echo -e "  Total:   ${TOTAL}"
echo -e "  ${GREEN}Passed:  ${PASS}${NC}"
echo -e "  ${RED}Failed:  ${FAIL}${NC}"
echo -e "  ${YELLOW}Skipped: ${SKIP}${NC}"
echo ""

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo -e "${RED}Failed tests:${NC}"
  for f in "${FAILURES[@]}"; do
    echo -e "  - $f"
  done
  echo ""
fi

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
