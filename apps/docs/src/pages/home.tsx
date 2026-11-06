import { Link } from "react-router";

export function HomePage() {
  return (
    <main className="page">
      <p className="eyebrow">브라우저 네이티브 개발 환경</p>
      <h1>코드를 열고, 바로 실행하세요.</h1>
      <p className="lead">
        NURITEO는 조직 인프라 안에서 프로젝트를 열고, 설치하고, 고치고, 미리보기로 결과를 보는 셀프호스트 개발 환경입니다.
      </p>
      <p>
        <Link className="action" to="/sdk">SDK로 런타임 실행해 보기</Link>
      </p>
    </main>
  );
}
