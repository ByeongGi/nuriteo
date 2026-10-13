mod delivery;
mod http_routes;
mod http_service;
mod production;
mod repository;
mod types;
mod worker;
mod writer;

pub use delivery::{
    ClaimedEmail, DeliveryBoundaryError, DeliveryEligibility, DeliveryEligibilityDecision,
    EmailAttemptPreparer, EmailSendFailure, EmailSendFailureClass, EmailSender,
    InvitationAttemptContext, InvitationAttemptToken, InvitationAttemptTokenIssuer, PreparedEmail,
    SmtpAcceptance,
};
pub(crate) use http_routes::openapi_router;
pub use http_service::{
    EmailDeliveryCollectionView, EmailDeliveryView, NotificationHttpService,
    NotificationHttpServiceError, NotificationInboxItemView, NotificationInboxView,
    NotificationPreferencesView,
};
pub use production::{DatabaseInvitationAttemptTokenIssuer, ProductionEmailAttemptPreparer};
pub use repository::{DatabaseDeliveryEligibility, EmailOutboxRepository, NotificationWorkerError};
pub use types::{
    EmailChannelPreference, EmailOutboxId, EmailOutboxState, Notification, NotificationActionState,
    NotificationClassification, NotificationDelivery, NotificationFields, NotificationId,
    NotificationPayload, NotificationValidationError,
};
pub use worker::{NotificationWorker, NotificationWorkerPolicy, NotificationWorkerPolicyError};
pub use writer::{NotificationWriteError, NotificationWriteErrorCategory, NotificationWriter};

#[cfg(test)]
mod http_service_tests;
#[cfg(test)]
mod tests;
