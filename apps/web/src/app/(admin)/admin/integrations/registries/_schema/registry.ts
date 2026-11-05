import { z } from "zod";

const message = "검증에 실패했습니다. HTTPS URL, 토큰, TLS 신뢰와 저장소 네트워크 연결을 확인하세요.";

export const registryCreateSchema = z.object({
  displayName: z.string().min(1, message).max(200, message),
  baseUrl: z.string().max(2048, message).pipe(z.url(message)),
  token: z.string().min(1, message).max(4096, message)
});

export const registryRenameSchema = z.object({
  displayName: z.string().min(1, message).max(200, message)
});

export const registryTokenSchema = z.object({
  token: z.string().min(1, message).max(4096, message)
});

export const registryScopeSchema = z.object({
  scope: z.string().min(1, message).max(65, message),
  connectionId: z.string().min(1, message)
});
