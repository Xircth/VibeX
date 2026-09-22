use thiserror::Error;

#[derive(Debug, Error)]
#[error("{code}: {message}")]
pub struct BrowserHostError {
    code: &'static str,
    message: String,
}

impl BrowserHostError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}
