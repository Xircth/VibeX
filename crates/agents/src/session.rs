use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::AgentPromptId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum QueueTransition {
    Started { prompt_id: AgentPromptId },
    Queued { prompt_id: AgentPromptId },
    Completed {
        completed: AgentPromptId,
        next: Option<AgentPromptId>,
    },
    Cancelled {
        cancelled: AgentPromptId,
        next: Option<AgentPromptId>,
    },
    Missing { prompt_id: AgentPromptId },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentPromptQueue {
    active: Option<AgentPromptId>,
    queued: VecDeque<AgentPromptId>,
}

impl AgentPromptQueue {
    pub fn active(&self) -> Option<AgentPromptId> {
        self.active
    }

    pub fn queued(&self) -> Vec<AgentPromptId> {
        self.queued.iter().copied().collect()
    }

    pub fn submit(&mut self, prompt_id: AgentPromptId) -> QueueTransition {
        if self.active.is_none() {
            self.active = Some(prompt_id);
            QueueTransition::Started { prompt_id }
        } else {
            self.queued.push_back(prompt_id);
            QueueTransition::Queued { prompt_id }
        }
    }

    pub fn complete(&mut self, prompt_id: AgentPromptId) -> QueueTransition {
        if self.active == Some(prompt_id) {
            let next = self.queued.pop_front();
            self.active = next;
            return QueueTransition::Completed {
                completed: prompt_id,
                next,
            };
        }

        if let Some(index) = self.queued.iter().position(|queued| *queued == prompt_id) {
            self.queued.remove(index);
            return QueueTransition::Completed {
                completed: prompt_id,
                next: self.active,
            };
        }

        QueueTransition::Missing { prompt_id }
    }

    pub fn cancel(&mut self, prompt_id: AgentPromptId) -> QueueTransition {
        if self.active == Some(prompt_id) {
            let next = self.queued.pop_front();
            self.active = next;
            return QueueTransition::Cancelled {
                cancelled: prompt_id,
                next,
            };
        }

        if let Some(index) = self.queued.iter().position(|queued| *queued == prompt_id) {
            self.queued.remove(index);
            return QueueTransition::Cancelled {
                cancelled: prompt_id,
                next: self.active,
            };
        }

        QueueTransition::Missing { prompt_id }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_serializes_prompts_per_session() {
        let mut queue = AgentPromptQueue::default();
        let first = AgentPromptId::new();
        let second = AgentPromptId::new();
        let third = AgentPromptId::new();

        assert_eq!(queue.submit(first), QueueTransition::Started { prompt_id: first });
        assert_eq!(
            queue.submit(second),
            QueueTransition::Queued { prompt_id: second }
        );
        assert_eq!(queue.submit(third), QueueTransition::Queued { prompt_id: third });
        assert_eq!(queue.active(), Some(first));
        assert_eq!(queue.queued(), vec![second, third]);

        assert_eq!(
            queue.complete(first),
            QueueTransition::Completed {
                completed: first,
                next: Some(second)
            }
        );
        assert_eq!(queue.active(), Some(second));
        assert_eq!(queue.queued(), vec![third]);
    }

    #[test]
    fn cancelling_active_prompt_starts_next_prompt() {
        let mut queue = AgentPromptQueue::default();
        let first = AgentPromptId::new();
        let second = AgentPromptId::new();
        queue.submit(first);
        queue.submit(second);

        assert_eq!(
            queue.cancel(first),
            QueueTransition::Cancelled {
                cancelled: first,
                next: Some(second)
            }
        );
        assert_eq!(queue.active(), Some(second));
        assert!(queue.queued().is_empty());
    }

    #[test]
    fn cancelling_queued_prompt_keeps_active_prompt() {
        let mut queue = AgentPromptQueue::default();
        let first = AgentPromptId::new();
        let second = AgentPromptId::new();
        queue.submit(first);
        queue.submit(second);

        assert_eq!(
            queue.cancel(second),
            QueueTransition::Cancelled {
                cancelled: second,
                next: Some(first)
            }
        );
        assert_eq!(queue.active(), Some(first));
        assert!(queue.queued().is_empty());
    }
}
