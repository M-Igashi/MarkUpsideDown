use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

// All worker source files embedded at compile time
const WORKER_INDEX_TS: &str = include_str!("../../worker/src/index.ts");
const WORKER_TYPES_TS: &str = include_str!("../../worker/src/types.ts");
const WORKER_UTILS_TS: &str = include_str!("../../worker/src/utils.ts");
const WORKER_SSRF_TS: &str = include_str!("../../worker/src/ssrf.ts");
const WORKER_CONFIG_TS: &str = include_str!("../../worker/src/config.ts");
const WORKER_HANDLER_HEALTH_TS: &str = include_str!("../../worker/src/handlers/health.ts");
const WORKER_HANDLER_FETCH_TS: &str = include_str!("../../worker/src/handlers/fetch.ts");
const WORKER_HANDLER_CONVERT_TS: &str = include_str!("../../worker/src/handlers/convert.ts");
const WORKER_HANDLER_RENDER_TS: &str = include_str!("../../worker/src/handlers/render.ts");
const WORKER_HANDLER_JSON_TS: &str = include_str!("../../worker/src/handlers/json.ts");
const WORKER_HANDLER_CRAWL_TS: &str = include_str!("../../worker/src/handlers/crawl.ts");
const WORKER_HANDLER_PUBLISH_TS: &str = include_str!("../../worker/src/handlers/publish.ts");
const WORKER_HANDLER_EMBED_TS: &str = include_str!("../../worker/src/handlers/embed.ts");
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
pub(crate) fn setup_gui_env(cmd: &mut Command) {
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
    // Remove CLOUDFLARE_API_TOKEN from inherited env so wrangler always uses
    // the OAuth login session, unless we explicitly pass it.
    if !env.iter().any(|(k, _)| *k == "CLOUDFLARE_API_TOKEN") {
        cmd.env_remove("CLOUDFLARE_API_TOKEN");
    }
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

    // Remove R2 binding (and the expired-document cleanup cron) if bucket not created
    if !resources.r2_bucket {
        config.as_object_mut().map(|o| {
            o.remove("r2_buckets");
            o.remove("triggers");
        });
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
    let handlers_dir = src_dir.join("handlers");
    std::fs::create_dir_all(&handlers_dir)
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;

    // Write all worker source files
    let root_files: &[(&str, &str)] = &[
        ("index.ts", WORKER_INDEX_TS),
        ("types.ts", WORKER_TYPES_TS),
        ("utils.ts", WORKER_UTILS_TS),
        ("ssrf.ts", WORKER_SSRF_TS),
        ("config.ts", WORKER_CONFIG_TS),
    ];
    for (name, content) in root_files {
        std::fs::write(src_dir.join(name), content)
            .map_err(|e| format!("Failed to write {name}: {e}"))?;
    }

    let handler_files: &[(&str, &str)] = &[
        ("health.ts", WORKER_HANDLER_HEALTH_TS),
        ("fetch.ts", WORKER_HANDLER_FETCH_TS),
        ("convert.ts", WORKER_HANDLER_CONVERT_TS),
        ("render.ts", WORKER_HANDLER_RENDER_TS),
        ("json.ts", WORKER_HANDLER_JSON_TS),
        ("crawl.ts", WORKER_HANDLER_CRAWL_TS),
        ("publish.ts", WORKER_HANDLER_PUBLISH_TS),
        ("embed.ts", WORKER_HANDLER_EMBED_TS),
    ];
    for (name, content) in handler_files {
        std::fs::write(handlers_dir.join(name), content)
            .map_err(|e| format!("Failed to write handlers/{name}: {e}"))?;
    }

    let config = build_wrangler_config(resources, worker_name);
    std::fs::write(dir.join("wrangler.jsonc"), config)
        .map_err(|e| format!("Failed to write wrangler.jsonc: {e}"))?;

    Ok(())
}

// --- Resource creation ---

/// Resources that must exist before deploy. The other bindings (AI, Browser
/// Run, AI Search) need no setup: the AI Search instance is created on first use.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ResourceFlags {
    pub r2_bucket: bool,
}

