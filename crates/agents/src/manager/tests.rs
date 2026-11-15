use workspace_utils::proxy::ProxySource;

use super::*;
use crate::stderr_tail::StderrTail;

mod tests_1;
mod tests_2;
mod tests_3;
mod tests_4;

pub(self) use tests_1::{dummy_runner, test_launch_lock};
pub(self) use tests_3::dummy_runner_for_agent;
