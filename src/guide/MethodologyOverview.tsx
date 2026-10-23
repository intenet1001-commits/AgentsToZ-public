import { ArrowDown, ArrowRight, BookOpen, FolderKanban, MessagesSquare, Monitor, Smartphone, UserRound } from 'lucide-react';

const callEntryImage = new URL('../../docs/images/agentstoz-call-entry-mac.png', import.meta.url).href;

const stages = [
  { title: '아젠투지가 일하는 방식', label: '운영 기억 · AgentsToZ OPS', icon: UserRound, text: '프로젝트 별칭, 공통 결정과 운영 맥락을 기억합니다. 프로젝트의 세부 작업 기억과는 따로 관리합니다.' },
  { title: '업무를 맡기는 스레드', label: '지시 · 질문 · 결과', icon: MessagesSquare, text: '일할 기기와 @프로젝트를 고르고 요청합니다. 여러 프로젝트의 질문과 결과를 한 업무에서 확인합니다.' },
  { title: '실제로 일하는 워크룸', label: '프로젝트별 AI 실행', icon: Monitor, text: '선택한 프로젝트 폴더에서 AI가 파일을 다루고 명령·검사를 실행합니다. 승인이나 질문이 필요하면 여기서 확인합니다.' },
  { title: '다음 업무에 쓰는 프로젝트 기억', label: '검증한 경험의 축적', icon: BookOpen, text: '설계 이유, 수정 방법과 검증 결과를 해당 프로젝트에 저장합니다. 다음 담당 AI가 이 기억을 읽고 일을 이어갑니다.' },
] as const;

