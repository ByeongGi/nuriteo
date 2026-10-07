mod delivery;
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
pub use repository::{DatabaseDeliveryEligibility, EmailOutboxRepository, NotificationWorkerError};
pub use types::{
    EmailChannelPreference, EmailOutboxId, EmailOutboxState, Notification, NotificationActionState,
    NotificationClassification, NotificationDelivery, NotificationFields, NotificationId,
    NotificationPayload, NotificationValidationError,
};
pub use worker::{NotificationWorker, NotificationWorkerPolicy, NotificationWorkerPolicyError};
pub use writer::{NotificationWriteError, NotificationWriteErrorCategory, NotificationWriter};

#[cfg(test)]
mod tests;
