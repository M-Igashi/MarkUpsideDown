use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

const WORKER_INDEX_TS: &str = include_str!("../../worker/src/index.ts");
const WORKER_WRANGLER_JSONC: &str = include_str!("../../worker/wrangler.jsonc");

#[derive(Serialize, Clone)]
pub struct WranglerAccount {
    pub name: String,
    pub id: String,
}

#[derive(Serialize)]
pub struct WranglerStatus {
    pub installed: bool,
    pub logged_in: bool,
    pub version: Option<String>,
    pub accounts: Vec<WranglerAccount>,
}

/// Cached augmented PATH for macOS GUI apps that don't inherit shell env.
static AUGMENTED_PATH: OnceLock<Option<String>> = OnceLock::new();

fn compute_augmented_path() -> Option<String> {
    let current_path = std::env::var("PATH").ok()?;
    let home = crate::util::home_dir();
    let mut extra_paths = Vec::new();
    if let Some(ref home) = home {
        for dir in [
            ".npm-packages/bin",
            ".nodebrew/current/bin",
            ".volta/bin",
            ".local/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            ".local/share/fnm/aliases/default/bin",
            ".proto/shims",
            "n/bin",
        ] {
            let p = home.join(dir);
            if p.exists() {
                extra_paths.push(p.to_string_lossy().to_string());
            }
        }
        let nvm_dir = home.join(".nvm/versions/node");
        if nvm_dir.exists()
            && let Ok(entries) = std::fs::read_dir(&nvm_dir)
        {
            let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).collect();
            versions.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
            if let Some(latest) = versions.first() {
                extra_paths.push(latest.path().join("bin").to_string_lossy().to_string());
            }
        }
    }
    for p in ["/opt/homebrew/bin"] {
        if !current_path.contains(p) {
            extra_paths.push(p.to_string());
        }
    }
    if extra_paths.is_empty() {
        None
    } else {
        Some(format!("{}:{}", extra_paths.join(":"), current_path))
    }
}

/// Set HOME and augment PATH for macOS GUI apps that don't inherit shell env.
/// Covers: Homebrew (Intel + ARM), nvm, nodebrew, fnm, Volta, asdf, mise, n, proto
fn setup_gui_env(cmd: &mut Command) {
    if let Some(home) = crate::util::home_dir() {
        cmd.env("HOME", home);
    }
    if let Some(path) = AUGMENTED_PATH.get_or_init(compute_augmented_path) {
        cmd.env("PATH", path);
    }
}

fn run_wrangler(
    args: &[&str],
    cwd: Option<&Path>,
    timeout_secs: u64,
    env: &[(&str, &str)],
) -> Result<String, String> {
    let mut cmd = Command::new("wrangler");
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for &(key, val) in env {
        cmd.env(key, val);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    setup_gui_env(&mut cmd);

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "wrangler is not installed. Install it with: npm install -g wrangler".to_string()
        } else {
            format!("Failed to run wrangler: {e}")
        }
    })?;

    let output = wait_with_timeout(child, Duration::from_secs(timeout_secs))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!(
            "wrangler {} failed:\n{}{}",
            args.join(" "),
            stderr,
            stdout
        ))
    }
}

fn wait_with_timeout(
    child: std::process::Child,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let (tx, rx) = std::sync::mpsc::channel();

    std::thread::spawn(move || {
        let result = child.wait_with_output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(timeout) {
        Ok(result) => result.map_err(|e| format!("wrangler process error: {e}")),
        Err(_) => Err("wrangler command timed out".to_string()),
    }
}

fn parse_whoami_accounts(output: &str) -> Vec<WranglerAccount> {
    let mut accounts = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if !line.starts_with('│') && !line.starts_with('|') {
            continue;
        }
        let cols: Vec<&str> = line
            .split(['│', '|'])
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        if cols.len() >= 2 {
            let name = cols[0];
            let id = cols[1];
            // Skip header row and separator rows
            if name == "Account Name"
                || name.starts_with('-')
                || id == "Account ID"
                || id.starts_with('-')
            {
                continue;
            }
            // Account IDs are 32-char hex strings
            if id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()) {
                accounts.push(WranglerAccount {
                    name: name.to_string(),
                    id: id.to_string(),
                });
            }
        }
    }
    accounts
}

