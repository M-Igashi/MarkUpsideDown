use serde::Serialize;

/// Alias used by all Tauri commands and internal helpers.
pub type Result<T> = std::result::Result<T, AppError>;

/// Structured error type for the MarkUpsideDown backend.
///
/// Each variant represents a distinct error domain so callers can
/// programmatically distinguish categories while still receiving
/// human-readable messages via the `Display` impl.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// File-system I/O errors (read, write, create, delete, etc.).
    #[error("{0}")]
    Io(String),

    /// HTTP / network errors (reqwest, timeout, DNS, etc.).
    #[error("{0}")]
    Network(String),

    /// Git CLI errors (stderr output or execution failures).
    #[error("{0}")]
    Git(String),

    /// Cloudflare Worker API errors (response-level errors).
    #[error("{0}")]
    Worker(String),

    /// Input validation errors (path traversal, invalid URL scheme, etc.).
    #[error("{0}")]
    Validation(String),

    /// Tauri plugin-store errors (serialization, persistence).
    #[error("{0}")]
    Store(String),

    /// Wrangler CLI errors (deploy, secrets, resource creation).
    #[error("{0}")]
    Wrangler(String),

    /// Async task join errors (`tokio::task::spawn_blocking` panics).
    #[error("Task error: {0}")]
    Task(#[from] tokio::task::JoinError),
}

/// Serialize as a plain string so the frontend receives the same error
/// messages it got from the old `Result<T, String>` return type.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
