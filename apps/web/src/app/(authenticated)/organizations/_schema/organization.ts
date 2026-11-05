import { z } from "zod";

export const organizationFormError = "입력값이 올바르지 않습니다. 폼을 확인하고 다시 시도하세요.";

export const createOrganizationSchema = z.object({
  slug: z.string()
    .min(1, organizationFormError)
    .max(63, organizationFormError)
    .regex(/^[a-z0-9][a-z0-9-]*$/u, organizationFormError),
  displayName: z.string().min(1, organizationFormError).max(200, organizationFormError)
});

export const renameOrganizationSchema = z.object({
  displayName: z.string().min(1, organizationFormError)
});

export const issueOrganizationInvitationSchema = z.object({
  email: z.string().min(1, organizationFormError),
  role: z.string()
}).transform((value) => ({
  email: value.email,
  role: value.role === "owner" ? "owner" as const : "member" as const
}));
