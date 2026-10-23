import {expect,test} from 'bun:test';
import {GOOGLE_WORKSPACE_APIS,googleSetupConsoleUrl} from '../src/googleWorkspaceSetupSteps';
test('ten service links retain the chosen Cloud project without granting OAuth data access',()=>{
  expect(GOOGLE_WORKSPACE_APIS.map(([name])=>name)).toEqual(['Drive','Docs','Sheets','Slides','Gmail','Calendar','Forms','Tasks','People','Chat']);
  for(const [,service] of GOOGLE_WORKSPACE_APIS){const url=new URL(googleSetupConsoleUrl('/apis/library/'+service,'existing-project')!);expect(url.origin).toBe('https://console.cloud.google.com');expect(url.pathname).toBe('/apis/library/'+service);expect(url.searchParams.get('project')).toBe('existing-project');expect([...url.searchParams.keys()]).toEqual(['project']);}
  for(const project of ['https://attacker.test','fixture?token=private','a&project=other','has space'])expect(googleSetupConsoleUrl('/auth/clients',project)).toBeNull();
  for(const path of ['https://attacker.test','/apis/library/unknown.googleapis.com','/iam-admin/serviceaccounts'])expect(googleSetupConsoleUrl(path,'existing-project')).toBeNull();
  expect(googleSetupConsoleUrl('/auth/clients','')).toBe('https://console.cloud.google.com/auth/clients');
});
