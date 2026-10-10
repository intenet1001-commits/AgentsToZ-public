import type { RemoteControlProjectAction } from './remoteControlProcessGateway';

export type RemoteControlOrcaAgent = 'claude' | 'codex' | 'agy' | 'hermes';
export type RemoteControlDesktopAgent = 'codex' | 'hermes';

export type RemoteControlExternalLaunchRoute =
  | {
      surface: 'orca-agent';
      endpoint: '/api/open-orca-agent';
      agent: RemoteControlOrcaAgent;
    }
  | {
      surface: 'desktop-app';
      endpoint: '/api/open-code-app';
      agent: RemoteControlDesktopAgent;
    };

/**
 * One semantic routing table shared by LAN and Internet remote execution.
 * The explicit matrix prevents an app-labelled action from falling through
 * to Orca (or an Orca-labelled action from reaching a desktop deep link).
 */
export function remoteControlExternalLaunchRoute(
  action: RemoteControlProjectAction,
): RemoteControlExternalLaunchRoute | null {
  switch (action) {
    case 'agent.claude': return { surface: 'orca-agent', endpoint: '/api/open-orca-agent', agent: 'claude' };
    case 'agent.codex': return { surface: 'orca-agent', endpoint: '/api/open-orca-agent', agent: 'codex' };
    case 'agent.agy': return { surface: 'orca-agent', endpoint: '/api/open-orca-agent', agent: 'agy' };
    case 'agent.hermes': return { surface: 'orca-agent', endpoint: '/api/open-orca-agent', agent: 'hermes' };
    // Legacy paired clients can still send app.claude. Claude Code has no
    // verified desktop-app route, so retain its historical safe Orca target.
    case 'app.claude': return { surface: 'orca-agent', endpoint: '/api/open-orca-agent', agent: 'claude' };
    case 'app.codex': return { surface: 'desktop-app', endpoint: '/api/open-code-app', agent: 'codex' };
    case 'app.hermes': return { surface: 'desktop-app', endpoint: '/api/open-code-app', agent: 'hermes' };
    default: return null;
  }
}
