use std::fmt;
use std::future::Future;
use std::pin::Pin;

use serde_json::Value;
use zeroize::Zeroizing;

const MAX_SUBJECT_BYTES: usize = 200;
const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Clone, PartialEq)]
pub struct ClaimedEmail {
    pub(crate) id: String,
    pub(crate) notification_id: Option<String>,
    pub(crate) recipient_user_id: Option<String>,
    pub(crate) recipient_email: String,
    pub(crate) classification: String,
    pub(crate) template_id: String,
    pub(crate) locale: String,
    pub(crate) resource_type: String,
    pub(crate) resource_id: String,
    pub(crate) rendering_data: Value,
    pub(crate) attempt_count: u8,
    pub(crate) lock_version: i64,
}

impl ClaimedEmail {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn recipient_email(&self) -> &str {
        &self.recipient_email
    }

    #[must_use]
    pub fn classification(&self) -> &str {
        &self.classification
    }

    #[must_use]
    pub fn template_id(&self) -> &str {
        &self.template_id
    }

    #[must_use]
    pub fn locale(&self) -> &str {
        &self.locale
    }

    #[must_use]
    pub fn resource_type(&self) -> &str {
        &self.resource_type
    }

    #[must_use]
    pub fn resource_id(&self) -> &str {
        &self.resource_id
    }

    #[must_use]
    pub const fn rendering_data(&self) -> &Value {
        &self.rendering_data
    }

    #[must_use]
    pub const fn attempt_count(&self) -> u8 {
        self.attempt_count
    }

    #[must_use]
    pub fn notification_id(&self) -> Option<&str> {
        self.notification_id.as_deref()
    }
}

impl fmt::Debug for ClaimedEmail {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaimedEmail")
            .field("id", &self.id)
            .field("classification", &self.classification)
            .field("template_id", &self.template_id)
            .field("resource_type", &self.resource_type)
            .field("attempt_count", &self.attempt_count)
            .field("recipient", &"[REDACTED]")
            .field("rendering_data", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryEligibilityDecision {
    Eligible,
    Cancel,
}

pub trait DeliveryEligibility: Send + Sync + 'static {
    fn revalidate<'a>(
        &'a self,
        email: &'a ClaimedEmail,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<DeliveryEligibilityDecision, DeliveryBoundaryError>>
                + Send
                + 'a,
        >,
    >;
}

#[derive(Clone, PartialEq, Eq)]
pub struct PreparedEmail {
    subject: Zeroizing<String>,
    body: Zeroizing<String>,
}

impl PreparedEmail {
    pub fn new(subject: String, body: String) -> Result<Self, DeliveryBoundaryError> {
        if subject.is_empty()
            || subject.len() > MAX_SUBJECT_BYTES
            || subject.contains(['\r', '\n'])
            || body.len() > MAX_BODY_BYTES
            || body.contains('\0')
            || body.contains('\r')
        {
            return Err(DeliveryBoundaryError::Permanent);
        }
        Ok(Self {
            subject: Zeroizing::new(subject),
            body: Zeroizing::new(body),
        })
    }

    #[must_use]
    pub fn subject(&self) -> &str {
        &self.subject
    }

    #[must_use]
    pub fn body(&self) -> &str {
        &self.body
    }
}

impl fmt::Debug for PreparedEmail {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PreparedEmail([REDACTED])")
    }
}

pub trait EmailAttemptPreparer: Send + Sync + 'static {
    fn prepare<'a>(
        &'a self,
        email: &'a ClaimedEmail,
        invitation_token: Option<&'a InvitationAttemptToken>,
    ) -> Pin<Box<dyn Future<Output = Result<PreparedEmail, DeliveryBoundaryError>> + Send + 'a>>;
}

/// A one-attempt invitation credential. Implementations must atomically replace
/// the invitation's stored digest before returning this plaintext and must never
/// persist or log the plaintext. Dropping the value zeroizes its allocation.
pub struct InvitationAttemptToken(Zeroizing<String>);

impl InvitationAttemptToken {
    #[must_use]
    pub fn new(plaintext: String) -> Self {
        Self(Zeroizing::new(plaintext))
    }

    #[must_use]
    pub fn expose_for_message(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for InvitationAttemptToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("InvitationAttemptToken([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct InvitationAttemptContext {
    pub invitation_id: String,
    pub resource_type: String,
    pub recipient_email: String,
    pub attempt_count: u8,
}

impl fmt::Debug for InvitationAttemptContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InvitationAttemptContext")
            .field("invitation_id", &self.invitation_id)
            .field("resource_type", &self.resource_type)
            .field("recipient_email", &"[REDACTED]")
            .field("attempt_count", &self.attempt_count)
            .finish()
    }
}

pub trait InvitationAttemptTokenIssuer: Send + Sync + 'static {
    fn issue<'a>(
        &'a self,
        context: &'a InvitationAttemptContext,
    ) -> Pin<
        Box<dyn Future<Output = Result<InvitationAttemptToken, DeliveryBoundaryError>> + Send + 'a>,
    >;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryBoundaryError {
    Retryable,
    Permanent,
    Cancel,
}

impl fmt::Display for DeliveryBoundaryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("email delivery boundary failed")
    }
}

impl std::error::Error for DeliveryBoundaryError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailSendFailureClass {
    Transient,
    Permanent,
    Ambiguous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmailSendFailure {
    class: EmailSendFailureClass,
    smtp_code: Option<u16>,
}

impl EmailSendFailure {
    #[must_use]
    pub const fn transient(smtp_code: Option<u16>) -> Self {
        Self {
            class: EmailSendFailureClass::Transient,
            smtp_code,
        }
    }

    #[must_use]
    pub const fn permanent(smtp_code: Option<u16>) -> Self {
        Self {
            class: EmailSendFailureClass::Permanent,
            smtp_code,
        }
    }

    #[must_use]
    pub const fn ambiguous() -> Self {
        Self {
            class: EmailSendFailureClass::Ambiguous,
            smtp_code: None,
        }
    }

    #[must_use]
    pub const fn class(self) -> EmailSendFailureClass {
        self.class
    }

    #[must_use]
    pub const fn smtp_code(self) -> Option<u16> {
        self.smtp_code
    }
}

impl fmt::Display for EmailSendFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SMTP delivery failed")
    }
}

impl std::error::Error for EmailSendFailure {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SmtpAcceptance {
    code: u16,
}

impl SmtpAcceptance {
    pub fn new(code: u16) -> Result<Self, EmailSendFailure> {
        if (200..300).contains(&code) {
            Ok(Self { code })
        } else {
            Err(EmailSendFailure::permanent(Some(code)))
        }
    }

    #[must_use]
    pub const fn code(self) -> u16 {
        self.code
    }
}

pub trait EmailSender: Send + Sync + 'static {
    /// Hard upper bound enforced by the transport itself. Implementations must
    /// classify timeouts according to whether SMTP DATA may have been accepted.
    fn timeout(&self) -> std::time::Duration;

    fn send<'a>(
        &'a self,
        recipient: &'a str,
        email: &'a PreparedEmail,
    ) -> Pin<Box<dyn Future<Output = Result<SmtpAcceptance, EmailSendFailure>> + Send + 'a>>;
}
