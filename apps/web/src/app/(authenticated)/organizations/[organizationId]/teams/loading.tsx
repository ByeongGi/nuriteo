import { WorkspacePageLoading } from "#src/app/_components/workspace-page-loading.tsx";

export default function TeamsLoading() {
  return <WorkspacePageLoading cardCount={2} label="팀 정보를 불러오는 중" />;
}
