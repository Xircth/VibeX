#[derive(Debug, Clone, Default)]
pub(super) struct StreamingState {
    pub assistant_text: Option<StreamingText>,
    pub thinking_text: Option<StreamingText>,
}

#[derive(Debug, Clone)]
pub(super) struct StreamingText {
    pub index: usize,
    pub content: String,
}

pub(super) fn merge_streaming_text(current: &mut String, incoming: &str) {
    if incoming.is_empty() {
        return;
    }

    if current.is_empty() {
        current.push_str(incoming);
        return;
    }

    if incoming.starts_with(current.as_str()) {
        current.clear();
        current.push_str(incoming);
        return;
    }

    if current.starts_with(incoming) {
        return;
    }

    current.push_str(incoming);
}