export function MethodologyOverview({ repositoryUrl }: { repositoryUrl: string }) {
  return (
    <section id="methodology" className="scroll-mt-24 border-b border-zinc-800 px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <p className="text-xs font-semibold tracking-widest text-teal-300">먼저 이해하기</p>
        <h2 className="mt-3 text-2xl font-bold tracking-tight text-[var(--text-primary)] sm:text-4xl">지시는 한곳에서, 실행과 경험은 프로젝트에.</h2>
        <p className="mt-5 max-w-3xl text-base leading-8 text-zinc-400">AgentsToZ는 여러 AI와 프로젝트를 함께 운영하는 작업 공간입니다. 업무 스레드는 일을 맡기고 결과를 모으는 곳, 프로젝트 워크룸은 실제로 일하는 곳, 프로젝트 메모리는 검증한 경험을 다시 쓰는 곳입니다.</p>
        <nav aria-label="사용 방식 살펴보기" className="mt-6 flex flex-wrap gap-3 text-sm text-teal-200">
          <a className="flex min-h-11 items-center rounded-lg border border-zinc-700 px-3" href="#memory-map">어떤 기억에 남나요?</a>
          <a className="flex min-h-11 items-center rounded-lg border border-zinc-700 px-3" href="#community-remote">커뮤니티와 원격 작업</a>
          <a className="flex min-h-11 items-center rounded-lg border border-zinc-700 px-3" href="#first-task">첫 업무 따라 하기</a>
        </nav>

        <ol className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="업무와 기억의 흐름">
          {stages.map(({ title, label, icon: Icon, text }, index) => (
            <li key={title} className="relative rounded-2xl border border-teal-300/20 bg-teal-400/[0.035] p-5">
              <div className="flex items-center justify-between text-teal-300"><Icon aria-hidden="true" className="h-6 w-6" /><span className="text-sm font-semibold">0{index + 1}</span></div>
              <p className="mt-5 text-xs text-teal-200">{label}</p>
              <h3 className="mt-2 text-lg font-semibold text-zinc-100">{title}</h3>
              <p className="mt-3 text-sm leading-7 text-zinc-400">{text}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm leading-7 text-zinc-400">이 흐름은 이해를 위한 지도입니다. 모든 일을 OPS에 먼저 거칠 필요는 없습니다. 프로젝트 워크룸에 직접 지시해도 됩니다. <strong className="text-zinc-200">작업 완료와 기억 저장은 별도입니다.</strong> 기억은 직접 저장하거나, 별도로 동의해 켠 자동 저장으로 쌓습니다.</p>

        <div id="first-task" className="mt-12 scroll-mt-24 rounded-3xl border border-zinc-700 bg-[var(--bg-card)] p-5 sm:p-8">
          <p className="text-xs font-semibold text-teal-300">예시 · 홈페이지의 가입 오류 고치기</p>
          <h3 className="mt-2 text-xl font-bold text-zinc-100">“가입 버튼을 고치고, 같은 문제가 안 생기게 검사해 줘.”</h3>
          <ol className="mt-6 grid gap-5 text-sm leading-7 text-zinc-300 sm:grid-cols-2">
            <li><strong className="text-teal-200">1. 대상을 고릅니다.</strong><br />대화 세션 → 커뮤니티 · 업무 스레드에서 실행 기기 채널과 <code>@홈페이지</code>를 선택하고 업무를 맡깁니다. 프로젝트 폴더 등록과 사용할 AI의 로그인을 먼저 마칩니다.</li>
            <li><strong className="text-teal-200">2. 실제 작업을 확인합니다.</strong><br />연결된 홈페이지 워크룸에서 AI가 원인을 찾고 파일 수정·검사를 수행합니다. 필요한 승인과 추가 질문에 답합니다.</li>
            <li><strong className="text-teal-200">3. 결과와 검증을 봅니다.</strong><br />스레드의 프로젝트별 답변과 연결 워크룸을 확인합니다. “요청 접수”나 “창 열림”만으로 업무가 끝난 것은 아닙니다.</li>
            <li><strong className="text-teal-200">4. 다시 쓸 경험을 남깁니다.</strong><br />원인·수정 이유·검사 결과를 프로젝트 기억에 저장합니다. 다음 업무에서 담당 AI가 이를 회상해 같은 실수를 줄입니다.</li>
          </ol>
          <p className="mt-5 border-t border-zinc-800 pt-4 text-sm leading-7 text-zinc-400">다음에는 “지난번 가입 오류 때의 방식을 참고해 줘”처럼 요청할 수 있습니다. 대화 기록은 당시 내용을 다시 여는 자료이고, 프로젝트 기억은 다음 작업에 필요한 결론을 압축한 자료입니다.</p>
        </div>

        <figure className="mt-8 rounded-2xl border border-zinc-800 p-5">
          <h3 className="text-xl font-semibold">아젠투지를 부르는 곳</h3>
          <p className="mt-3 text-sm leading-7 text-zinc-400">Mac의 도구 및 설정 → 아젠투지 호출 열기로 독립 창을 엽니다. 텍스트로만 시작하거나 음성 설정을 확인할 수 있습니다. 창을 여는 것과 요청 전송은 별도입니다.</p>
          <img src={callEntryImage} alt="실제 Mac v1157의 아젠투지 호출 열기 메뉴" className="mt-5 h-auto max-w-full rounded-lg" loading="lazy" />
          <figcaption className="mt-3 text-xs leading-6 text-zinc-500">Mac v1157 설치본의 실제 호출 진입 메뉴입니다. 개인 프로젝트나 로그인 정보가 보이지 않는 영역만 캡처했습니다.</figcaption>
        </figure>

        <div id="memory-map" className="mt-14 scroll-mt-24">
          <h3 className="text-2xl font-bold text-zinc-100">사용자 맥락과 실무 경험을 각각 제자리에</h3>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-400">‘실무처리자 메모리’는 특정 AI 개인의 머릿속이 아니라 프로젝트에 남는 기억입니다. 담당 AI나 기기를 바꾸더라도 같은 기억을 연결하고 읽어야 이어집니다.</p>
          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <article className="rounded-2xl border border-zinc-800 bg-[var(--bg-card)] p-5"><UserRound aria-hidden="true" className="h-5 w-5 text-teal-300" /><h4 className="mt-3 font-semibold">운영 기억 · AgentsToZ OPS</h4><p className="mt-2 text-sm leading-7 text-zinc-400">아젠투지가 일하는 방식을 담는 운영 프로필입니다. 프로젝트 별칭·관계·공통 운영 결정을 담습니다. 공유 운영 폴더의 저장 후보는 사용자가 검토합니다.</p></article>
            <article className="rounded-2xl border border-zinc-800 bg-[var(--bg-card)] p-5"><FolderKanban aria-hidden="true" className="h-5 w-5 text-sky-300" /><h4 className="mt-3 font-semibold">프로젝트 기억 · 담당자의 인수인계</h4><p className="mt-2 text-sm leading-7 text-zinc-400">그 프로젝트의 설계, 코드 변경, 검증과 반복 문제를 담습니다. 다른 프로젝트의 기억과 섞지 않고, 로컬 파일을 정본으로 관리합니다.</p></article>
            <article className="rounded-2xl border border-zinc-800 bg-[var(--bg-card)] p-5"><BookOpen aria-hidden="true" className="h-5 w-5 text-violet-300" /><h4 className="mt-3 font-semibold">공통 기억 · 선택해서 함께 쓰기</h4><p className="mt-2 text-sm leading-7 text-zinc-400">여러 프로젝트가 참고할 공통 지식을 독립된 그룹으로 관리하고 필요한 프로젝트에 연결합니다. 모든 기억을 한데 합치는 기능은 아닙니다.</p></article>
          </div>
          <details className="mt-4 rounded-2xl border border-zinc-800 p-5 text-sm leading-7 text-zinc-400"><summary className="cursor-pointer font-semibold text-zinc-200">처음 시작할 때와 검토 중인 확장</summary><p className="mt-3">Mac 앱의 아젠투지 헬프데스크에서 필요한 프로그램 일괄 준비 → Codex 또는 Claude 공식 인증 → 설치 마무리·사용 질문을 이어갑니다. 기본 안내는 인증 전에도 볼 수 있습니다. 실제 업무와 기억 저장은 프로젝트 워크룸에서 확인하세요. OPS를 거치지 않은 직접 지시까지 묶는 CEO 업무 색인은 설계 검토 단계입니다. 「내가 한 말」에서는 지시와 같은 장기기억의 세션 기록을 시각으로 연결해 볼 수 있습니다. 연결은 지시별 완료 확인과 다릅니다.</p></details>
        </div>

        <div id="community-remote" className="mt-14 scroll-mt-24 grid gap-6 lg:grid-cols-2">
          <article className="rounded-3xl border border-teal-300/20 bg-teal-400/[0.035] p-5 sm:p-8">
            <MessagesSquare aria-hidden="true" className="h-7 w-7 text-teal-300" />
            <h3 className="mt-4 text-2xl font-bold">내 기기들이 모이는 작은 업무 커뮤니티</h3>
            <p className="mt-4 text-sm leading-7 text-zinc-400">집의 Mac과 사무실의 Mac을 승인해 연결하면 기기별 채널에서 프로젝트를 골라 일을 맡길 수 있습니다. 공개 SNS가 아니라, 같은 운영 프로필에 참여한 기기들의 업무 공간입니다.</p>
            <div className="mt-5 rounded-xl border border-zinc-700 bg-zinc-950/50 p-4 text-sm leading-7 text-zinc-300"><p><span className="text-teal-300">#사무실Mac</span> <ArrowRight aria-hidden="true" className="mx-1 inline h-4 w-4" /> 실행할 기기</p><p><span className="text-sky-300">@홈페이지</span> <ArrowRight aria-hidden="true" className="mx-1 inline h-4 w-4" /> 실제 일할 프로젝트</p><p className="mt-2">한 업무에 여러 프로젝트를 선택하면 각자의 워크룸에서 처리하고 질문·결과를 같은 스레드로 모읍니다.</p></div>
            <p className="mt-4 text-sm leading-7 text-zinc-400">일반 단톡방 대화는 AI에게 자동 전달되지 않습니다. 업무 대상을 선택해 명시적으로 맡겨야 실행됩니다. 기기·프로젝트별 허용 범위도 그대로 적용됩니다.</p>
          </article>
          <article className="rounded-3xl border border-zinc-800 bg-[var(--bg-card)] p-5 sm:p-8">
            <Smartphone aria-hidden="true" className="h-7 w-7 text-sky-300" />
            <h3 className="mt-4 text-2xl font-bold">손에는 휴대폰, 실제 작업은 연결한 Mac에서</h3>
            <p className="mt-4 text-sm leading-7 text-zinc-400">iPhone에서 업무를 보내고 질문에 답하거나 허용된 대화를 이어갑니다. 파일·프로그램·AI 실행은 연결된 Mac에 남으므로 Mac과 앱이 켜져 있어야 합니다.</p>
            <ol className="mt-5 space-y-3 text-sm leading-7 text-zinc-300"><li>Mac 원격제어에서 연결 방식을 선택합니다.</li><li><ArrowDown aria-hidden="true" className="mb-2 h-4 w-4 text-sky-300" />iPhone 앱의 QR 연결과 로그인을 진행합니다.</li><li><ArrowDown aria-hidden="true" className="mb-2 h-4 w-4 text-sky-300" />Mac에서 기기와 허용할 프로젝트·기능을 확인합니다.</li></ol>
            <p className="mt-4 text-sm leading-7 text-zinc-400">같은 개인 Wi-Fi의 LAN 연결과 외부 인터넷 연결은 준비 과정이 다릅니다. 브라우저용 개인 포털은 선택 기능이며, 이 공개 설명서 자체는 원격제어 화면이 아닙니다. 셀룰러 없이도 Wi-Fi로 사용할 수 있습니다.</p>
          </article>
        </div>
        <a href={`${repositoryUrl}/blob/main/docs/user-guide/METHODOLOGY.md`} target="_blank" rel="noopener noreferrer" className="mt-6 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-teal-200">예시와 기억 구분을 문서로 읽기 <ArrowRight aria-hidden="true" className="h-4 w-4" /></a>
      </div>
    </section>
  );
}
