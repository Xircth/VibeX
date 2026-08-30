//! Last contiguous assistant reply from a delegated child turn.
//!
//! Tool calls split the stream. The parent card wants the final answer, not
//! planning text that preceded tools.

#[derive(Debug, Default)]
pub struct AssistantReplyAccumulator {
    current: String,
    last_nonempty: String,
}

impl AssistantReplyAccumulator {
    pub fn push_text(&mut self, text: &str) {
        self.current.push_str(text);
    }

    pub fn start_tool(&mut self) {
        if !self.current.trim().is_empty() {
            self.last_nonempty = std::mem::take(&mut self.current);
        } else {
            self.current.clear();
        }
    }

    pub fn finish(self) -> String {
        if !self.current.trim().is_empty() {
            self.current
        } else {
            self.last_nonempty
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AssistantReplyAccumulator;

    #[test]
    fn keeps_the_whole_reply_when_there_are_no_tools() {
        let mut acc = AssistantReplyAccumulator::default();
        acc.push_text("你好，");
        acc.push_text("我是 Codex。");
        assert_eq!(acc.finish(), "你好，我是 Codex。");
    }

    #[test]
    fn keeps_the_final_segment_after_tools() {
        let mut acc = AssistantReplyAccumulator::default();
        acc.push_text("I'll look at the files.");
        acc.start_tool();
        acc.push_text("The tests pass.");
        acc.start_tool();
        acc.push_text("Done. The change is ready.");
        assert_eq!(acc.finish(), "Done. The change is ready.");
    }

    #[test]
    fn falls_back_to_the_last_nonempty_segment_if_a_tool_ends_the_turn() {
        let mut acc = AssistantReplyAccumulator::default();
        acc.push_text("Here is the patch.");
        acc.start_tool();
        assert_eq!(acc.finish(), "Here is the patch.");
    }
}
