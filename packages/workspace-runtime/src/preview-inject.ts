export const PREVIEW_ERROR_BRIDGE_MESSAGE_TYPE = "nuriteo-preview-error";

export const PREVIEW_ERROR_BRIDGE_SCRIPT = [
  "(function(){",
  "if(window.__nuriteoPreviewErrorBridge)return;",
  "window.__nuriteoPreviewErrorBridge=true;",
  "function send(payload){",
  "try{parent.postMessage(Object.assign({type:'nuriteo-preview-error'},payload),'*');}catch(_){}",
  "}",
  "window.addEventListener('error',function(event){",
  "send({source:'error',message:event.message||String(event.error||'error'),filename:event.filename,lineno:event.lineno,colno:event.colno,stack:event.error&&event.error.stack});",
  "});",
  "window.addEventListener('unhandledrejection',function(event){",
  "var reason=event.reason;",
  "send({source:'unhandledrejection',message:reason&&reason.message?reason.message:String(reason),stack:reason&&reason.stack});",
  "});",
  "var original=console.error;",
  "console.error=function(){",
  "try{",
  "var args=Array.prototype.slice.call(arguments);",
  "send({source:'console.error',message:args.map(function(arg){",
  "if(arg instanceof Error)return arg.message;",
  "try{return typeof arg==='string'?arg:JSON.stringify(arg);}catch(_){return String(arg);}",
  "}).join(' ')});",
  "}catch(_){}",
  "return original.apply(console,arguments);",
  "};",
  "})();"
].join("");

export function injectPreviewErrorBridge(html: string): string {
  const tag = `<script data-nuriteo-preview-error-bridge="1">${PREVIEW_ERROR_BRIDGE_SCRIPT}</script>`;
  const lower = html.toLowerCase();
  const bodyClose = lower.lastIndexOf("</body>");
  if (bodyClose >= 0) return `${html.slice(0, bodyClose)}${tag}${html.slice(bodyClose)}`;
  return `${html}${tag}`;
}

export function shouldInjectPreviewErrorBridge(contentType: string | undefined | null): boolean {
  return Boolean(contentType && /text\/html/i.test(contentType));
}
