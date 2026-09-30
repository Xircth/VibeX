use std::{future::Future, sync::OnceLock};

use tokio::runtime::{Builder, Handle, Runtime, RuntimeFlavor};

fn rt() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build global Tokio runtime")
    })
}

/// Run an async future from sync code.
///
/// Inside a multi-thread runtime this parks the worker with `block_in_place`
/// and drives the future on that same runtime, so spawned tasks, sqlx, and
/// timers stay on the Host executor. A nested `Runtime` would steal the
/// future onto a second thread pool and can stall a contended worker.
pub fn block_on<F, T>(fut: F) -> T
where
    F: Future<Output = T> + Send,
    T: Send,
{
    match Handle::try_current() {
        Ok(handle) => match handle.runtime_flavor() {
            RuntimeFlavor::MultiThread => tokio::task::block_in_place(|| handle.block_on(fut)),
            RuntimeFlavor::CurrentThread | _ => std::thread::scope(|s| {
                s.spawn(|| rt().block_on(fut))
                    .join()
                    .expect("thread panicked")
            }),
        },
        Err(_) => rt().block_on(fut),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::block_on;

    #[test]
    fn block_on_from_sync_context() {
        assert_eq!(block_on(async { 7 }), 7);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn block_on_from_multi_thread_runtime_completes() {
        let value = block_on(async {
            tokio::time::sleep(Duration::from_millis(1)).await;
            42
        });
        assert_eq!(value, 42);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn block_on_joins_a_task_on_the_current_runtime() {
        let handle = tokio::runtime::Handle::current();
        let joined = block_on(async {
            handle
                .spawn(async {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    9
                })
                .await
                .expect("join spawned task")
        });
        assert_eq!(joined, 9);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn block_on_from_current_thread_runtime_completes() {
        assert_eq!(block_on(async { 3 }), 3);
    }
}
