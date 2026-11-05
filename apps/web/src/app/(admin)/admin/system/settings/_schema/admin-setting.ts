import { z } from "zod";

import type { AdminSettingConstraint, AdminSettingValue } from "@nuriteo/api-client";

export function settingDraftSchema(constraint: AdminSettingConstraint) {
  return z.object({
    draft: z.string(),
    unlimited: z.boolean()
  }).superRefine((input, ctx) => {
    if (constraint.kind === "enumeration" && !constraint.allowed.includes(input.draft)) {
      ctx.addIssue({ code: "custom", message: "허용된 설정 값을 선택해 주세요." });
      return;
    }
    if (
      constraint.kind === "unsigned_integer" ||
      constraint.kind === "optional_unsigned_integer" ||
      constraint.kind === "retention_days"
    ) {
      if ((constraint.kind === "optional_unsigned_integer" || constraint.kind === "retention_days") && input.unlimited) return;
      const value = Number(input.draft);
      if (!Number.isSafeInteger(value) || value < constraint.minimum || value > constraint.maximum) {
        ctx.addIssue({ code: "custom", message: "설정 값이 허용 범위를 벗어났습니다." });
      }
      return;
    }
    if (constraint.kind !== "boolean" && constraint.kind !== "enumeration" && input.draft.length === 0) {
      ctx.addIssue({ code: "custom", message: "설정 값을 입력해 주세요." });
    }
  }).transform((input): AdminSettingValue => {
    if (constraint.kind === "boolean") return input.draft === "true";
    if (constraint.kind === "enumeration") return input.draft;
    if ((constraint.kind === "optional_unsigned_integer" || constraint.kind === "retention_days") && input.unlimited) return null;
    if (
      constraint.kind === "unsigned_integer" ||
      constraint.kind === "optional_unsigned_integer" ||
      constraint.kind === "retention_days"
    ) return Number(input.draft);
    return input.draft;
  });
}

export function parseSettingDraft(
  constraint: AdminSettingConstraint,
  draft: string,
  unlimited: boolean
): AdminSettingValue {
  const parsed = settingDraftSchema(constraint).safeParse({ draft, unlimited });
  if (!parsed.success) throw new TypeError(parsed.error.issues[0]?.message ?? "설정 값을 입력해 주세요.");
  return parsed.data;
}
