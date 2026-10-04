mod repository;
mod service;
mod types;

pub(crate) use repository::QuotaRepository;
pub(crate) use service::reserve_before_commit;
pub use service::{QuotaService, QuotaServiceError, QuotaServicePolicy};
pub use types::{
    EffectiveQuota, QuotaProjection, ReservationRequest, ReservationResult, SaveSessionId,
    TerminalSaveState,
};

#[cfg(test)]
mod tests;
