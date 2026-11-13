//! Message passing from control to render node

use std::any::Any;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

#[cfg(feature = "diagnostics")]
use crate::context::AudioBackendDiagnostics;
use crate::context::AudioNodeId;
use crate::node::{ChannelConfigInner, ChannelCountMode, ChannelInterpretation};
use crate::render::graph::Graph;
use crate::render::AudioProcessor;

const RECYCLE_ACTIVE: u8 = 0;
const RECYCLE_CANCELLED: u8 = 1;
const RECYCLE_DELIVERED: u8 = 2;

/// The control thread can cancel a graph handoff until the renderer commits delivery.
pub(crate) struct Recycle {
    state: AtomicU8,
    graph_send: crossbeam_channel::Sender<(Graph, bool)>,
    graph_recv: crossbeam_channel::Receiver<(Graph, bool)>,
    ready_send: crossbeam_channel::Sender<()>,
    ready_recv: crossbeam_channel::Receiver<()>,
}

impl Recycle {
    pub fn new() -> Self {
        let (graph_send, graph_recv) = crossbeam_channel::bounded(1);
        let (ready_send, ready_recv) = crossbeam_channel::bounded(1);
        Self { state: AtomicU8::new(RECYCLE_ACTIVE), graph_send, graph_recv, ready_send, ready_recv }
    }

    pub fn wait(&self, deadline: Duration) -> Option<(Graph, bool)> {
        let _ = self.ready_recv.recv_timeout(deadline);
        if self.state.compare_exchange(RECYCLE_ACTIVE, RECYCLE_CANCELLED, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            None
        } else {
            debug_assert_eq!(self.state.load(Ordering::Acquire), RECYCLE_DELIVERED);
            Some(self.graph_recv.try_recv().expect("delivered graph is available"))
        }
    }

    pub fn deliver(&self, graph: Graph, suspended: bool) -> Result<(), (Graph, bool)> {
        self.graph_send.try_send((graph, suspended)).expect("recycle slot is empty");
        #[cfg(feature = "test-control")]
        crate::test_control::recycle_barrier(1);
        if self.state.compare_exchange(RECYCLE_ACTIVE, RECYCLE_DELIVERED, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            #[cfg(feature = "test-control")]
            crate::test_control::recycle_barrier(2);
            let _ = self.ready_send.try_send(());
            Ok(())
        } else {
            Err(self.graph_recv.try_recv().expect("cancelled graph is available"))
        }
    }
}

/// Commands from the control thread to the render thread
pub(crate) enum ControlMessage {
    /// Register a new node in the audio graph
    RegisterNode {
        id: AudioNodeId,
        reclaim_id: llq::Node<AudioNodeId>,
        node: Box<dyn AudioProcessor>,
        inputs: usize,
        outputs: usize,
        channel_config: ChannelConfigInner,
    },

    /// Connect a node to another in the audio graph
    ConnectNode {
        from: AudioNodeId,
        to: AudioNodeId,
        input: usize,
        output: usize,
    },

    /// Clear the connection between two given nodes in the audio graph
    DisconnectNode {
        from: AudioNodeId,
        to: AudioNodeId,
        input: usize,
        output: usize,
    },

    /// Notify the render thread this node is dropped in the control thread
    ControlHandleDropped { id: AudioNodeId },

    /// Mark node as a cycle breaker (DelayNode only)
    MarkCycleBreaker { id: AudioNodeId },

    /// Shut down and recycle the audio graph, with whether the render thread was suspended
    CloseAndRecycle {
        recycle: std::sync::Arc<Recycle>,
    },

    /// Start rendering with given audio graph, suspended when the render thread it came from was
    Startup { graph: Graph, suspended: bool },

    /// Suspend and pause audio processing
    Suspend { notify: OneshotNotify },

    /// Resume audio processing after suspending
    Resume { notify: OneshotNotify },

    /// Stop audio processing
    Close { notify: OneshotNotify },

    /// Generic message to be handled by AudioProcessor
    NodeMessage {
        id: AudioNodeId,
        msg: llq::Node<Box<dyn Any + Send>>,
    },

    /// Request a diagnostic report of the audio graph
    #[cfg(feature = "diagnostics")]
    RunDiagnostics { backend: AudioBackendDiagnostics },

    /// Update the channel count of a node
    SetChannelCount { id: AudioNodeId, count: usize },

    /// Update the channel count mode of a node
    SetChannelCountMode {
        id: AudioNodeId,
        mode: ChannelCountMode,
    },

    /// Update the channel interpretation of a node
    SetChannelInterpretation {
        id: AudioNodeId,
        interpretation: ChannelInterpretation,
    },
}

/// Helper object to emit single notification
pub(crate) enum OneshotNotify {
    /// A synchronous oneshot sender
    Sync(crossbeam_channel::Sender<()>),
    /// An asynchronous oneshot sender
    Async(futures_channel::oneshot::Sender<()>),
}

impl OneshotNotify {
    /// Emit the notification
    pub fn send(self) {
        match self {
            Self::Sync(s) => s.send(()).ok(),
            Self::Async(s) => s.send(()).ok(),
        };
    }
}
