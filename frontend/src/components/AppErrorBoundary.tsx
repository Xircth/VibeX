import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Top-level error boundary that catches uncaught React errors and prevents
 * a full white-screen crash. Shows an error message with reload option.
 */
export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[AppErrorBoundary] Uncaught error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen p-8 bg-background text-foreground">
          <div className="max-w-lg w-full space-y-4">
            <h1 className="text-xl font-semibold text-destructive">页面发生错误</h1>
            <p className="text-sm text-muted-foreground">
              应用遇到了未预期的错误。请刷新页面或点击下方按钮重试。
            </p>
            {this.state.error && (
              <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-48 text-left">
                {this.state.error.message}
                {this.state.errorInfo?.componentStack
                  ? '\n\nComponent stack:' + this.state.errorInfo.componentStack
                  : ''}
              </pre>
            )}
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm hover:opacity-90"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
