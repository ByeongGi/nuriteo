import { z } from "zod";

const policyMessage = "변경을 안전하게 반영하지 못했습니다. 기존 정책은 그대로 유지됩니다.";

export const mfaPolicyDraftSchema = z.object({
  mode: z.enum(["off", "administrators", "all_local_users"], { error: policyMessage }),
  gracePeriodDays: z.number().int(policyMessage).min(0, policyMessage).max(30, policyMessage)
});

export const mfaResetSearchSchema = z.object({
  query: z.string().min(2, "이메일 또는 표시 이름으로 찾기").max(200, "이메일 또는 표시 이름으로 찾기")
});
