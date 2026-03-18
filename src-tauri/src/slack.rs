use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

// --- User cache (session-scoped) ---

#[derive(Default)]
pub struct SlackUserCache {
    users: Mutex<HashMap<String, String>>,
}

// --- Tauri command response types ---

#[derive(Serialize)]
pub struct SlackTokenStatus {
    pub valid: bool,
    pub team: Option<String>,
    pub user: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct SlackImportResult {
    pub markdown: String,
    pub message_count: u32,
    pub channel_name: Option<String>,
}

// --- Slack API response types ---

#[derive(Deserialize)]
struct AuthTestResponse {
    ok: bool,
    team: Option<String>,
    user: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ConversationsHistoryResponse {
    ok: bool,
    messages: Option<Vec<SlackMessage>>,
    has_more: Option<bool>,
    response_metadata: Option<ResponseMetadata>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ConversationsRepliesResponse {
    ok: bool,
    messages: Option<Vec<SlackMessage>>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ConversationsInfoResponse {
    ok: bool,
    channel: Option<ChannelInfo>,
    #[allow(dead_code)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct ChannelInfo {
    name: Option<String>,
}

#[derive(Deserialize)]
struct UsersInfoResponse {
    ok: bool,
    user: Option<UserInfo>,
}

#[derive(Deserialize)]
struct UserInfo {
    profile: Option<UserProfile>,
}

#[derive(Deserialize)]
struct UserProfile {
    display_name: Option<String>,
    real_name: Option<String>,
}

#[derive(Deserialize)]
struct ResponseMetadata {
    next_cursor: Option<String>,
}

#[derive(Deserialize, Clone)]
struct SlackMessage {
    #[serde(rename = "type")]
    _type: Option<String>,
    user: Option<String>,
    text: Option<String>,
    ts: Option<String>,
    #[allow(dead_code)]
    thread_ts: Option<String>,
    reply_count: Option<u32>,
    reactions: Option<Vec<Reaction>>,
    files: Option<Vec<SlackFile>>,
    subtype: Option<String>,
}

#[derive(Deserialize, Clone)]
struct Reaction {
    name: Option<String>,
    count: Option<u32>,
}

#[derive(Deserialize, Clone)]
struct SlackFile {
    name: Option<String>,
    url_private: Option<String>,
}

// --- Slack URL parser ---

pub struct SlackRef {
    pub channel_id: String,
    pub thread_ts: Option<String>,
}

fn parse_slack_url(input: &str) -> Option<SlackRef> {
    let input = input.trim();

    // Full archive URL: https://WORKSPACE.slack.com/archives/C12345/p1234567890123456
    if let Some(caps) = regex_lite::Regex::new(
        r"slack\.com/archives/([A-Z0-9]+)(?:/p(\d+))?",
    )
    .ok()
    .and_then(|re| re.captures(input))
    {
        let channel_id = caps.get(1)?.as_str().to_string();
        let thread_ts = caps.get(2).map(|m| {
            let digits = m.as_str();
            if digits.len() > 6 {
                let (secs, micro) = digits.split_at(digits.len() - 6);
                format!("{secs}.{micro}")
            } else {
                digits.to_string()
            }
        });
        return Some(SlackRef {
            channel_id,
            thread_ts,
        });
    }

    // app.slack.com URL with thread: .../thread/C12345-1234567890.123456
    if let Some(caps) = regex_lite::Regex::new(
        r"slack\.com/client/[A-Z0-9]+/([A-Z0-9]+)(?:/thread/[A-Z0-9]+-(\d+\.\d+))?",
    )
    .ok()
    .and_then(|re| re.captures(input))
    {
        let channel_id = caps.get(1)?.as_str().to_string();
        let thread_ts = caps.get(2).map(|m| m.as_str().to_string());
        return Some(SlackRef {
            channel_id,
            thread_ts,
        });
    }

    // Raw channel ID (C/G/D followed by alphanumeric)
    if regex_lite::Regex::new(r"^[CGD][A-Z0-9]{8,}$")
        .ok()?
        .is_match(input)
    {
        return Some(SlackRef {
            channel_id: input.to_string(),
            thread_ts: None,
        });
    }

    None
}

// --- Slack mrkdwn → Markdown converter ---

fn slack_mrkdwn_to_markdown(text: &str, user_names: &HashMap<String, String>) -> String {
    let mut result = text.to_string();

    // User mentions: <@U12345> → @display_name
    let user_re = regex_lite::Regex::new(r"<@([A-Z0-9]+)>").unwrap();
    result = user_re
        .replace_all(&result, |caps: &regex_lite::Captures| {
            let uid = &caps[1];
            match user_names.get(uid) {
                Some(name) => format!("@{name}"),
                None => format!("@{uid}"),
            }
        })
        .to_string();

    // Channel mentions: <#C12345|general> → #general
    let chan_re = regex_lite::Regex::new(r"<#[A-Z0-9]+\|([^>]+)>").unwrap();
    result = chan_re.replace_all(&result, "#$1").to_string();

    // Links with label: <URL|label> → [label](URL)
    let link_label_re = regex_lite::Regex::new(r"<(https?://[^|>]+)\|([^>]+)>").unwrap();
    result = link_label_re.replace_all(&result, "[$2]($1)").to_string();

    // Plain links: <URL> → URL
    let link_re = regex_lite::Regex::new(r"<(https?://[^>]+)>").unwrap();
    result = link_re.replace_all(&result, "$1").to_string();

    // Special mentions
    result = result.replace("<!here>", "@here");
    result = result.replace("<!channel>", "@channel");
    result = result.replace("<!everyone>", "@everyone");
    result = result.replace("<!here|here>", "@here");
    result = result.replace("<!channel|channel>", "@channel");
    result = result.replace("<!everyone|everyone>", "@everyone");

    // Bold: *text* → **text** (but not inside code spans/blocks)
    // Simple approach: replace *word(s)* patterns
    let bold_re = regex_lite::Regex::new(r"(?<!\*)\*([^\*\n]+)\*(?!\*)").unwrap();
    result = bold_re.replace_all(&result, "**$1**").to_string();

    // Italic: _text_ → *text*
    let italic_re = regex_lite::Regex::new(r"(?<![_\w])_([^_\n]+)_(?![_\w])").unwrap();
    result = italic_re.replace_all(&result, "*$1*").to_string();

    // Strikethrough: ~text~ → ~~text~~
    let strike_re = regex_lite::Regex::new(r"(?<!~)~([^~\n]+)~(?!~)").unwrap();
    result = strike_re.replace_all(&result, "~~$1~~").to_string();

    result
}

// --- Resolve user ID to display name ---

async fn resolve_user(
    user_id: &str,
    token: &str,
    client: &reqwest::Client,
    cache: &SlackUserCache,
) -> String {
    // Check cache first
    {
        let users = cache.users.lock().unwrap();
        if let Some(name) = users.get(user_id) {
            return name.clone();
        }
    }

    // Fetch from API
    let url = format!("https://slack.com/api/users.info?user={user_id}");
    let name = match client
        .get(&url)
        .bearer_auth(token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => match resp.json::<UsersInfoResponse>().await {
            Ok(body) if body.ok => body
                .user
                .and_then(|u| u.profile)
                .and_then(|p| {
                    p.display_name
                        .filter(|n| !n.is_empty())
                        .or(p.real_name)
                })
                .unwrap_or_else(|| user_id.to_string()),
            _ => user_id.to_string(),
        },
        Err(_) => user_id.to_string(),
    };

    // Cache result
    {
        let mut users = cache.users.lock().unwrap();
        users.insert(user_id.to_string(), name.clone());
    }

    name
}

// --- Resolve all user mentions in a batch of messages ---

async fn resolve_users_in_messages(
    messages: &[SlackMessage],
    token: &str,
    client: &reqwest::Client,
    cache: &SlackUserCache,
) -> HashMap<String, String> {
    let user_re = regex_lite::Regex::new(r"<@([A-Z0-9]+)>").unwrap();
    let mut user_ids = std::collections::HashSet::new();

    for msg in messages {
        if let Some(text) = &msg.text {
            for caps in user_re.captures_iter(text) {
                user_ids.insert(caps[1].to_string());
            }
        }
        if let Some(uid) = &msg.user {
            user_ids.insert(uid.clone());
        }
    }

    let mut names = HashMap::new();
    for uid in user_ids {
        let name = resolve_user(&uid, token, client, cache).await;
        names.insert(uid, name);
    }
    names
}

// --- Format timestamp ---

fn format_ts(ts: &str) -> String {
    let secs: f64 = ts.parse().unwrap_or(0.0);
    let secs = secs as i64;
    let dt = chrono::DateTime::from_timestamp(secs, 0);
    match dt {
        Some(dt) => dt.format("%Y-%m-%d %H:%M").to_string(),
        None => ts.to_string(),
    }
}

fn format_date(ts: &str) -> String {
    let secs: f64 = ts.parse().unwrap_or(0.0);
    let secs = secs as i64;
    let dt = chrono::DateTime::from_timestamp(secs, 0);
    match dt {
        Some(dt) => dt.format("%Y-%m-%d").to_string(),
        None => ts.to_string(),
    }
}

// --- Format a single message to Markdown ---

fn format_message(
    msg: &SlackMessage,
    user_names: &HashMap<String, String>,
    is_reply: bool,
) -> String {
    // Skip join/leave/bot messages
    if let Some(subtype) = &msg.subtype {
        match subtype.as_str() {
            "channel_join" | "channel_leave" | "bot_message" => return String::new(),
            _ => {}
        }
    }

    let user_name = msg
        .user
        .as_ref()
        .and_then(|uid| user_names.get(uid))
        .cloned()
        .unwrap_or_else(|| "Unknown".to_string());

    let time = msg.ts.as_deref().map(format_ts).unwrap_or_default();

    let text = msg
        .text
        .as_deref()
        .map(|t| slack_mrkdwn_to_markdown(t, user_names))
        .unwrap_or_default();

    let mut lines = Vec::new();

    if is_reply {
        lines.push(format!("> **@{user_name}** ({time}) _(reply)_"));
        for line in text.lines() {
            lines.push(format!("> {line}"));
        }
    } else {
        lines.push(format!("**@{user_name}** ({time})"));
        lines.push(text);
    }

    // Reactions
    if let Some(reactions) = &msg.reactions {
        let parts: Vec<String> = reactions
            .iter()
            .filter_map(|r| {
                let name = r.name.as_deref()?;
                let count = r.count.unwrap_or(1);
                Some(format!(":{name}: x{count}"))
            })
            .collect();
        if !parts.is_empty() {
            let prefix = if is_reply { "> " } else { "" };
            lines.push(format!("{prefix}Reactions: {}", parts.join(", ")));
        }
    }

    // File attachments
    if let Some(files) = &msg.files {
        for file in files {
            let name = file.name.as_deref().unwrap_or("file");
            let url = file
                .url_private
                .as_deref()
                .unwrap_or("#");
            let prefix = if is_reply { "> " } else { "" };
            lines.push(format!("{prefix}Attachment: [{name}]({url})"));
        }
    }

    lines.join("\n")
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn test_slack_token(
    token: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<SlackTokenStatus, String> {
    let resp = client
        .post("https://slack.com/api/auth.test")
        .bearer_auth(&token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let body: AuthTestResponse = resp.json().await.map_err(|e| format!("Parse error: {e}"))?;

    Ok(SlackTokenStatus {
        valid: body.ok,
        team: body.team,
        user: body.user,
        error: body.error,
    })
}

#[tauri::command]
pub async fn fetch_slack_channel(
    token: String,
    channel_id: String,
    limit: Option<u32>,
    client: tauri::State<'_, reqwest::Client>,
    cache: tauri::State<'_, SlackUserCache>,
) -> Result<SlackImportResult, String> {
    let max_messages = limit.unwrap_or(200).min(1000);
    let mut all_messages: Vec<SlackMessage> = Vec::new();
    let mut cursor: Option<String> = None;

    // Fetch channel name
    let channel_name = fetch_channel_name(&token, &channel_id, &client).await;

    // Paginate through conversations.history
    loop {
        let mut url = format!(
            "https://slack.com/api/conversations.history?channel={channel_id}&limit=100"
        );
        if let Some(c) = &cursor {
            url.push_str(&format!("&cursor={c}"));
        }

        let resp = client
            .get(&url)
            .bearer_auth(&token)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let body: ConversationsHistoryResponse =
            resp.json().await.map_err(|e| format!("Parse error: {e}"))?;

        if !body.ok {
            return Err(body.error.unwrap_or_else(|| "Unknown error".to_string()));
        }

        if let Some(messages) = body.messages {
            all_messages.extend(messages);
        }

        if all_messages.len() as u32 >= max_messages {
            all_messages.truncate(max_messages as usize);
            break;
        }

        let has_more = body.has_more.unwrap_or(false);
        let next = body
            .response_metadata
            .and_then(|m| m.next_cursor)
            .filter(|c| !c.is_empty());

        if !has_more || next.is_none() {
            break;
        }
        cursor = next;
    }

    // Messages come newest-first; reverse for chronological order
    all_messages.reverse();

    // Resolve user names
    let user_names = resolve_users_in_messages(&all_messages, &token, &client, &cache).await;

    // Format to Markdown
    let message_count = all_messages.len() as u32;
    let markdown = format_channel_markdown(&channel_name, &all_messages, &user_names);

    Ok(SlackImportResult {
        markdown,
        message_count,
        channel_name,
    })
}

#[tauri::command]
pub async fn fetch_slack_thread(
    token: String,
    channel_id: String,
    thread_ts: String,
    client: tauri::State<'_, reqwest::Client>,
    cache: tauri::State<'_, SlackUserCache>,
) -> Result<SlackImportResult, String> {
    let url = format!(
        "https://slack.com/api/conversations.replies?channel={channel_id}&ts={thread_ts}&limit=200"
    );

    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let body: ConversationsRepliesResponse =
        resp.json().await.map_err(|e| format!("Parse error: {e}"))?;

    if !body.ok {
        return Err(body.error.unwrap_or_else(|| "Unknown error".to_string()));
    }

    let messages = body.messages.unwrap_or_default();
    let channel_name = fetch_channel_name(&token, &channel_id, &client).await;

    // Resolve user names
    let user_names = resolve_users_in_messages(&messages, &token, &client, &cache).await;

    // Format: first message is the parent, rest are replies
    let message_count = messages.len() as u32;
    let mut parts = Vec::new();

    if let Some(ch) = &channel_name {
        parts.push(format!("# #{ch} — Thread"));
    } else {
        parts.push("# Thread".to_string());
    }
    parts.push(String::new());

    for (i, msg) in messages.iter().enumerate() {
        let formatted = format_message(msg, &user_names, i > 0);
        if !formatted.is_empty() {
            parts.push(formatted);
            parts.push(String::new());
        }
    }

    Ok(SlackImportResult {
        markdown: parts.join("\n"),
        message_count,
        channel_name,
    })
}

#[tauri::command]
pub fn parse_slack_input(input: String) -> Result<(String, Option<String>), String> {
    match parse_slack_url(&input) {
        Some(r) => Ok((r.channel_id, r.thread_ts)),
        None => Err("Invalid Slack URL or channel ID. Use a Slack archive URL or channel ID (e.g. C01234ABCDE).".to_string()),
    }
}

// --- Helpers ---

async fn fetch_channel_name(
    token: &str,
    channel_id: &str,
    client: &reqwest::Client,
) -> Option<String> {
    let url = format!("https://slack.com/api/conversations.info?channel={channel_id}");
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    let body: ConversationsInfoResponse = resp.json().await.ok()?;
    if body.ok {
        body.channel.and_then(|c| c.name)
    } else {
        None
    }
}

fn format_channel_markdown(
    channel_name: &Option<String>,
    messages: &[SlackMessage],
    user_names: &HashMap<String, String>,
) -> String {
    let mut parts = Vec::new();

    // Header
    if let Some(name) = channel_name {
        parts.push(format!("# #{name}"));
    } else {
        parts.push("# Slack Channel".to_string());
    }
    parts.push(String::new());

    // Group messages by date
    let mut current_date = String::new();

    for msg in messages {
        let date = msg.ts.as_deref().map(format_date).unwrap_or_default();
        if date != current_date && !date.is_empty() {
            if !current_date.is_empty() {
                parts.push("---".to_string());
                parts.push(String::new());
            }
            parts.push(format!("## {date}"));
            parts.push(String::new());
            current_date = date;
        }

        let formatted = format_message(msg, user_names, false);
        if !formatted.is_empty() {
            parts.push(formatted);

            // Indicate thread replies count if any
            if let Some(count) = msg.reply_count {
                if count > 0 {
                    parts.push(format!("_{count} replies in thread_"));
                }
            }

            parts.push(String::new());
        }
    }

    parts.join("\n")
}
