export class PortLaunchOwnership {
  private readonly claimed = new Set<string>();

  tryClaim(portId: string): boolean {
    if (this.claimed.has(portId)) return false;
    this.claimed.add(portId);
    return true;
  }

  release(portId: string): void {
    this.claimed.delete(portId);
  }
}
