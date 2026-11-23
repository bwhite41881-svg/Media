import React from 'react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || 'An unexpected rendering error occurred.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Big B’z Leaks UI ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#F3F6F4] dark:bg-[#060807] px-6 py-16">
          <div className="max-w-lg w-full bg-white dark:bg-[#0C110E] border border-[#D4DFD7] dark:border-[#1C2A21] rounded-2xl overflow-hidden">
            <div className="h-[3px] w-full rasta-stripe" aria-hidden="true" />
            <div className="p-8">
              <h1 className="font-display text-2xl font-semibold tracking-tight text-[#0C120E] dark:text-[#EEF4F0]">
                Something interrupted this view
              </h1>
              <p className="mt-3 text-sm leading-relaxed text-[#526056] dark:text-[#8FA395] break-words">
                {this.state.message}
              </p>
              <button
                type="button"
                onClick={() => {
                  this.setState({ hasError: false, message: '' });
                  window.location.href = '/';
                }}
                style={{ backgroundColor: 'var(--accent)' }}
                className="mt-6 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-opacity"
              >
                Return to Big B’z Leaks
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
