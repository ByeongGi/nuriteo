import { z } from "zod";

const message = "일정, 시간대와 보존 한도를 확인해 주세요.";

function ranged(min: number, max: number) {
  return z.number().int(message).min(min, message).max(max, message);
}

function retention(max: number) {
  return ranged(0, max).nullable();
}

export const backupPolicySchema = z.object({
  enabled: z.boolean(),
  intervalHours: ranged(1, 168),
  scheduleTime: z.string().min(1, message),
  scheduleTimezone: z.string().min(1, message),
  dailyRetention: retention(365),
  weeklyRetention: retention(104),
  monthlyRetention: retention(120),
  failedRetentionDays: ranged(1, 90),
  multipartCleanupHours: ranged(1, 168),
  warningAfterHours: ranged(1, 720),
  criticalAfterFailures: ranged(1, 100),
  drillFrequency: z.enum(["off", "weekly", "monthly", "quarterly"], { error: message }),
  drillTime: z.string().min(1, message),
  drillTimezone: z.string().min(1, message)
});
