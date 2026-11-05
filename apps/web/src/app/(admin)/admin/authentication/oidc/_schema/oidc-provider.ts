import { z } from "zod";

const message = "검증에 실패했습니다. HTTPS 발급자, 클라이언트 설정, 리디렉션 URI와 제공자 네트워크 연결을 확인하세요.";

export const oidcProviderCreateSchema = z.object({
  displayName: z.string().min(1, message).max(200, message),
  issuer: z.string().max(2048, message).pipe(z.url(message)),
  clientId: z.string().min(1, message).max(1024, message),
  clientSecret: z.string().min(1, message).max(4096, message)
});

export const oidcProviderUpdateSchema = z.object({
  displayName: z.string().min(1, message),
  clientId: z.string().min(1, message)
});

export const oidcProviderSecretSchema = z.object({
  clientSecret: z.string().min(1, message).max(4096, message)
});
