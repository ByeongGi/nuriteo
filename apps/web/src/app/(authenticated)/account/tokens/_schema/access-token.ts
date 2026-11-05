import { z } from "zod";

export const accessTokenScopes = [
  "project:read",
  "project:write",
  "project:publish",
  "project:manage",
  "git:read",
  "git:write"
] as const;

export const accessTokenScopePresets = {
  read: ["project:read", "git:read"],
  development: ["project:read", "project:write", "git:read", "git:write"],
  deployment: ["project:read", "project:write", "project:publish", "git:read", "git:write"],
  administration: accessTokenScopes
} as const;

export type AccessTokenScopePreset = keyof typeof accessTokenScopePresets | "custom";

const expiryMessage = "만료일은 오늘부터 1년 이내로 선택하세요.";
const nameMessage = "이름, 권한 범위와 만료 기간을 확인하세요. 관리자가 더 짧은 최대 만료 기간을 설정했을 수 있습니다.";

export const issueAccessTokenSchema = z.object({
  scopes: z.array(z.enum(accessTokenScopes)).min(1, "토큰에 필요한 권한 범위를 하나 이상 선택하세요."),
  selectedExpiryDays: z.number(expiryMessage).int(expiryMessage).min(0, expiryMessage).max(365, expiryMessage),
  name: z.string().min(1, nameMessage).max(120, nameMessage)
});
