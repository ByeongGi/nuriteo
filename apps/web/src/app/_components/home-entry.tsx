import Link from "next/link";

import { homeEntryStyles } from "#src/app/_components/home-entry.styles.ts";

const productFoundations = [
  {
    description: "설치 과정 없이 프로젝트를 열고 Node.js 실행 결과를 같은 화면에서 확인합니다.",
    index: "01 · BUILD",
    title: "브라우저에서 개발"
  },
  {
    description: "프로젝트와 실행 데이터가 조직의 인프라 경계를 벗어나지 않도록 운영합니다.",
    index: "02 · CONTROL",
    title: "자체 호스팅"
  },
  {
    description: "워크스페이스, 팀, 프로젝트 권한과 버전 기록을 하나의 흐름으로 연결합니다.",
    index: "03 · COLLABORATE",
    title: "팀 단위 협업"
  }
] as const;

export function HomeEntry() {
  const styles = homeEntryStyles();

  return (
    <main className={styles.page()} id="main-content" tabIndex={-1}>
      <div aria-hidden="true" className={styles.glow()} />
      <div className={styles.inner()}>
        <section className={styles.hero()} aria-labelledby="home-title">
          <div className={styles.copy()}>
            <p className={styles.eyebrow()}><i className={styles.eyebrowDot()} aria-hidden="true" />브라우저 네이티브 Node.js 워크스페이스</p>
            <h1 className={styles.title()} id="home-title">코드를 열고,<br />바로 실행하세요.</h1>
            <p className={styles.lead()}>설치 없이 브라우저에서 Node.js 프로젝트를 개발하고 실행하세요. 팀의 코드와 실행 환경은 조직이 관리하는 인프라 안에 안전하게 유지됩니다.</p>
            <div className={styles.actions()}>
              <Link className={styles.primaryAction()} href="/sign-in">워크스페이스 로그인 <span aria-hidden="true">→</span></Link>
              <Link className={styles.secondaryAction()} href="/examples">공개 예제 둘러보기</Link>
            </div>
            <ul className={styles.evidence()} aria-label="누리터 핵심 특성">
              <li className={styles.evidenceItem()}>Node.js 브라우저 런타임</li>
              <li className={styles.evidenceItem()}>자체 호스팅</li>
              <li className={styles.evidenceItem()}>격리된 미리보기</li>
            </ul>
          </div>

          <ProductPreview />
        </section>

        <section className={styles.foundation()} aria-labelledby="foundation-title">
          <header className={styles.foundationHeader()}>
            <h2 className={styles.foundationTitle()} id="foundation-title">개발 흐름은 가볍게,<br />운영 기준은 단단하게.</h2>
            <p className={styles.foundationDescription()}>로컬 개발 도구의 즉각적인 피드백과 조직형 서비스의 통제력을 함께 제공합니다. 개발자는 작업에 집중하고, 운영자는 데이터 경계를 관리할 수 있습니다.</p>
          </header>
          <div className={styles.featureGrid()}>
            {productFoundations.map((feature) => (
              <article className={styles.feature()} key={feature.index}>
                <span className={styles.featureIndex()}>{feature.index}</span>
                <div>
                  <h3 className={styles.featureTitle()}>{feature.title}</h3>
                  <p className={styles.featureDescription()}>{feature.description}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function ProductPreview() {
  const styles = homeEntryStyles();

  return (
    <figure className={styles.product()}>
      <figcaption className="sr-only">누리터 Studio 화면 예시</figcaption>
      <div className={styles.productBar()}>
        <span className={styles.windowDots()} aria-hidden="true"><i /><i /><i /></span>
        <span>런타임 편집기 / main</span>
        <span className={styles.productStatus()}>저장됨</span>
      </div>
      <div className={styles.productBody()}>
        <aside className={styles.explorer()} aria-hidden="true">
          <div className={styles.explorerTitle()}><span>EXPLORER</span><span>+</span></div>
          <div className={`${styles.file()} ${styles.activeFile()}`}>◇ App.tsx</div>
          <div className={styles.file()}>◇ main.tsx</div>
          <div className={styles.file()}># styles.css</div>
          <div className={styles.file()}>▸ components</div>
          <div className={styles.file()}>▸ lib</div>
        </aside>
        <section className={styles.editor()} aria-hidden="true">
          <div className={styles.editorTab()}><span className={styles.syntaxLanguage()}>TSX</span><span>App.tsx</span></div>
          <div className={styles.code()}>
            <span className={styles.lineNumbers()}>1<br />2<br />3<br />4<br />5<br />6<br />7<br />8</span>
            <code className={styles.codeText()}><span className="keyword">import</span> {`{ useState }`} <span className="keyword">from</span> <span className="string">&quot;react&quot;</span>;<br /><br /><span className="keyword">export default function</span> App() {`{`}<br />&nbsp;&nbsp;<span className="keyword">const</span> [count, setCount] = useState(0);<br /><br />&nbsp;&nbsp;<span className="keyword">return</span> (<br />&nbsp;&nbsp;&nbsp;&nbsp;&lt;button&gt;<span className="accent">실행 {`{count}`}</span>&lt;/button&gt;<br />&nbsp;&nbsp;);</code>
          </div>
        </section>
      </div>
      <div className={styles.productFooter()}><span className={styles.live()}>개발 서버 실행 중</span><span>미리보기 · localhost:5173</span></div>
    </figure>
  );
}
