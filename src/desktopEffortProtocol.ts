import type {DesktopEffortBinding,DesktopSessionEffortMode} from './desktopSessionEffort';
export const DESKTOP_EFFORT_PATH='/api/agent-runtime/desktop-effort';
export interface DesktopEffortStatus {
  success:true;
  adapters:{id:string;label:string;available:boolean;reason:string}[];
  sessions:{id:string;label:string;binding:DesktopEffortBinding;mode:DesktopSessionEffortMode;expiresAt:number;revision:number;fixed?:string;minimum?:string;preserved?:string}[];
}
export type DesktopEffortManagementRequest={operation:'status'}|{operation:'disconnect';id:string}|
  {operation:'configure';id:string;expectedRevision:number;mode:DesktopSessionEffortMode;consent?:true;allowLowering?:boolean;fixed?:string;minimum?:string};
