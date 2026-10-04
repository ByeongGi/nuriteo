"use client";

import { ApiError } from "@nuriteo/api-client";

import { isCanonicalCsrfCredential } from "./csrf-credential.ts";

const CSRF_NAMES = ["__Host-nuriteo_csrf", "nuriteo_dev_csrf"] as const;

export type CollaborationOperation =
  | "activation-invitation-issue"
  | "activation-invitation-terminal"
  | "organization-create"
  | "organization-invitation-issue"
  | "organization-invitation-terminal"
  | "organization-member"
  | "organization-profile"
  | "project-create"
  | "project-delete"
  | "project-lifecycle"
  | "project-profile"
  | "project-role";

export interface ProjectFailure {
  readonly message: string;
  readonly reconcile: boolean;
}

export function readCsrfCredential(): string {
  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    if (!CSRF_NAMES.includes(name as (typeof CSRF_NAMES)[number])) continue;
    const value = pair.slice(separator + 1);
    if (isCanonicalCsrfCredential(value)) return value;
  }
  throw new Error("Browser security credential is unavailable.");
}

export function collaborationError(
  error: unknown,
  operation: CollaborationOperation
): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "You do not have permission for this action.";
    if (error.status === 412 || error.status === 428) {
      return "This Organization changed. Reload the latest version before trying again.";
    }
    const terminalValidation = error.status === 422 && error.fieldErrors.some(
      (field) => field.path === "invitation" || field.path === "token"
    );
    if (
      (operation === "activation-invitation-terminal" ||
        operation === "organization-invitation-terminal") &&
      (error.status === 409 || error.status === 410 || terminalValidation)
    ) {
      return "This invitation is no longer usable. It may be expired, used, revoked, or replaced.";
    }
    if (operation === "organization-create" && error.status === 409) {
      return "That Organization slug is already in use. Choose another slug.";
    }
    if (operation === "organization-member" && error.status === 409) {
      return "The last Organization Owner cannot be changed or removed.";
    }
    if (
      operation === "organization-invitation-issue" &&
      (error.status === 404 || error.status === 409)
    ) {
      return "This invitation could not be issued. The account may be unavailable, already invited, or already a member.";
    }
    if (error.status === 400 || error.status === 422) {
      return "Some submitted values are invalid. Review the form and try again.";
    }
  }
  return "The request could not be completed. Check the service and try again.";
}

export function projectError(error: unknown, operation: CollaborationOperation): ProjectFailure {
  if (error instanceof ApiError) {
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") {
      return {
        message: "The server may have completed this change. Reload the Project before taking another action.",
        reconcile: true
      };
    }
    if (error.status === 412 || error.status === 428) {
      return {
        message: "This Project changed. Reload its latest version before trying again.",
        reconcile: true
      };
    }
    if (error.status === 403) {
      return { message: "You do not have permission for this action.", reconcile: false };
    }
    if (operation === "project-create" && error.status === 409) {
      return { message: "That Project slug is already in use in this Workspace.", reconcile: false };
    }
    if ((operation === "project-lifecycle" || operation === "project-delete") && error.status === 409) {
      return { message: "The Project state no longer allows this action. Reload and review it.", reconcile: true };
    }
    if (error.status === 400 || error.status === 422) {
      return { message: "Some submitted values are invalid. Review the form and try again.", reconcile: false };
    }
  }
  return {
    message: "The request could not be completed. Check the service and try again.",
    reconcile: false
  };
}
