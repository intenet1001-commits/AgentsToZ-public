import React from 'react';

interface Props { children: React.ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    if (import.meta.env.DEV) console.error('[ErrorBoundary]', error, info);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0b', color: '#ede7dd', fontFamily: 'sans-serif', gap: 12 }}>
          <div style={{ fontSize: 32 }}>⚠️</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>앱에서 오류가 발생했습니다</div>
          <div style={{ fontSize: 12, color: '#6b6459', maxWidth: 400, textAlign: 'center' }}>{this.state.error?.message}</div>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 8, padding: '8px 20px', background: '#e8a557', border: 'none', borderRadius: 6, color: '#0a0a0b', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}
          >앱 다시 시작</button>
        </div>
      );
    }
    return this.props.children;
  }
}