fn parse_worker_url(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(start) = trimmed.find("https://") {
            let url = &trimmed[start..];
            let url = url.split_whitespace().next().unwrap_or(url);
            if url.contains(".workers.dev") {
                return Some(url.to_string());
            }
        }
    }
    None
}

/// Build wrangler.jsonc dynamically based on available resources.
/// Starts from the compiled-in template and patches/strips bindings.
fn build_wrangler_config(resources: &ResourceFlags, worker_name: Option<&str>) -> String {
    let mut config: serde_json::Value =
        serde_json::from_str(&strip_jsonc_comments(WORKER_WRANGLER_JSONC))
            .expect("wrangler.jsonc template must be valid JSON");

    // Patch Worker name if a custom name is provided (e.g. "markupsidedown-a3f8k2")
    if let Some(name) = worker_name {
        config["name"] = serde_json::Value::String(name.to_string());
    }

    // Patch KV namespace ID or remove binding entirely
    if let Some(ref id) = resources.kv_namespace_id {
        if let Some(arr) = config.get_mut("kv_namespaces").and_then(|v| v.as_array_mut()) {
            if let Some(first) = arr.first_mut() {
                first["id"] = serde_json::Value::String(id.clone());
            }
        }
    } else {
        config.as_object_mut().map(|o| o.remove("kv_namespaces"));
    }

    // Remove R2 binding if bucket not created
    if !resources.r2_bucket {
        config.as_object_mut().map(|o| o.remove("r2_buckets"));
    }

    // Remove Queue bindings if queue not created
    if !resources.queue {
        config.as_object_mut().map(|o| o.remove("queues"));
    }

    // Remove Vectorize binding if index not created
    if !resources.vectorize {
        config.as_object_mut().map(|o| o.remove("vectorize"));
    }

    serde_json::to_string_pretty(&config).expect("JSON serialization cannot fail")
}

