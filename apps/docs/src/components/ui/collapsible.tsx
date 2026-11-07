import type { ComponentProps } from "react";
import { Content, Root, Trigger } from "@radix-ui/react-collapsible";

function Collapsible(props: ComponentProps<typeof Root>) {
  return <Root {...props} />;
}

function CollapsibleTrigger(props: ComponentProps<typeof Trigger>) {
  return <Trigger {...props} />;
}

function CollapsibleContent(props: ComponentProps<typeof Content>) {
  return <Content {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
