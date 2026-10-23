import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AccordionContent, AccordionHeader, AccordionIndicator, AccordionItem, AccordionPanel, AccordionRoot, AccordionTrigger } from "#src/components/ui/accordion.tsx";
import { AvatarFallback, AvatarRoot } from "#src/components/ui/avatar.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { CollapsibleContent, CollapsibleIndicator, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import { Input } from "#src/components/ui/input.tsx";
import { MeterHeader, MeterIndicator, MeterLabel, MeterRoot, MeterTrack, MeterValue } from "#src/components/ui/meter.tsx";
import { MetricGrid, MetricItem } from "#src/components/ui/metric-grid.tsx";
import { OTPFieldInput, OTPFieldRoot, OTPFieldSeparator } from "#src/components/ui/otp-field.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { ProgressHeader, ProgressIndicator, ProgressLabel, ProgressRoot, ProgressTrack, ProgressValue } from "#src/components/ui/progress.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import { Separator } from "#src/components/ui/separator.tsx";
import { SliderControl, SliderHeader, SliderIndicator, SliderLabel, SliderRoot, SliderThumb, SliderTrack, SliderValue } from "#src/components/ui/slider.tsx";
import { TabsIndicator, TabsList, TabsPanel, TabsRoot, TabsTab } from "#src/components/ui/tabs.tsx";
import { Textarea } from "#src/components/ui/textarea.tsx";
import { Toggle } from "#src/components/ui/toggle.tsx";
import { ToolbarButton, ToolbarGroup, ToolbarRoot, ToolbarSeparator } from "#src/components/ui/toolbar.tsx";
import { TooltipContent, TooltipProvider, TooltipRoot, TooltipTrigger } from "#src/components/ui/tooltip.tsx";

const meta = {
  title: "Foundations/Base UI Catalog",
  component: CatalogPreview,
  parameters: { controls: { disable: true }, layout: "padded" }
} satisfies Meta<typeof CatalogPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CorePrimitives: Story = {};

function CatalogPreview() {
  return (
    <TooltipProvider>
      <main className="mx-auto grid w-full max-w-5xl gap-8 text-foreground">
        <header className="grid gap-2">
          <p className="text-xs font-semibold tracking-wider text-primary uppercase">Base UI 1.8 foundation</p>
          <h1 className="text-2xl font-bold tracking-tight">공통 컴포넌트 카탈로그</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">Base UI의 상호작용 계약 위에 누리터 토큰과 Tailwind Variants 스타일을 적용한 공통 계층입니다.</p>
        </header>

        <section className="grid gap-5 rounded-xl border border-border bg-raised p-5">
          <h2 className="text-lg font-semibold">제품 페이지 구조</h2>
          <PageHeader
            eyebrow="개발"
            title="프로젝트"
            description="주요 작업과 현재 상태를 모든 사용자 화면에서 같은 순서로 전달합니다."
            actions={<Button variant="primary">새 프로젝트</Button>}
          />
          <MetricGrid aria-label="프로젝트 요약">
            <MetricItem label="활성" value="12" description="현재 편집 가능한 프로젝트" />
            <MetricItem label="협업 중" value="4" description="멤버와 공유된 프로젝트" />
            <MetricItem label="보관됨" value="2" description="설정에서 복원 가능" />
          </MetricGrid>
        </section>

        <section className="grid gap-4 rounded-xl border border-border bg-raised p-5">
          <h2 className="text-lg font-semibold">입력과 선택</h2>
          <Input aria-label="프로젝트 이름" placeholder="프로젝트 이름" />
          <SearchField label="프로젝트 검색" placeholder="프로젝트 검색" />
          <Textarea aria-label="프로젝트 설명" placeholder="프로젝트 설명" rows={3} />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">저장</Button>
            <Toggle aria-label="미리 보기 고정">미리 보기 고정</Toggle>
            <AvatarRoot><AvatarFallback>NT</AvatarFallback></AvatarRoot>
          </div>
          <OTPFieldRoot aria-label="인증 코드" length={6}>
            {[0, 1, 2].map((index) => <OTPFieldInput key={index} />)}
            <OTPFieldSeparator>–</OTPFieldSeparator>
            {[3, 4, 5].map((index) => <OTPFieldInput key={index} />)}
          </OTPFieldRoot>
          <SliderRoot defaultValue={64}>
            <SliderHeader><SliderLabel>편집기 글자 크기</SliderLabel><SliderValue /></SliderHeader>
            <SliderControl><SliderTrack><SliderIndicator /></SliderTrack><SliderThumb /></SliderControl>
          </SliderRoot>
        </section>

        <section className="grid gap-5 rounded-xl border border-border bg-raised p-5">
          <h2 className="text-lg font-semibold">상태와 진행</h2>
          <ProgressRoot value={72}>
            <ProgressHeader><ProgressLabel>배포 준비</ProgressLabel><ProgressValue /></ProgressHeader>
            <ProgressTrack><ProgressIndicator /></ProgressTrack>
          </ProgressRoot>
          <MeterRoot value={82}>
            <MeterHeader><MeterLabel>저장 공간</MeterLabel><MeterValue /></MeterHeader>
            <MeterTrack><MeterIndicator /></MeterTrack>
          </MeterRoot>
        </section>

        <section className="grid gap-5 rounded-xl border border-border bg-raised p-5">
          <h2 className="text-lg font-semibold">탐색과 공개</h2>
          <TabsRoot defaultValue="overview">
            <TabsList>
              <TabsTab value="overview">개요</TabsTab>
              <TabsTab value="activity">활동</TabsTab>
              <TabsIndicator />
            </TabsList>
            <TabsPanel value="overview">프로젝트의 핵심 상태를 확인합니다.</TabsPanel>
            <TabsPanel value="activity">최근 변경 이력을 확인합니다.</TabsPanel>
          </TabsRoot>
          <Separator />
          <AccordionRoot>
            <AccordionItem value="runtime">
              <AccordionHeader><AccordionTrigger>런타임 정보 <AccordionIndicator>⌄</AccordionIndicator></AccordionTrigger></AccordionHeader>
              <AccordionPanel><AccordionContent>Node.js 런타임과 개발 서버 상태를 표시합니다.</AccordionContent></AccordionPanel>
            </AccordionItem>
          </AccordionRoot>
          <CollapsibleRoot>
            <CollapsibleTrigger>고급 설정 <CollapsibleIndicator>⌄</CollapsibleIndicator></CollapsibleTrigger>
            <CollapsiblePanel><CollapsibleContent>필요한 경우에만 노출하는 보조 설정입니다.</CollapsibleContent></CollapsiblePanel>
          </CollapsibleRoot>
        </section>

        <section className="grid gap-4 rounded-xl border border-border bg-raised p-5">
          <h2 className="text-lg font-semibold">도구와 안내</h2>
          <ToolbarRoot aria-label="편집 도구">
            <ToolbarGroup><ToolbarButton aria-label="실행">▶</ToolbarButton><ToolbarButton aria-label="중지">■</ToolbarButton></ToolbarGroup>
            <ToolbarSeparator />
            <TooltipRoot>
              <TooltipTrigger render={<ToolbarButton aria-label="도움말" />}>?</TooltipTrigger>
              <TooltipContent>키보드 단축키를 확인합니다.</TooltipContent>
            </TooltipRoot>
          </ToolbarRoot>
        </section>
      </main>
    </TooltipProvider>
  );
}
