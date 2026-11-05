import { z } from "zod";

const codeMismatch = "코드가 일치하지 않습니다. 새 코드를 기다리거나 사용하지 않은 복구 코드를 입력하세요.";

export const mfaEnrollmentCodeSchema = z.object({
  code: z.string(codeMismatch).regex(/^[0-9]{6}$/u, codeMismatch)
});

export const mfaChallengeCodeSchema = z.object({
  code: z.string(codeMismatch).min(6, codeMismatch).max(128, codeMismatch)
});

export const mfaRecoveryCodeSchema = z.object({
  code: z.string(codeMismatch).min(6, codeMismatch).max(128, codeMismatch)
});
