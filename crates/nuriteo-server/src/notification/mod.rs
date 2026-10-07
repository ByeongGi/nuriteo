mod types;
mod writer;

pub use types::{
    EmailChannelPreference, EmailOutboxId, EmailOutboxState, Notification, NotificationActionState,
    NotificationClassification, NotificationDelivery, NotificationFields, NotificationId,
    NotificationPayload, NotificationValidationError,
};
pub use writer::{NotificationWriteError, NotificationWriteErrorCategory, NotificationWriter};

#[cfg(test)]
mod tests;
