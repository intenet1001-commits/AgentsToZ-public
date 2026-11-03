import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {WorkspaceToolGroup} from '../src/components/WorkspaceToolGroup';
import {WorkspaceTools} from '../src/components/WorkspaceTools';
import {WorkspaceScreenEntries} from '../src/WorkspaceScreenEntries';
import {APP_LANGUAGES,workspaceToolsCopy} from '../src/i18n';

test('actual App action nodes belong to the intended purpose without changing project or data actions',()=>{
  const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
  const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const groups=new Map<string,Set<string>>();let pinned='';
  function visit(node:ts.Node,group=''){
    if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)){
      const element=ts.isJsxElement(node)?node.openingElement:node;
      if(element.tagName.getText(file)==='WorkspaceToolGroup'){
        const title=element.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.getText(file)==='title') as ts.JsxAttribute|undefined;
        if(title?.initializer&&ts.isJsxExpression(title.initializer))group=title.initializer.expression?.getText(file)??'';
        groups.set(group,new Set());
      }
      const id=element.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.getText(file)==='data-testid') as ts.JsxAttribute|undefined;
      if(id?.initializer&&ts.isStringLiteral(id.initializer)){
        if(group)groups.get(group)?.add(id.initializer.text);
        if(id.initializer.text==='primary-project-toolbar'){expect(group).toBe('');pinned=node.getText(file);}
      }
      if(element.tagName.getText(file)==='WorkspaceScreenEntries')groups.get(group)?.add('screen-and-viewer');
    }
    ts.forEachChild(node,child=>visit(child,group));
  }
  visit(file);
  expect([...groups.get('workspaceToolsCopy(lang).devices')??[]]).toEqual(['screen-and-viewer','computer-use-open']);
  expect([...groups.get('workspaceToolsCopy(lang).collaboration')??[]]).toEqual(['remote-teams-permissions-open','agent-dialogue-open','ops-voice-settings-open','voice-dock-reopen-tools']);
  expect(groups.get('workspaceToolsCopy(lang).support')).toEqual(new Set(['desktop-effort-open','control-profile-open','helpdesk-open','control-center-project-shortcut','control-center-remote-candidate']));
  expect(pinned).toContain('setV4SelectedId(primaryProject.id)');
  for(const handler of ['setShowComputerUse(true)','setShowRemoteTeamsPermissions(true)','setShowDesktopEffort(true)','setShowControlProfile(true)','setShowAgentDialogue(true)','setShowHelpdesk(true)',"new Event(OPEN_OPS_VOICE_EVENT)","new Event(OPEN_VOICE_DOCK_EVENT)"]){expect(source).toContain(handler);}
  for(const id of ['top-toolbar-project-actions','ports-supabase-push','ports-supabase-pull','btn-channel-health'])expect(source).toContain(`data-testid="${id}"`);
});

test('purpose headings have seven language labels and no status or permission side effect',()=>{
  for(const language of APP_LANGUAGES){
    const copy=workspaceToolsCopy(language.id);
    expect(Object.values(copy).every(value=>value.length>0)).toBe(true);
  }
  const html=renderToStaticMarkup(<WorkspaceTools label="도구 및 설정"><WorkspaceToolGroup title="기기 연결"><WorkspaceScreenEntries lang="ko"/><button>컴퓨터 유즈</button></WorkspaceToolGroup></WorkspaceTools>);
  expect(html).toContain('aria-labelledby=');expect(html).toContain('기기 연결');
  expect(html).not.toContain('workspace-screen-entry');
  expect(html).not.toContain('workspace-viewer-entry');
});
