import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { CSSProperties, ReactNode } from "react";

import { Button } from "../components/ui/button.tsx";

type Token = {
  label: string;
  token: `--n-${string}`;
};

const backgroundTokens: Token[] = [
  { label: "Page", token: "--n-color-bg-page" },
  { label: "Sidebar", token: "--n-color-bg-sidebar" },
  { label: "Subtle", token: "--n-color-bg-subtle" },
  { label: "Surface", token: "--n-color-bg-surface" },
  { label: "Raised", token: "--n-color-bg-raised" },
  { label: "Selected", token: "--n-color-bg-selected" }
];

const foregroundTokens: Token[] = [
  { label: "Default", token: "--n-color-fg-default" },
  { label: "Muted", token: "--n-color-fg-muted" },
  { label: "Subtle", token: "--n-color-fg-subtle" },
  { label: "Link", token: "--n-color-fg-link" },
  { label: "Primary action", token: "--n-color-action-primary" }
];

const statusTokens: Token[] = [
  { label: "Success", token: "--n-color-status-success" },
  { label: "Warning", token: "--n-color-status-warning" },
  { label: "Danger", token: "--n-color-status-danger" },
  { label: "Info", token: "--n-color-status-info" }
];

const hanjiTokens: Token[] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 850, 900, 950]
  .map((step) => ({ label: String(step), token: `--n-ref-color-hanji-${step}` as const }));

const cheonghwaTokens: Token[] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
  .map((step) => ({ label: String(step), token: `--n-ref-color-cheonghwa-${step}` as const }));

const spacingTokens: Token[] = [
  { label: "1 · 4px", token: "--n-ref-space-1" },
  { label: "2 · 8px", token: "--n-ref-space-2" },
  { label: "3 · 12px", token: "--n-ref-space-3" },
  { label: "4 · 16px", token: "--n-ref-space-4" },
  { label: "6 · 24px", token: "--n-ref-space-6" },
  { label: "8 · 32px", token: "--n-ref-space-8" },
  { label: "12 · 48px", token: "--n-ref-space-12" },
  { label: "16 · 64px", token: "--n-ref-space-16" }
];

const radiusTokens: Token[] = [
  { label: "Extra small", token: "--n-radius-xs" },
  { label: "Small", token: "--n-radius-sm" },
  { label: "Medium", token: "--n-radius-md" },
  { label: "Large", token: "--n-radius-lg" },
  { label: "Extra large", token: "--n-radius-xl" },
  { label: "2× large", token: "--n-radius-2xl" }
];

const colorPattern = [
  {
    className: "foundation-color-pattern__card--neutral",
    description: "화면의 대부분은 낮은 채도의 소프트 블루 중립색으로 구성합니다.",
    eyebrow: "01 · Canvas",
    title: "중립 Surface가 80%"
  },
  {
    className: "foundation-color-pattern__card--primary",
    description: "현재 흐름을 앞으로 보내는 단 하나의 행동에만 청화 블루를 사용합니다.",
    eyebrow: "02 · Action",
    title: "Primary는 한 번만"
  },
  {
    className: "foundation-color-pattern__card--semantic",
    description: "성공·경고·오류·정보는 브랜드 장식이 아니라 의미 전달에만 사용합니다.",
    eyebrow: "03 · Meaning",
    title: "상태색은 기능별로"
  },
  {
    className: "foundation-color-pattern__card--layers",
    description: "다크 모드는 그림자보다 page, surface, raised의 명도 차이로 깊이를 만듭니다.",
    eyebrow: "04 · Depth",
    title: "밝기로 쌓는 Dark layer"
  }
] as const;

function TokenName({ children }: Readonly<{ children: ReactNode }>) {
  return <code className="foundation-token-name">{children}</code>;
}

function ColorSwatch({ label, token }: Readonly<Token>) {
  const style = { "--swatch-color": `var(${token})` } as CSSProperties;

  return (
    <li className="foundation-swatch" style={style}>
      <span aria-hidden="true" className="foundation-swatch__color" />
      <span>
        <strong>{label}</strong>
        <TokenName>{token}</TokenName>
      </span>
    </li>
  );
}

