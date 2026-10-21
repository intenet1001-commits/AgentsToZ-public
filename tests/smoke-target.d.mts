export interface SmokeTargetClassification {
  isLocalFullApp: boolean;
  isPortalOnly: boolean;
}

export function classifySmokeTarget(target: string): SmokeTargetClassification;
