//! Walk the session parent chain to compute delegation depth.
//!
//! Generic over an async closure so the broker plugs in a real DB lookup in
//! production (ids are `Uuid`) and a stub `Vec<(id, parent)>` in tests (ids are
//! `i32`) without extra trait plumbing.
//!
//! `cap` saturates the walk so a corrupted chain (cycle, deep history) can't
//! cause unbounded DB load. Callers pass `depth_limit + 1` — all the broker
//! needs to decide rejection.

use std::future::Future;

use crate::types::DelegationError;

pub async fn compute_depth<Id, F, Fut>(
    start: Id,
    mut parent_resolver: F,
    cap: u32,
) -> Result<u32, DelegationError>
where
    Id: Copy,
    F: FnMut(Id) -> Fut,
    Fut: Future<Output = Result<Option<Id>, DelegationError>>,
{
    let mut current = start;
    let mut depth = 0u32;
    while depth < cap {
        match parent_resolver(current).await? {
            None => return Ok(depth),
            Some(parent) => {
                current = parent;
                depth += 1;
            }
        }
    }
    Ok(depth)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    /// A linear chain `0 -> 1 -> 2 -> ...` where index 0 is the root.
    fn parent_of(chain_len: usize, id: i32) -> Result<Option<i32>, DelegationError> {
        assert!((id as usize) < chain_len, "id outside test chain");
        if id == 0 { Ok(None) } else { Ok(Some(id - 1)) }
    }

    #[tokio::test]
    async fn depth_of_root_is_zero() {
        let depth = compute_depth(0, |id| async move { parent_of(1, id) }, 8)
            .await
            .unwrap();
        assert_eq!(depth, 0);
    }

    #[tokio::test]
    async fn depth_of_grandchild_is_two() {
        // root(0) -> mid(1) -> leaf(2)
        let depth = compute_depth(2, |id| async move { parent_of(3, id) }, 8)
            .await
            .unwrap();
        assert_eq!(depth, 2);
    }

    #[tokio::test]
    async fn saturates_at_cap_without_walking_full_chain() {
        let calls = AtomicU32::new(0);
        let depth = compute_depth(
            19,
            |id| {
                calls.fetch_add(1, Ordering::SeqCst);
                async move { parent_of(20, id) }
            },
            3,
        )
        .await
        .unwrap();
        assert_eq!(depth, 3);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn resolver_error_propagates() {
        let err = compute_depth(
            42,
            |_id| async {
                Err::<Option<i32>, _>(DelegationError::SubagentRuntimeError("db down".into()))
            },
            8,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, DelegationError::SubagentRuntimeError(_)));
    }
}
