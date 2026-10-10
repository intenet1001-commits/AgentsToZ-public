import {useState} from 'react';
import {ProjectTesterPanel} from './ProjectTesterPanel';
import {testerRequest} from './testerAgentClient';

/** Only locally registered projects are supplied by the desktop shell. */
export function MemoryTesterUpgrade({projects,transport=testerRequest}:{
  projects:{id:string;name:string}[];
  transport?:typeof testerRequest;
}) {
  const [selected,setSelected]=useState('');
  const project=projects.find(p=>p.id===selected);
  return <section data-testid="memory-tester-upgrade" className="m-3 rounded-xl border border-[var(--line)] p-3 text-sm">
    <h2 className="font-semibold">테스트 에이전트 관리</h2>
    <p className="my-2">여기서 공통 실행기 업그레이드와 프로젝트별 Python 검사 실행·결과 확인을 함께 할 수 있습니다. 프로젝트별 검사 구성은 Git에서 별도 관리되고, 검증된 공통 개선은 다음 앱 제공 버전으로 배포됩니다.</p>
    <label className="flex flex-wrap items-center gap-2">테스트 에이전트 관리 프로젝트
      <select aria-label="테스트 에이전트 관리 프로젝트" value={project?.id??''} onChange={e=>setSelected(e.target.value)}
        className="min-h-11 max-w-full rounded-lg border border-[var(--line)] bg-[var(--bg-card)] px-2">
        <option value="">프로젝트 선택</option>
        {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
    {!projects.length&&<p className="mt-2">폴더가 연결된 로컬 프로젝트를 먼저 등록하세요.</p>}
    {project&&<ProjectTesterPanel key={project.id} portId={project.id} projectName={project.name} mode="manage" initialOpen transport={transport}/>}
  </section>;
}