/// Strip // and /* */ comments from JSONC so it can be parsed as JSON.
fn strip_jsonc_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;

    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(&next) = chars.peek() {
                    out.push(next);
                    chars.next();
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            continue;
        }
        if c == '/' {
            match chars.peek() {
                Some(&'/') => {
                    // Line comment — skip to end of line
                    for nc in chars.by_ref() {
                        if nc == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                }
                Some(&'*') => {
                    // Block comment — skip to */
                    chars.next(); // consume *
                    while let Some(nc) = chars.next() {
                        if nc == '*' && chars.peek() == Some(&'/') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn write_temp_worker_files(
    dir: &Path,
    resources: &ResourceFlags,
    worker_name: Option<&str>,
) -> Result<(), String> {
    let src_dir = dir.join("src");
    std::fs::create_dir_all(&src_dir)
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;

    std::fs::write(src_dir.join("index.ts"), WORKER_INDEX_TS)
        .map_err(|e| format!("Failed to write index.ts: {e}"))?;

    let config = build_wrangler_config(resources, worker_name);
    std::fs::write(dir.join("wrangler.jsonc"), config)
        .map_err(|e| format!("Failed to write wrangler.jsonc: {e}"))?;

    Ok(())
}

// --- Resource creation ---

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ResourceFlags {
    pub kv_namespace_id: Option<String>,
    pub r2_bucket: bool,
    pub queue: bool,
    pub vectorize: bool,
}

#[derive(Serialize)]
pub struct ResourceSetupResult {
    pub resources: ResourceFlags,
    pub kv_error: Option<String>,
    pub r2_error: Option<String>,
    pub queue_error: Option<String>,
    pub vectorize_error: Option<String>,
}

fn create_kv_namespace(account_id: &str) -> Result<String, String> {
    let env = [("CLOUDFLARE_ACCOUNT_ID", account_id)];
    match run_wrangler(
        &["kv", "namespace", "create", "CACHE", "--name", "markupsidedown-converter"],
        None, 30, &env,
    ) {
        Ok(output) => parse_kv_namespace_id(&output)
            .ok_or_else(|| format!("Created KV namespace but could not parse ID from:\n{output}")),
        Err(e) if e.contains("already exists") || e.contains("already being used") => {
            // Namespace exists — find its ID by listing
            find_existing_kv_namespace(account_id)
        }
        Err(e) => Err(e),
    }
}

fn parse_kv_namespace_id(output: &str) -> Option<String> {
    // Match id = "..." or "id": "..."
    let re_toml = regex_lite::Regex::new(r#"id\s*=\s*"([0-9a-f]{32})""#).ok()?;
    let re_json = regex_lite::Regex::new(r#""id"\s*:\s*"([0-9a-f]{32})""#).ok()?;
    re_toml
        .captures(output)
        .or_else(|| re_json.captures(output))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn find_existing_kv_namespace(account_id: &str) -> Result<String, String> {
    let env = [("CLOUDFLARE_ACCOUNT_ID", account_id)];
    let output = run_wrangler(&["kv", "namespace", "list"], None, 15, &env)?;

    // Output is JSON array: [{"id":"...","title":"..."},...]
    let namespaces: Vec<serde_json::Value> =
        serde_json::from_str(&output).map_err(|e| format!("Failed to parse KV list: {e}"))?;

    for ns in &namespaces {
        let title = ns["title"].as_str().unwrap_or("");
        if title.contains("CACHE") && title.contains("markupsidedown") {
            if let Some(id) = ns["id"].as_str() {
                return Ok(id.to_string());
            }
        }
    }
    Err("KV namespace exists but could not find its ID".to_string())
}

fn create_r2_bucket(account_id: &str) -> Result<(), String> {
    let env = [("CLOUDFLARE_ACCOUNT_ID", account_id)];
    match run_wrangler(
        &["r2", "bucket", "create", "markupsidedown-publish"],
        None, 30, &env,
    ) {
        Ok(_) => Ok(()),
        Err(e) if e.contains("already exists") || e.contains("already been taken") => Ok(()),
        Err(e) => Err(e),
    }
}

fn create_queue(account_id: &str) -> Result<(), String> {
    let env = [("CLOUDFLARE_ACCOUNT_ID", account_id)];
    match run_wrangler(
        &["queues", "create", "markupsidedown-convert"],
        None, 30, &env,
    ) {
        Ok(_) => Ok(()),
        Err(e) if e.contains("already exists") => Ok(()),
        Err(e) => Err(e),
    }
}

fn create_vectorize_index(account_id: &str) -> Result<(), String> {
    let env = [("CLOUDFLARE_ACCOUNT_ID", account_id)];
    match run_wrangler(
        &[
            "vectorize", "create", "markupsidedown-docs",
            "--dimensions=768", "--metric=cosine",
        ],
        None, 30, &env,
    ) {
        Ok(_) => Ok(()),
        Err(e) if e.contains("already exists") => Ok(()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn setup_cloudflare_resources(account_id: String) -> ResourceSetupResult {
    let a1 = account_id.clone();
    let a2 = account_id.clone();
    let a3 = account_id.clone();
    let a4 = account_id.clone();

    let (kv, r2, queue, vectorize) = tokio::join!(
        tokio::task::spawn_blocking(move || create_kv_namespace(&a1)),
        tokio::task::spawn_blocking(move || create_r2_bucket(&a2)),
        tokio::task::spawn_blocking(move || create_queue(&a3)),
        tokio::task::spawn_blocking(move || create_vectorize_index(&a4)),
    );

    let (kv_id, kv_err) = match kv {
        Ok(Ok(id)) => (Some(id), None),
        Ok(Err(e)) => (None, Some(e)),
        Err(e) => (None, Some(format!("Task error: {e}"))),
    };
    let (r2_ok, r2_err) = match r2 {
        Ok(Ok(())) => (true, None),
        Ok(Err(e)) => (false, Some(e)),
        Err(e) => (false, Some(format!("Task error: {e}"))),
    };
    let (queue_ok, queue_err) = match queue {
        Ok(Ok(())) => (true, None),
        Ok(Err(e)) => (false, Some(e)),
        Err(e) => (false, Some(format!("Task error: {e}"))),
    };
    let (vec_ok, vec_err) = match vectorize {
        Ok(Ok(())) => (true, None),
        Ok(Err(e)) => (false, Some(e)),
        Err(e) => (false, Some(format!("Task error: {e}"))),
    };

    ResourceSetupResult {
        resources: ResourceFlags {
            kv_namespace_id: kv_id,
            r2_bucket: r2_ok,
            queue: queue_ok,
            vectorize: vec_ok,
        },
        kv_error: kv_err,
        r2_error: r2_err,
        queue_error: queue_err,
        vectorize_error: vec_err,
    }
}

#[tauri::command]
pub async fn check_wrangler_status() -> WranglerStatus {
    let version_handle =
        tokio::task::spawn_blocking(|| run_wrangler(&["--version"], None, 10, &[]));
    let whoami_handle =
        tokio::task::spawn_blocking(|| run_wrangler(&["whoami"], None, 15, &[]));

    let version = match version_handle.await {
        Ok(Ok(out)) => Some(out.trim().to_string()),
        _ => {
            return WranglerStatus {
                installed: false,
                logged_in: false,
                version: None,
                accounts: vec![],
            }
        }
    };

    let (logged_in, accounts) = match whoami_handle.await {
        Ok(Ok(out)) => {
            let is_logged_in = !out.contains("You are not authenticated");
            let accts = if is_logged_in {
                parse_whoami_accounts(&out)
            } else {
                vec![]
            };
            (is_logged_in, accts)
        }
        _ => (false, vec![]),
    };

    WranglerStatus {
        installed: true,
        logged_in,
        version,
        accounts,
    }
}

#[tauri::command]
pub async fn wrangler_login() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        run_wrangler(&["login"], None, 120, &[])?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn deploy_worker(
    account_id: Option<String>,
    resources: Option<ResourceFlags>,
    worker_name: Option<String>,
) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("markupsidedown-worker-deploy");
    // Clean up any previous temp dir
    let _ = std::fs::remove_dir_all(&temp_dir);

    let flags = resources.unwrap_or_default();

    let result = (|| {
        write_temp_worker_files(&temp_dir, &flags, worker_name.as_deref())?;

        if let Some(id) = account_id.as_deref() {
            let env = [("CLOUDFLARE_ACCOUNT_ID", id)];
            run_wrangler(&["deploy"], Some(&temp_dir), 120, &env)
        } else {
            run_wrangler(&["deploy"], Some(&temp_dir), 120, &[])
        }
    })();

    // Always clean up temp dir
    let _ = std::fs::remove_dir_all(&temp_dir);

    let output = result?;
    parse_worker_url(&output)
        .ok_or_else(|| format!("Worker deployed but could not parse URL from output:\n{output}"))
}

#[tauri::command]
pub async fn setup_worker_secrets(
    account_id: String,
    worker_name: Option<String>,
) -> Result<(), String> {
    // 1. Process env var (works in CLI / CI)
    // 2. Login shell env var (macOS GUI apps don't inherit shell env)
    // 3. Create scoped token via OAuth (last resort)
    let api_token = if let Some(t) = get_env_token().or_else(get_env_token_from_shell) {
        t
    } else {
        create_api_token_via_oauth(&account_id).await?
    };

    set_secrets_with_token(account_id, api_token, worker_name).await
}

#[tauri::command]
pub async fn setup_worker_secrets_with_token(
    account_id: String,
    api_token: String,
    worker_name: Option<String>,
) -> Result<(), String> {
    set_secrets_with_token(account_id, api_token, worker_name).await
}

async fn set_secrets_with_token(
    account_id: String,
    api_token: String,
    worker_name: Option<String>,
) -> Result<(), String> {
    let name = worker_name.unwrap_or_else(|| "markupsidedown-converter".to_string());
    let name1 = name.clone();
    let name2 = name;
    let acct_for_r1 = account_id.clone();
    let acct_for_r2 = account_id.clone();
    let (r1, r2) = tokio::join!(
        tokio::task::spawn_blocking(move || {
            set_wrangler_secret("CLOUDFLARE_ACCOUNT_ID", &account_id, &acct_for_r1, &name1)
        }),
        tokio::task::spawn_blocking(move || {
            set_wrangler_secret("CLOUDFLARE_API_TOKEN", &api_token, &acct_for_r2, &name2)
        }),
    );
    r1.map_err(|e| format!("Task error: {e}"))??;
    r2.map_err(|e| format!("Task error: {e}"))??;

    Ok(())
}

fn get_env_token() -> Option<String> {
    std::env::var("CLOUDFLARE_API_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
}

/// Read CLOUDFLARE_API_TOKEN from the user's default shell.
/// macOS GUI apps don't inherit shell env, so we spawn a non-interactive login
/// shell which sources ~/.zshenv (zsh) or ~/.profile (bash) to pick up exports.
/// We avoid `-i` (interactive) because it hangs without a TTY.
fn get_env_token_from_shell() -> Option<String> {
    let home = crate::util::home_dir()?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let child = Command::new(&shell)
        .args(["-lc", "printf '%s' \"$CLOUDFLARE_API_TOKEN\""])
        .env("HOME", &home)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let output = wait_with_timeout(child, Duration::from_secs(10)).ok()?;
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn set_wrangler_secret(
    name: &str,
    value: &str,
    account_id: &str,
    worker_name: &str,
) -> Result<(), String> {
    let mut cmd = Command::new("wrangler");
    cmd.args(["secret", "put", name, "--name", worker_name])
        .env("CLOUDFLARE_ACCOUNT_ID", account_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    setup_gui_env(&mut cmd);
    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to run wrangler secret put: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(value.as_bytes())
            .map_err(|e| format!("Failed to write secret value: {e}"))?;
    }

    let output = wait_with_timeout(child, Duration::from_secs(15))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to set secret {name}: {stderr}"))
    }
}

/// Extract the actual token from `wrangler auth token` output, skipping the banner lines.
fn extract_wrangler_token(output: &str) -> Option<String> {
    output
        .lines()
        .rev()
        .find(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && !trimmed.starts_with('⛅') && !trimmed.starts_with('─')
        })
        .map(|line| line.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Try to create a scoped API token using wrangler's OAuth token.
async fn create_api_token_via_oauth(account_id: &str) -> Result<String, String> {
    let oauth_token = tokio::task::spawn_blocking(|| {
        run_wrangler(&["auth", "token"], None, 10, &[])
            .map_err(|e| format!("Failed to get auth token: {e}"))
            .and_then(|output| {
                extract_wrangler_token(&output)
                    .ok_or_else(|| "Could not extract OAuth token from wrangler output".to_string())
            })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))??;

    create_scoped_api_token(&oauth_token, account_id).await
}

async fn create_scoped_api_token(oauth_token: &str, account_id: &str) -> Result<String, String> {
    let client = reqwest::Client::new();

    // Look up permission group IDs
    let groups_resp: serde_json::Value = client
        .get("https://api.cloudflare.com/client/v4/user/tokens/permission_groups")
        .bearer_auth(oauth_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch permission groups: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse permission groups: {e}"))?;

    let groups = groups_resp["result"].as_array().ok_or_else(|| {
        if groups_resp["success"].as_bool() == Some(false) {
            let errors = &groups_resp["errors"];
            format!("Permission groups API error: {errors}. Try setting CLOUDFLARE_API_TOKEN env var instead")
        } else {
            format!("Unexpected permission groups response: {groups_resp}")
        }
    })?;

    let browser_rendering_id = groups
        .iter()
        .find(|g| {
            let name = g["name"].as_str().unwrap_or("");
            name.contains("Browser Rendering") && name.contains("Edit")
        })
        .and_then(|g| g["id"].as_str())
        .ok_or("Could not find Browser Rendering Edit permission group")?;

    let workers_ai_id = groups
        .iter()
        .find(|g| {
            let name = g["name"].as_str().unwrap_or("");
            name.contains("Workers AI") && name.contains("Read")
        })
        .and_then(|g| g["id"].as_str())
        .ok_or("Could not find Workers AI Read permission group")?;

    // Create the scoped token
    let body = serde_json::json!({
        "name": "MarkUpsideDown Worker (auto-created)",
        "policies": [{
            "effect": "allow",
            "resources": {
                format!("com.cloudflare.api.account.{account_id}"): "*"
            },
            "permission_groups": [
                { "id": browser_rendering_id },
                { "id": workers_ai_id }
            ]
        }]
    });

    let token_resp: serde_json::Value = client
        .post("https://api.cloudflare.com/client/v4/user/tokens")
        .bearer_auth(oauth_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create API token: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {e}"))?;

    if token_resp["success"].as_bool() != Some(true) {
        let errors = &token_resp["errors"];
        return Err(format!("Failed to create API token: {errors}"));
    }

    token_resp["result"]["value"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "API token created but value not found in response".to_string())
}
