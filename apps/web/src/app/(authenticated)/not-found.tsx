import { NotFoundState } from "#src/app/_components/system-state.tsx";

export default function AuthenticatedNotFound() {
  return <NotFoundState homeHref="/workspaces" />;
}
