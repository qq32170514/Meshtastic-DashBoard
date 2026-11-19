import React from 'react';

interface MapErrorBoundaryProps {
  children: React.ReactNode;
  title?: string;
}

interface MapErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class MapErrorBoundary extends React.Component<MapErrorBoundaryProps, MapErrorBoundaryState> {
  constructor(props: MapErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): MapErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || '地圖元件載入或渲染失敗'
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[MapErrorBoundary]', error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full min-h-[160px] p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 flex flex-col items-center justify-center gap-2 text-center">
          <div className="text-xs font-bold">
            {this.props.title || '地圖載入失敗'}
          </div>
          <div className="text-[11px] font-mono opacity-80 max-w-md break-words">
            {this.state.errorMessage}
          </div>
          <button
            type="button"
            onClick={this.handleRetry}
            className="mt-1 px-3 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition"
          >
            重新載入地圖
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default MapErrorBoundary;

