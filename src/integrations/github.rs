use anyhow::Result;
use std::process::Command;

/// Fetch a GitHub Issue body as Markdown via `gh` CLI.
pub fn fetch_issue(owner: &str, repo: &str, number: u64) -> Result<String> {
    let output = Command::new("gh")
        .args(["issue", "view", &number.to_string()])
        .args(["--repo", &format!("{owner}/{repo}")])
        .args(["--json", "body"])
        .args(["--jq", ".body"])
        .output()?;

    if !output.status.success() {
        anyhow::bail!(
            "gh issue view failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}

/// Fetch a GitHub PR body as Markdown via `gh` CLI.
pub fn fetch_pull_request(owner: &str, repo: &str, number: u64) -> Result<String> {
    let output = Command::new("gh")
        .args(["pr", "view", &number.to_string()])
        .args(["--repo", &format!("{owner}/{repo}")])
        .args(["--json", "body"])
        .args(["--jq", ".body"])
        .output()?;

    if !output.status.success() {
        anyhow::bail!(
            "gh pr view failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}

/// List repositories for the authenticated user.
pub fn list_repos() -> Result<Vec<String>> {
    let output = Command::new("gh")
        .args(["repo", "list", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"])
        .output()?;

    if !output.status.success() {
        anyhow::bail!(
            "gh repo list failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let repos = String::from_utf8(output.stdout)?
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    Ok(repos)
}
