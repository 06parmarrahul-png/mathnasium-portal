import { Component } from 'react';

/**
 * Catches render errors anywhere in the tree and shows a friendly screen
 * instead of a blank white page. Errors are logged to the console so the
 * owner can grab them when debugging in production.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Render error:', error, info);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm text-center">
          <p className="text-5xl mb-3">⚠️</p>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
          <p className="text-sm text-gray-500 mb-4">
            The portal hit an unexpected error. Try reloading the page; if it keeps happening,
            send the message below to the center owner.
          </p>
          {this.state.error?.message && (
            <pre className="mb-4 rounded-lg bg-gray-100 p-3 text-left text-xs text-gray-700 overflow-x-auto">
              {String(this.state.error.message)}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
