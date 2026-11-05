import { z } from "zod";

const saveError = "알림 설정을 저장하지 못했습니다. 기존 설정은 유지됩니다.";

export const notificationPreferencesSchema = z.object({
  accountAccess: z.boolean(),
  collaboration: z.boolean(),
  operations: z.boolean(),
  version: z.number(saveError).int(saveError).positive(saveError)
});
