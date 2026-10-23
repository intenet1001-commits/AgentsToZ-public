/** Public service names only. Enabling an API never grants access to a person's data. */
export const GOOGLE_WORKSPACE_APIS = [
  ['Drive','drive.googleapis.com'],['Docs','docs.googleapis.com'],['Sheets','sheets.googleapis.com'],
  ['Slides','slides.googleapis.com'],['Gmail','gmail.googleapis.com'],['Calendar','calendar-json.googleapis.com'],
  ['Forms','forms.googleapis.com'],['Tasks','tasks.googleapis.com'],['People','people.googleapis.com'],['Chat','chat.googleapis.com'],
] as const;
export function googleSetupConsoleUrl(path:string,projectId:string){
  if(projectId&&!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId))return null;
  if(!['/projectselector2/home/dashboard','/auth/branding','/auth/audience','/auth/clients'].includes(path)
    &&!GOOGLE_WORKSPACE_APIS.some(([,id])=>path==='/apis/library/'+id))return null;
  return 'https://console.cloud.google.com'+path+(projectId?'?project='+encodeURIComponent(projectId):'');
}
