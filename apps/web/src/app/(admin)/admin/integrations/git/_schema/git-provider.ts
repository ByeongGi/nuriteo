import { z } from "zod";

const message = "Git 제공자 변경을 안전하게 완료하지 못했습니다.";

const kindSchema = z.enum(["generic", "github", "github_enterprise", "gitlab", "gitlab_self_managed"], { error: message });

export const gitProviderCreateSchema = z.object({
  displayName: z.string().min(1, message).max(200, message),
  kind: kindSchema,
  host: z.string().min(1, message).max(253, message),
  port: z.number().int(message).min(1, message).max(65535, message),
  apiBaseUrl: z.string().max(2048, message).pipe(z.url(message)),
  oauthAuthorizationUrl: z.string().max(2048, message).nullable(),
  oauthTokenUrl: z.string().max(2048, message).nullable(),
  oauthClientId: z.string().max(1024, message).nullable(),
  allowsRead: z.boolean(),
  allowsWrite: z.boolean()
}).superRefine((value, ctx) => {
  if (value.kind === "generic") return;
  if (value.oauthClientId === null || value.oauthClientId.length === 0) {
    ctx.addIssue({ code: "custom", message });
  }
  if ((value.kind === "github_enterprise" || value.kind === "gitlab_self_managed") && (value.oauthAuthorizationUrl === null || value.oauthTokenUrl === null)) {
    ctx.addIssue({ code: "custom", message });
  }
});

export const gitProviderUpdateSchema = z.object({
  displayName: z.string().min(1, message).max(200, message),
  apiBaseUrl: z.string().max(2048, message),
  oauthAuthorizationUrl: z.string().max(2048, message).nullable(),
  oauthTokenUrl: z.string().max(2048, message).nullable(),
  oauthClientId: z.string().max(1024, message).nullable(),
  allowsRead: z.boolean(),
  allowsWrite: z.boolean()
});