function PaletteScale({ label, tokens }: Readonly<{ label: string; tokens: Token[] }>) {
  return (
    <div className="foundation-palette">
      <div>
        <h3>{label}</h3>
        <span>{tokens.length} curated steps</span>
      </div>
      <ol>
        {tokens.map(({ label: step, token }) => (
          <li key={token} style={{ "--swatch-color": `var(${token})` } as CSSProperties}>
            <span aria-hidden="true" />
            <strong>{step}</strong>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ProductPreview() {
  return (
    <section className="foundation-product-preview" aria-label="Hanji and Cheonghwa product preview">
      <aside>
        <div className="foundation-product-preview__brand"><span>N</span> Nuriteo</div>
        <nav aria-label="미리보기 탐색">
          <a className="is-active" href="#preview">개요</a>
          <a href="#preview">프로젝트 <span>12</span></a>
          <a href="#preview">활동</a>
          <a href="#preview">설정</a>
        </nav>
        <div className="foundation-product-preview__person">
          <span>BK</span>
          <div><strong>병기</strong><small>워크스페이스 소유자</small></div>
        </div>
      </aside>
      <div id="preview">
        <header>
          <div><span>워크스페이스</span><h2>프로젝트 개요</h2></div>
          <Button size="sm" variant="primary">새 프로젝트</Button>
        </header>
        <div className="foundation-product-preview__metrics">
          <article><span>진행 중인 프로젝트</span><strong>12</strong><small>이번 주 +2</small></article>
          <article><span>배포</span><strong>48</strong><small>성공률 96%</small></article>
          <article><span>팀 멤버</span><strong>8</strong><small>현재 3명 접속</small></article>
        </div>
        <section className="foundation-product-preview__table">
          <header><div><h3>최근 프로젝트</h3><p>워크스페이스의 최근 변경 사항</p></div><Button size="sm" variant="ghost">전체 보기</Button></header>
          <div className="foundation-product-preview__row foundation-product-preview__row--heading"><span>프로젝트</span><span>상태</span><span>업데이트</span></div>
          <div className="foundation-product-preview__row"><strong>런타임 편집기</strong><span className="is-success">정상</span><time>2분 전</time></div>
          <div className="foundation-product-preview__row"><strong>미리보기 서비스</strong><span className="is-progress">빌드 중</span><time>18분 전</time></div>
          <div className="foundation-product-preview__row"><strong>디자인 시스템</strong><span className="is-neutral">초안</span><time>1시간 전</time></div>
        </section>
      </div>
    </section>
  );
}

function ColorPattern() {
  return (
    <section className="foundation-color-pattern" aria-labelledby="color-pattern-title">
      <header>
        <div>
          <p>NURITEO COLOR CONTRACT</p>
          <h2 id="color-pattern-title">한국 제품의 절제된 색 사용 패턴</h2>
        </div>
        <p>
          중립색으로 정보 밀도를 받치고, 코발트 블루 한 점으로 다음 행동을 명확히 합니다.
          색의 수보다 역할과 대비를 먼저 설계합니다.
        </p>
      </header>
      <ol>
        {colorPattern.map(({ className, description, eyebrow, title }) => (
          <li className={`foundation-color-pattern__card ${className}`} key={eyebrow}>
            <div aria-hidden="true" className="foundation-color-pattern__preview">
              <span />
              <span />
              <span />
            </div>
            <span>{eyebrow}</span>
            <h3>{title}</h3>
            <p>{description}</p>
          </li>
        ))}
      </ol>
      <footer>
        <TokenName>bg-page → bg-surface → bg-raised</TokenName>
        <TokenName>action-primary</TokenName>
        <TokenName>status-success · warning · danger · info</TokenName>
      </footer>
    </section>
  );
}

function Section({ children, description, title }: Readonly<{
  children: ReactNode;
  description: string;
  title: string;
}>) {
  return (
    <section className="foundation-showcase__section">
      <header className="foundation-showcase__heading">
        <div>
          <p>Foundation</p>
          <h2>{title}</h2>
        </div>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

function FoundationsOverview() {
  return (
    <main className="foundation-showcase">
      <header className="foundation-showcase__hero">
        <p>NURITEO DESIGN SYSTEM · HANJI + CHEONGHWA</p>
        <h1>한국의 푸른색을 현대 SaaS 문법으로.</h1>
        <p>
          소프트 블루의 여백과 청화 코발트의 집중도를 Tailwind 토큰과 안정적인 컴포넌트 API로 연결합니다.
        </p>
      </header>

      <ProductPreview />

      <ColorPattern />

      <Section
        description="제품 UI는 reference 색상 대신 역할 기반 semantic token을 사용합니다. 툴바에서 Light와 Dark의 대비를 함께 확인하세요."
        title="Color"
      >
        <div className="foundation-palettes">
          <PaletteScale label="Hanji · Soft blue neutral" tokens={hanjiTokens} />
          <PaletteScale label="Cheonghwa · Product cobalt" tokens={cheonghwaTokens} />
        </div>
        <div className="foundation-color-groups">
          <div>
            <h3>Background</h3>
            <ul className="foundation-swatches">
              {backgroundTokens.map((token) => <ColorSwatch key={token.token} {...token} />)}
            </ul>
          </div>
          <div>
            <h3>Foreground & action</h3>
            <ul className="foundation-swatches">
              {foregroundTokens.map((token) => <ColorSwatch key={token.token} {...token} />)}
            </ul>
          </div>
          <div>
            <h3>Status</h3>
            <ul className="foundation-swatches">
              {statusTokens.map((token) => <ColorSwatch key={token.token} {...token} />)}
            </ul>
          </div>
        </div>
      </Section>

      <Section
        description="Reserve high attention for the most timely, consequential action. Supporting controls should recede."
        title="Attention hierarchy"
      >
        <div className="foundation-attention-scale">
          <article className="foundation-attention-level foundation-attention-level--low">
            <span>01 · Low</span>
            <h3>Utility</h3>
            <p>Persistent, reversible actions that should remain available without competing for focus.</p>
            <Button variant="ghost">View details</Button>
          </article>
          <article className="foundation-attention-level foundation-attention-level--medium">
            <span>02 · Medium</span>
            <h3>Supporting</h3>
            <p>Contextual actions that matter to the current task but are not the intended next step.</p>
            <Button variant="secondary">Save draft</Button>
          </article>
          <article className="foundation-attention-level foundation-attention-level--high">
            <span>03 · High</span>
            <h3>Primary</h3>
            <p>The single timely, high-impact action that advances the user through the current flow.</p>
            <Button variant="primary">Create workspace</Button>
          </article>
        </div>

        <div className="foundation-attention-examples">
          <article>
            <span className="foundation-example-label foundation-example-label--good">Do</span>
            <h3>One clear focal point</h3>
            <p>Use one primary action and lower the visual weight of alternatives.</p>
            <div>
              <Button variant="primary">Publish</Button>
              <Button variant="secondary">Save draft</Button>
              <Button variant="ghost">Cancel</Button>
            </div>
          </article>
          <article>
            <span className="foundation-example-label foundation-example-label--avoid">Avoid</span>
            <h3>Competing signals</h3>
            <p>Multiple high-attention actions make priority ambiguous and increase visual noise.</p>
            <div>
              <Button variant="primary">Publish</Button>
              <Button variant="primary">Save draft</Button>
              <Button variant="primary">Cancel</Button>
            </div>
          </article>
        </div>
      </Section>

      <Section
        description="A compact type scale keeps operational interfaces calm and makes hierarchy explicit."
        title="Typography"
      >
        <div className="foundation-type-specimens">
          <div className="foundation-type-specimen foundation-type-specimen--3xl">
            <span>Display</span>
            <p>Ship with confidence.</p>
            <TokenName>--n-font-size-3xl · 40px</TokenName>
          </div>
          <div className="foundation-type-specimen foundation-type-specimen--xl">
            <span>Heading</span>
            <p>Workspace activity</p>
            <TokenName>--n-font-size-xl · 24px</TokenName>
          </div>
          <div className="foundation-type-specimen foundation-type-specimen--md">
            <span>Body</span>
            <p>Changes are saved locally before they are published.</p>
            <TokenName>--n-font-size-md · 16px</TokenName>
          </div>
          <div className="foundation-type-specimen foundation-type-specimen--sm">
            <span>Interface</span>
            <p>Last updated a few seconds ago</p>
            <TokenName>--n-font-size-sm · 14px</TokenName>
          </div>
          <div className="foundation-type-specimen foundation-type-specimen--xs">
            <span>Caption</span>
            <p>BUILD 1042</p>
            <TokenName>--n-font-size-xs · 12px</TokenName>
          </div>
        </div>
      </Section>

      <Section
        description="The 4px base unit creates predictable alignment without an oversized token scale."
        title="Spacing"
      >
        <ul className="foundation-spacing-list">
          {spacingTokens.map(({ label, token }) => (
            <li key={token}>
              <span className="foundation-spacing-bar" style={{ width: `var(${token})` }} />
              <strong>{label}</strong>
              <TokenName>{token}</TokenName>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        description="Radius communicates containment; elevation is reserved for content that floats."
        title="Shape & elevation"
      >
        <div className="foundation-shapes">
          {radiusTokens.map(({ label, token }) => (
            <div key={token}>
              <span className="foundation-shape" style={{ borderRadius: `var(${token})` }} />
              <strong>{label}</strong>
              <TokenName>{token}</TokenName>
            </div>
          ))}
          <div>
            <span className="foundation-shape foundation-shape--elevated" />
            <strong>Overlay</strong>
            <TokenName>--n-shadow-overlay</TokenName>
          </div>
        </div>
      </Section>

      <Section
        description="Motion confirms a state change. It stays quick and disappears for reduced-motion users."
        title="Motion"
      >
        <div className="foundation-motion">
          <button type="button">
            <span />
            Hover or focus
          </button>
          <div>
            <TokenName>--n-duration-fast · 120ms</TokenName>
            <TokenName>--n-duration-normal · 180ms</TokenName>
            <TokenName>--n-easing-standard</TokenName>
          </div>
        </div>
      </Section>
    </main>
  );
}

const meta = {
  component: FoundationsOverview,
  parameters: {
    layout: "fullscreen"
  },
  title: "Foundations/Overview"
} satisfies Meta<typeof FoundationsOverview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
