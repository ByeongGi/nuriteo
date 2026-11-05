import { activateAccount } from "@nuriteo/api-client";

import type { ActivateAccountInput, ApiClient } from "@nuriteo/api-client";

export function activateInvitedAccount(client: ApiClient, input: ActivateAccountInput) {
  return activateAccount(client, input);
}

export {
  issueActivationInvitation,
  listActivationInvitations,
  reissueActivationInvitation,
  revokeActivationInvitation
} from "@nuriteo/api-client";
