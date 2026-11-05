import { acceptOrganizationInvitation, declineOrganizationInvitation } from "@nuriteo/api-client";

import type { ApiClient, BrowserMutationOptions } from "@nuriteo/api-client";

export function acceptInvitedOrganization(client: ApiClient, token: string, options: BrowserMutationOptions) {
  return acceptOrganizationInvitation(client, token, options);
}

export function declineInvitedOrganization(client: ApiClient, token: string, options: BrowserMutationOptions) {
  return declineOrganizationInvitation(client, token, options);
}

export {
  issueOrganizationInvitation,
  listOrganizationInvitations,
  reissueOrganizationInvitation,
  revokeOrganizationInvitation
} from "@nuriteo/api-client";