#[derive(Serialize)]
pub struct ResourceSetupResult {
    pub resources: ResourceFlags,
    pub r2_error: Option<String>,
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

#[tauri::command]
pub async fn setup_cloudflare_resources(account_id: String) -> ResourceSetupResult {
    let (r2_bucket, r2_error) =
        match tokio::task::spawn_blocking(move || create_r2_bucket(&account_id)).await {
            Ok(Ok(())) => (true, None),
            Ok(Err(e)) => (false, Some(e)),
            Err(e) => (false, Some(format!("Task error: {e}"))),
        };
    ResourceSetupResult {
        resources: ResourceFlags { r2_bucket },
        r2_error,
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
pub async fn wrangler_login() -> crate::error::Result<()> {
    tokio::task::spawn_blocking(|| {
        run_wrangler(&["login"], None, 120, &[])
            .map_err(crate::error::AppError::Wrangler)?;
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn deploy_worker(
    account_id: Option<String>,
    resources: Option<ResourceFlags>,
    worker_name: Option<String>,
) -> crate::error::Result<String> {
    use crate::error::AppError;
    let result = tokio::task::spawn_blocking(move || {
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
        result
    })
    .await?;

    let output = result.map_err(AppError::Wrangler)?;
    parse_worker_url(&output)
        .ok_or_else(|| AppError::Wrangler(format!("Worker deployed but could not parse URL from output:\n{output}")))
}

/// Store the crawl secrets. Only /crawl needs them: it is the one Browser Run
/// endpoint that the Worker's browser binding does not cover. The token has
/// to come from the user, because wrangler's OAuth login cannot create API
/// tokens.
#[tauri::command]
pub async fn setup_worker_secrets_with_token(
    account_id: String,
    api_token: String,
    worker_name: Option<String>,
) -> crate::error::Result<()> {
    use crate::error::AppError;
    let name = worker_name.unwrap_or_else(|| "markupsidedown-converter".to_string());
    let name1 = name.clone();
    let name2 = name;
    let acct_for_r1 = account_id.clone();
    let acct_for_r2 = account_id.clone();
    let (r1, r2) = tokio::join!(
        tokio::task::spawn_blocking(move || {
            set_wrangler_secret("CLOUDFLARE_ACCOUNT_ID", &account_id, Some(&acct_for_r1), &name1)
        }),
        tokio::task::spawn_blocking(move || {
            set_wrangler_secret("CLOUDFLARE_API_TOKEN", &api_token, Some(&acct_for_r2), &name2)
        }),
    );
    r1?.map_err(AppError::Wrangler)?;
    r2?.map_err(AppError::Wrangler)?;

    Ok(())
}

#[tauri::command]
pub async fn set_r2_public_url(
    account_id: String,
    worker_name: String,
    url: String,
) -> crate::error::Result<()> {
    use crate::error::AppError;
    tokio::task::spawn_blocking(move || {
        set_wrangler_secret("R2_PUBLIC_URL", &url, Some(&account_id), &worker_name)
    })
    .await?
    .map_err(AppError::Wrangler)?;
    Ok(())
}

/// Set the API key that the Worker requires on every non-public route.
#[tauri::command]
pub async fn set_worker_api_key(
    account_id: Option<String>,
    worker_name: String,
    api_key: String,
) -> crate::error::Result<()> {
    use crate::error::AppError;
    tokio::task::spawn_blocking(move || {
        set_wrangler_secret("API_KEY", &api_key, account_id.as_deref(), &worker_name)
    })
    .await?
    .map_err(AppError::Wrangler)?;
    Ok(())
}


fn set_wrangler_secret(
    name: &str,
    value: &str,
    account_id: Option<&str>,
    worker_name: &str,
) -> Result<(), String> {
    let mut cmd = Command::new("wrangler");
    cmd.args(["secret", "put", name, "--name", worker_name])
        .env_remove("CLOUDFLARE_API_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(id) = account_id {
        cmd.env("CLOUDFLARE_ACCOUNT_ID", id);
    }
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
