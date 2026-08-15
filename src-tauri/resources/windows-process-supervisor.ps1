$ErrorActionPreference = 'Stop'
$childProgram = $env:AGENTSTOZ_SUPERVISOR_PROGRAM
$childArgsJson = $env:AGENTSTOZ_SUPERVISOR_ARGS_JSON
$childWorkingDirectory = $env:AGENTSTOZ_SUPERVISOR_CWD
if ([string]::IsNullOrWhiteSpace($childProgram) -or [string]::IsNullOrWhiteSpace($childArgsJson)) { throw 'Supervisor child metadata is missing.' }
if (($childProgram -ieq 'cmd' -or $childProgram -ieq 'cmd.exe') -and (Test-Path $env:ComSpec -PathType Leaf)) { $childProgram = $env:ComSpec }
if (($childProgram -ieq 'powershell' -or $childProgram -ieq 'powershell.exe')) {
  $windowsPowerShell = Join-Path $PSHOME 'powershell.exe'
  if (Test-Path $windowsPowerShell -PathType Leaf) { $childProgram = $windowsPowerShell }
}
$decodedChildArgs = ConvertFrom-Json -InputObject $childArgsJson
$childArgs = @()
foreach ($childArg in $decodedChildArgs) { $childArgs += [string]$childArg }
foreach ($name in @('AGENTSTOZ_SUPERVISOR_PROGRAM','AGENTSTOZ_SUPERVISOR_ARGS_JSON','AGENTSTOZ_SUPERVISOR_CWD')) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }

$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class AgentsToZWindowsJobSupervisor {
 const uint CREATE_SUSPENDED=4, CREATE_NO_WINDOW=0x08000000, STARTF_USESTDHANDLES=0x100, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000;
 const int BASIC_ACCOUNTING=1, EXTENDED_LIMIT=9;
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string r,d,t; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,cb2; public IntPtr r2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ro,wo,oo,rt,wt,ot; }
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT_INFO { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMem,jobMem,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING_INFO { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr i,uint n,IntPtr r);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder line,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr p,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int n);
 static void Fail(string op){throw new Win32Exception(Marshal.GetLastWin32Error(),op);}
 static string Q(string v){
  if(v.Length==0)return "\"\""; if(v.IndexOfAny(new[]{' ','\t','\n','\v','"'})<0)return v;
  var b=new StringBuilder().Append('"'); int s=0;
  foreach(char c in v){if(c=='\\')s++;else if(c=='"'){b.Append('\\',s*2+1).Append('"');s=0;}else{b.Append('\\',s).Append(c);s=0;}}
  return b.Append('\\',s*2).Append('"').ToString();
 }
 static StringBuilder Line(string p,string[] a){var b=new StringBuilder(Q(p));foreach(var x in a){b.Append(' ').Append(Q(x??""));}return b;}
 static IntPtr Job(){
  var j=CreateJobObject(IntPtr.Zero,null);if(j==IntPtr.Zero)Fail("CreateJobObject");
  var info=new EXTENDED_LIMIT_INFO();info.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;int n=Marshal.SizeOf(typeof(EXTENDED_LIMIT_INFO));var p=Marshal.AllocHGlobal(n);
  try{Marshal.StructureToPtr(info,p,false);if(!SetInformationJobObject(j,EXTENDED_LIMIT,p,(uint)n)){int e=Marshal.GetLastWin32Error();CloseHandle(j);throw new Win32Exception(e,"SetInformationJobObject");}}finally{Marshal.FreeHGlobal(p);}return j;
 }
 static uint Active(IntPtr j){int n=Marshal.SizeOf(typeof(BASIC_ACCOUNTING_INFO));var p=Marshal.AllocHGlobal(n);try{if(!QueryInformationJobObject(j,BASIC_ACCOUNTING,p,(uint)n,IntPtr.Zero))Fail("QueryInformationJobObject");return ((BASIC_ACCOUNTING_INFO)Marshal.PtrToStructure(p,typeof(BASIC_ACCOUNTING_INFO))).active;}finally{Marshal.FreeHGlobal(p);}}
 public static int Run(string program,string[] args,string cwd){
  IntPtr job=Job();var pi=new PROCESS_INFORMATION();
  try{var si=new STARTUPINFO();si.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO));si.flags=STARTF_USESTDHANDLES;si.input=GetStdHandle(-10);si.output=GetStdHandle(-11);si.error=GetStdHandle(-12);
   if(!CreateProcessW(program,Line(program,args??new string[0]),IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,String.IsNullOrWhiteSpace(cwd)?null:cwd,ref si,out pi))Fail("CreateProcessW");
   if(!AssignProcessToJobObject(job,pi.process)){int e=Marshal.GetLastWin32Error();TerminateProcess(pi.process,1);throw new Win32Exception(e,"AssignProcessToJobObject");}
   if(ResumeThread(pi.thread)==0xffffffff)Fail("ResumeThread");CloseHandle(pi.thread);pi.thread=IntPtr.Zero;CloseHandle(pi.process);pi.process=IntPtr.Zero;
   while(Active(job)>0)Thread.Sleep(50);return 0;
  }finally{if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);if(job!=IntPtr.Zero)CloseHandle(job);}
 }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
exit [AgentsToZWindowsJobSupervisor]::Run($childProgram,[string[]]$childArgs,$childWorkingDirectory)
