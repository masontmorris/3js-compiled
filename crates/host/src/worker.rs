//! A named thread that works through one job at a time, at most one job behind its caller.

use anyhow::{Result, anyhow, bail};
use std::{
    any::Any,
    sync::mpsc::{self, Receiver, SyncSender},
    thread::JoinHandle,
};

pub struct Worker<J, D> {
    name: String,
    jobs: Option<SyncSender<J>>,
    done: Receiver<D>,
    thread: Option<JoinHandle<Result<()>>>,
    busy: bool,
}

impl<J: Send + 'static, D: Send + 'static> Worker<J, D> {
    /// Starts a thread that builds its state with `init` and runs `work` on each job.
    pub fn spawn<S>(
        name: &str,
        init: impl FnOnce() -> Result<S> + Send + 'static,
        mut work: impl FnMut(&mut S, J) -> Result<D> + Send + 'static,
    ) -> Result<Self> {
        let (jobs, received) = mpsc::sync_channel::<J>(1);
        let (finished, done) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let mut state = init()?;
                for job in received {
                    if finished.send(work(&mut state, job)?).is_err() {
                        break;
                    }
                }
                Ok(())
            })?;
        Ok(Self {
            name: name.into(),
            jobs: Some(jobs),
            done,
            thread: Some(thread),
            busy: false,
        })
    }

    /// Waits for the job in flight, hands `job` to the thread, and returns the finished job's
    /// result, or `None` when no job was in flight.
    pub fn submit(&mut self, job: J) -> Result<Option<D>> {
        let done = self.finish()?;
        let sent = self.jobs.as_ref().map(|jobs| jobs.send(job));
        if !matches!(sent, Some(Ok(()))) {
            return Err(self.stopped());
        }
        self.busy = true;
        Ok(done)
    }

    /// Waits for the job in flight, then joins the thread.
    pub fn close(mut self) -> Result<Option<D>> {
        let done = self.finish()?;
        self.join()?;
        Ok(done)
    }

    fn finish(&mut self) -> Result<Option<D>> {
        if !std::mem::take(&mut self.busy) {
            return Ok(None);
        }
        match self.done.recv() {
            Ok(done) => Ok(Some(done)),
            Err(_) => Err(self.stopped()),
        }
    }

    fn stopped(&mut self) -> anyhow::Error {
        match self.join() {
            Ok(()) => anyhow!("{} thread stopped", self.name),
            Err(error) => error,
        }
    }

    fn join(&mut self) -> Result<()> {
        self.jobs = None;
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        match thread.join() {
            Ok(result) => {
                result.map_err(|error| error.context(format!("{} thread failed", self.name)))
            }
            Err(panic) => bail!("{} thread panicked: {}", self.name, message(&*panic)),
        }
    }
}

impl<J, D> Drop for Worker<J, D> {
    fn drop(&mut self) {
        self.jobs = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn message(panic: &(dyn Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn results_return_in_order_one_job_behind() -> Result<()> {
        let mut worker = Worker::spawn(
            "test",
            || Ok(0),
            |count: &mut u32, job: u32| {
                *count += 1;
                Ok((job, *count))
            },
        )?;
        assert_eq!(worker.submit(10)?, None);
        assert_eq!(worker.submit(11)?, Some((10, 1)));
        assert_eq!(worker.submit(12)?, Some((11, 2)));
        assert_eq!(worker.close()?, Some((12, 3)));
        Ok(())
    }

    #[test]
    fn close_finishes_the_last_job_and_joins_the_thread() -> Result<()> {
        let dropped = Arc::new(AtomicBool::new(false));
        let mut worker = Worker::spawn(
            "test",
            {
                let dropped = dropped.clone();
                move || Ok(Dropped(dropped))
            },
            |_: &mut Dropped, job: u32| {
                std::thread::sleep(std::time::Duration::from_millis(50));
                Ok(job)
            },
        )?;
        worker.submit(1)?;
        assert_eq!(worker.close()?, Some(1));
        assert!(
            dropped.load(Ordering::SeqCst),
            "the thread still owns its state"
        );
        Ok(())
    }

    #[test]
    fn an_error_ends_the_thread_and_reaches_the_caller() -> Result<()> {
        let mut worker = Worker::spawn(
            "render",
            || Ok(()),
            |_: &mut (), job: u32| {
                if job == 2 {
                    bail!("capture failed");
                }
                Ok(job)
            },
        )?;
        worker.submit(1)?;
        worker.submit(2)?;
        let error = worker.submit(3).unwrap_err();
        assert_eq!(format!("{error:#}"), "render thread failed: capture failed");
        Ok(())
    }

    #[test]
    fn a_panic_ends_the_thread_and_reaches_the_caller() -> Result<()> {
        let mut worker = Worker::spawn(
            "render",
            || Ok(()),
            |_: &mut (), job: u32| {
                assert!(job != 2, "replay invariant broken");
                Ok(job)
            },
        )?;
        worker.submit(1)?;
        worker.submit(2)?;
        let error = worker.close().unwrap_err();
        assert_eq!(
            error.to_string(),
            "render thread panicked: replay invariant broken"
        );
        Ok(())
    }

    #[test]
    fn a_failed_start_reaches_the_caller() -> Result<()> {
        let worker = Worker::spawn(
            "render",
            || -> Result<()> { bail!("no adapter") },
            |_: &mut (), job: u32| Ok(job),
        )?;
        let error = worker.close().unwrap_err();
        assert_eq!(format!("{error:#}"), "render thread failed: no adapter");
        Ok(())
    }

    #[test]
    fn dropping_the_worker_joins_the_thread() -> Result<()> {
        let dropped = Arc::new(AtomicBool::new(false));
        let mut worker = Worker::spawn(
            "test",
            {
                let dropped = dropped.clone();
                move || Ok(Dropped(dropped))
            },
            |_: &mut Dropped, job: u32| Ok(job),
        )?;
        worker.submit(1)?;
        drop(worker);
        assert!(dropped.load(Ordering::SeqCst));
        Ok(())
    }
}
