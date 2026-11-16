import {
  bufferSource,
  fetchFileSource,
  missingSource,
  prefixSource,
  replaceEntrySource,
  scriptSource,
  writeEachSource
} from "./load-sources.ts";

export interface LoadExample {
  title: string;
  text: string;
  code: string;
  result: string;
}

export const loadExamples: { ko: LoadExample[]; en: LoadExample[] } = {
  ko: [
    {
      title: "파일을 하나씩 씁니다",
      text: "동적 import로 받은 목록을 반복하면서 writeFile을 한 경로씩 호출합니다. 맵은 비어 있는 상태에서 시작합니다. 이 페이지의 파일 맵은 부모 디렉터리를 따로 만들지 않고, readdir이 슬래시 앞을 디렉터리로 보여 줍니다.",
      code: writeEachSource,
      result: "written은 쓴 경로의 순서입니다. readdir(\"/workspace\")는 바로 아래 파일과 디렉터리만 돌려줍니다. boot이 끝나면 status는 ready입니다. 패키지 설치와 개발 서버는 실행하지 않습니다."
    },
    {
      title: "주소에서 소스 한 파일을 가져옵니다",
      text: "sourceUrl은 이 문서가 공개한 파일 주소이고, filePath는 워크스페이스 기준 상대 경로입니다. SPA 스크립트는 examples/spa/src/main.js이고, Next 페이지는 examples/next/app/page.tsx입니다. fetch가 실패하면 그 주소로 예외가 납니다. 응답 본문만 writeFile합니다.",
      code: fetchFileSource,
      result: "맵에는 그 파일 하나만 있습니다. 다시 읽은 본문은 주소의 소스와 같습니다. SPA면 spa-ready, Next면 next-ready가 들어 있습니다. 나머지 프로젝트 파일은 올라가지 않습니다."
    },
    {
      title: "엔트리 파일만 바꿉니다",
      text: "트리를 올린 뒤 엔트리 경로에만 새 문자열을 다시 씁니다. 다른 경로는 그대로 둡니다.",
      code: replaceEntrySource,
      result: "readFile은 replaced-entry만 돌려줍니다. 이전 표식인 spa-ready나 next-ready는 그 파일에 없습니다."
    },
    {
      title: "HTML이 가리키는 스크립트만 이어서 올립니다",
      text: "SPA의 index.html에서 module script의 src를 읽습니다. 그 경로가 케이스 파일과 같으면 index.html과 그 스크립트만 씁니다. scriptSrcFromHtml은 이 페이지의 함수입니다. Next 케이스의 layout에는 그런 script 태그가 없습니다.",
      code: scriptSource,
      result: "SPA는 index.html과 src/main.js만 올라가고, 다시 읽은 스크립트에 spa-ready가 있습니다. package.json은 빠집니다. Next 케이스에서는 이 단계를 실행하지 않습니다."
    },
    {
      title: "한 디렉터리 아래만 올립니다",
      text: "prefix는 SPA에서 src/이고 Next에서 app/입니다. 그 접두사로 시작하는 파일만 writeFile합니다.",
      code: prefixSource,
      result: "package.json은 맵에 없습니다. 엔트리는 그 디렉터리 안에 있으므로 다시 읽으면 케이스 표식이 남아 있습니다."
    },
    {
      title: "없는 경로는 그 호출만 거부됩니다",
      text: "파일을 올린 뒤 /workspace/missing.txt를 읽습니다. 그 경로는 쓴 적이 없습니다.",
      code: missingSource,
      result: "missing.txt 읽기는 거부되고 error.message는 그 경로입니다. 엔트리 readFile은 그대로 성공합니다. status는 ready입니다."
    },
    {
      title: "이미 가진 문자열을 파일 하나로 씁니다",
      text: "편집기나 변수에 소스가 이미 있으면 import와 fetch를 건너뜁니다. pageSource가 그 문자열입니다.",
      code: bufferSource,
      result: "writeFile한 경로를 다시 읽으면 pageSource와 같은 본문입니다. 다른 파일은 생기지 않습니다."
    }
  ],
  en: [
    {
      title: "Write one file at a time",
      text: "After the dynamic import, call writeFile once per path. Start from an empty map. This page's map does not create parent directories itself. readdir shows the segment before a slash as a directory.",
      code: writeEachSource,
      result: "written is the path order. readdir(\"/workspace\") returns only the files and directories directly inside it. After boot, status is ready. Packages are not installed and the dev server does not start."
    },
    {
      title: "Fetch one source file from a URL",
      text: "sourceUrl is a file this site publishes, and filePath is the workspace-relative path. The SPA script is examples/spa/src/main.js. The Next page is examples/next/app/page.tsx. A failed fetch throws that URL. Only the response body is written.",
      code: fetchFileSource,
      result: "The map contains that file alone. The text read back matches the URL. The SPA body contains spa-ready, and the Next body contains next-ready. The other project files are not written."
    },
    {
      title: "Replace only the entry file",
      text: "After the tree is written, write a new string at the entry path only. Leave the other paths as they are.",
      code: replaceEntrySource,
      result: "readFile returns only replaced-entry. The earlier spa-ready or next-ready marker is gone from that file."
    },
    {
      title: "Then load the script the HTML points at",
      text: "Read the module script src from the SPA index.html. When that path is one of the case files, write index.html and that script only. scriptSrcFromHtml belongs to this page. The Next layout has no such script tag.",
      code: scriptSource,
      result: "The SPA writes index.html and src/main.js, and the script read back contains spa-ready. package.json is omitted. This step does not run for the Next case."
    },
    {
      title: "Load only one directory",
      text: "prefix is src/ for the SPA and app/ for Next. writeFile runs only for paths that start with that prefix.",
      code: prefixSource,
      result: "package.json is not in the map. The entry lives in that directory, so reading it back still shows the case marker."
    },
    {
      title: "A missing path rejects only that call",
      text: "After the files are written, read /workspace/missing.txt. Nothing wrote that path.",
      code: missingSource,
      result: "The missing.txt read rejects, and error.message is that path. The entry readFile still succeeds. status is ready."
    },
    {
      title: "Write a string the page already has",
      text: "When an editor or a variable already holds the source, skip import and fetch. pageSource is that string.",
      code: bufferSource,
      result: "Reading the written path back returns the same text as pageSource. No other file is created."
    }
  ]
};
